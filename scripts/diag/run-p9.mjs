#!/usr/bin/env node
// 短回合 P9 驱动：每个子进程最多测一项，完成后 checkpoint，再考虑下一项。
import { spawn } from 'node:child_process'
import { readFile, readdir, mkdir, appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RESULT_DIR, STATE_DIR, sourceFingerprint, acquireLock, atomicJson, readJson, loadResult, checkpointResults,
} from './p9-checkpoint.mjs'

const root = resolve(process.env.P9_PROJECT_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)))
const opts = { status: false, localOnly: false, retry: false, bytes: 2097152, maxJobs: 1, timeout: 300, files: [] }
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--status') opts.status = true
  else if (a === '--local-only') opts.localOnly = true
  else if (a === '--retry-failed') opts.retry = true
  else if (a === '--bytes') opts.bytes = Number(args[++i])
  else if (a === '--max-jobs') opts.maxJobs = Number(args[++i])
  else if (a === '--timeout') opts.timeout = Number(args[++i])
  else if (a === '--help') {
    console.log(`用法：node scripts/diag/run-p9.mjs [选项] [语料文件名...]
  --status          只读检查，不编码、不提交、不推送
  --bytes N         前 N 字节；0 为全文件（默认 2097152）
  --max-jobs N      本次最多新测 N 项（默认 1，每项独立子进程）
  --timeout SEC     单项墙钟上限（默认 300 秒）；超时杀整个进程组
  --retry-failed    显式重试失败/超时项；默认不自动重试
  --local-only      不提交/推送，只保存本地（测试用途）
环境：P9_LABEL、P9_SET、P9_CORPUS、P9_OFFSET（整数或 mid）。
默认将每项结果提交并推送到当前固定分支，源码必须先提交、暂存区必须干净。
默认语料：项目 .diag-data/corpus；结果：${RESULT_DIR}。
同一命令再次执行，跳过已校验且身份匹配的结果；改标签不会重测。`)
    process.exit(0)
  } else if (a.startsWith('-')) throw new Error(`未知选项：${a}`)
  else opts.files.push(a)
}
if (!Number.isSafeInteger(opts.bytes) || opts.bytes < 0 || !Number.isSafeInteger(opts.maxJobs)
  || opts.maxJobs < 1 || !Number.isFinite(opts.timeout) || opts.timeout <= 0) throw new Error('无效的 bytes/max-jobs/timeout')

if (!opts.status) await mkdir(join(root, STATE_DIR), { recursive: true })
const logPath = join(root, STATE_DIR, `p9-${Date.now()}-${process.pid}.log`)
// 写日志串行化，避免关闭时丢失最后几行；日志是诊断副本，不是完成凭证。
let logQueue = Promise.resolve()
function log(line) {
  process.stderr.write(`${line}\n`)
  if (!opts.status) logQueue = logQueue.then(() => appendFile(logPath, `${line}\n`))
}
const release = opts.status ? async () => {} : await acquireLock(join(root, STATE_DIR, 'p9-driver.lock'))
let activeChild = null, interrupted = false
function killGroup(signal) {
  if (!activeChild) return
  try { process.kill(-activeChild.pid, signal) }
  catch (e) { if (e.code !== 'ESRCH') throw e }
}
const onSignal = () => { interrupted = true; killGroup('SIGTERM') }
process.on('SIGINT', onSignal)
process.on('SIGTERM', onSignal)

async function childOnce(source) {
  let job = null, done = null, timedOut = false, stderrTail = '', stdoutBuffer = ''
  const child = spawn(process.execPath, [join(root, 'scripts/diag/run.mjs'), 'probe-p9-ab', String(opts.bytes), ...opts.files], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, P9_PROJECT_ROOT: root, P9_SOURCE_SHA: source.sha256,
      P9_MODE: opts.status ? 'status' : 'run', P9_MAX_JOBS: '1', P9_RETRY_FAILED: opts.retry ? '1' : '0' },
  })
  activeChild = child
  const started = Date.now()
  const heartbeat = opts.status ? null : setInterval(() => {
    log(`[P9] ${job ? `${job.file} ${job.key.slice(0, 12)}` : '准备输入'}：${Math.round((Date.now() - started) / 1000)}s；尚未完成`)
  }, 15000)
  let hardKill
  const timeout = setTimeout(() => {
    timedOut = true
    log(`[P9] 达到 ${opts.timeout}s 上限，终止本项；不会伪装成成功`)
    killGroup('SIGTERM')
    hardKill = setTimeout(() => killGroup('SIGKILL'), 2000)
  }, opts.timeout * 1000)
  child.stdout.on('data', bytes => {
    process.stdout.write(bytes)
    stdoutBuffer += bytes.toString()
    const lines = stdoutBuffer.split('\n'); stdoutBuffer = lines.pop()
    for (const line of lines) {
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event.kind === 'start') job = event
      if (event.kind === 'done') done = event
    }
  })
  child.stderr.on('data', bytes => {
    stderrTail = (stderrTail + bytes.toString()).slice(-4096)
    log(bytes.toString().trimEnd())
  })
  let code
  try {
    code = await new Promise((ok, fail) => {
      child.once('error', fail)
      child.once('close', (exitCode, signal) => ok(signal ? 1 : exitCode ?? 1))
    })
  } finally {
    clearTimeout(timeout); clearTimeout(hardKill); clearInterval(heartbeat)
    activeChild = null
  }
  code = interrupted ? 130 : timedOut ? 124 : code
  if (!opts.status && code !== 0 && job) {
    const saved = await readJson(job.resultPath)
    // 进程可能死在“完整结果已写 / done 尚未打印”之间，不能抹掉完成凭证。
    if (!saved || !await loadResult(job.resultPath, saved.identity)) {
      const state = await readJson(job.statePath)
      await atomicJson(job.statePath, { ...state, status: interrupted ? 'interrupted' : timedOut ? 'timed-out' : 'failed',
        error: stderrTail || `子进程退出 ${code}`, exitCode: code, updatedAt: new Date().toISOString() })
    }
  }
  return { code, done }
}

try {
  const source = await sourceFingerprint(root)
  if (opts.status) {
    // 输入缓存即使被回收，也能看见已保存的证据。没有输入时不声称 inputMatches=true。
    const files = await readdir(join(root, RESULT_DIR)).catch(e => { if (e.code === 'ENOENT') return []; throw e })
    for (const file of files.filter(f => /^[a-f0-9]{64}\.json$/.test(f)).sort()) {
      const path = join(root, RESULT_DIR, file)
      const raw = JSON.parse(await readFile(path, 'utf8'))
      const rec = await loadResult(path, raw.identity)
      console.log(JSON.stringify({ kind: 'saved', file: rec.file, label: rec.label, key: rec.key, ucz: rec.ucz,
        verified: true, sourceMatches: rec.identity.sourceSha256 === source.sha256, inputRechecked: false }))
    }
  } else if (!opts.localOnly) {
    log(`[P9] 启动前同步已有检查点：${checkpointResults(root, 'P9: recover pending measurement checkpoints')}`)
  }
  let measured = 0
  for (let i = 0; i < (opts.status ? 1 : opts.maxJobs); i++) {
    if (interrupted) { process.exitCode = 130; break }
    const result = await childOnce(source)
    measured += result.done?.measured ?? 0
    if (!opts.status && !opts.localOnly) {
      // 成功、失败、超时的状态均保存。推送失败会抛出并停止，下一次先同步再开工。
      log(`[P9] 检查点已推送：${checkpointResults(root, 'P9: persist one measurement checkpoint')}`)
    }
    if (result.code !== 0) { process.exitCode = result.code; break }
    if (opts.status || !result.done?.measured || interrupted) break
  }
  if (!opts.status) log(`[P9] 本次新完成 ${measured} 项；重复同一命令续跑。日志：${logPath}`)
} catch (e) {
  log(`[P9] 停止：${e.message}`)
  process.exitCode = 1
} finally {
  process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal)
  await logQueue
  await release()
}
