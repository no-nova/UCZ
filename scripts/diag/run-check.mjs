// 一项门禁的持久收据；不是长批次。日志/退出码每项单独保存并推送。
// node scripts/diag/run-check.mjs <name> -- <command> [args...]
import { spawn } from 'node:child_process'
import { mkdir, readFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sourceFingerprint, atomicJson, acquireLock, checkpointResults, gitHead, sha256 } from './p9-checkpoint.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const [name, marker, command, ...args] = process.argv.slice(2)
if (!/^[a-z0-9-]+$/.test(name ?? '') || marker !== '--' || !command) throw new Error('用法：run-check.mjs name -- command args...')
const timeoutMs = Number(process.env.P9_CHECK_TIMEOUT ?? 600) * 1000
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('无效超时')
const release = await acquireLock(join(root, '.diag-state/p9-driver.lock'))
const phase = /(^|-)p11($|-)/.test(name) ? 'P11' : /(^|-)p10($|-)/.test(name) ? 'P10' : 'P9'
const resultDir = `scripts/diag/${phase.toLowerCase()}-results`
const folder = join(root, resultDir, 'checks/gates')
await mkdir(folder, { recursive: true })
const source = await sourceFingerprint(root), startedAt = new Date().toISOString()
const receipt = { kind: 'gate', name, command: [command, ...args], source, commit: gitHead(root), startedAt }
const logPath = join(folder, `${name}.log`), resultPath = join(folder, `${name}.json`)
const log = await open(logPath, 'w')
let timedOut = false, signaled = false, child, forceKill
let writes = Promise.resolve()
const kill = signal => { if (child?.pid) try { process.kill(-child.pid, signal) } catch (e) { if (e.code !== 'ESRCH') throw e } }
const interrupt = () => { signaled = true; kill('SIGTERM'); forceKill = setTimeout(() => kill('SIGKILL'), 2000) }
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
let timer, heartbeat
try {
  await atomicJson(resultPath, { ...receipt, status: 'running', passed: false })
  checkpointResults(root, `${phase} gate: start ${name}`, resultDir)
  const start = Date.now()
  child = spawn(command, args, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = bytes => { process.stdout.write(bytes); writes = writes.then(() => log.write(bytes)) }
  child.stdout.on('data', output); child.stderr.on('data', output)
  heartbeat = setInterval(() => console.log(`[${name}] ${Math.round((Date.now() - start) / 1000)}s，仍在运行`), 15000)
  timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); forceKill = setTimeout(() => kill('SIGKILL'), 2000) }, timeoutMs)
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)) })
  clearTimeout(timer); clearInterval(heartbeat); clearTimeout(forceKill)
  await writes; await log.sync()
  const sourceUnchanged = (await sourceFingerprint(root)).sha256 === source.sha256
  const exitCode = timedOut ? 124 : signaled ? 130 : exit
  const passed = exitCode === 0 && sourceUnchanged
  await atomicJson(resultPath, { ...receipt, status: 'complete', passed, exitCode, timedOut, sourceUnchanged,
    finishedAt: new Date().toISOString(), wallMs: Date.now() - start, logSha256: sha256(await readFile(logPath)) })
  const commit = checkpointResults(root, `${phase} gate: ${name} ${passed ? 'PASS' : 'FAIL'}`, resultDir)
  console.log(`[${name}] ${passed ? 'PASS' : 'FAIL'}，已保存并推送 ${commit}`)
  if (!passed) process.exitCode = exitCode || 1
} catch (e) {
  console.error(`[${name}] ${e.message}`)
  process.exitCode = 1
} finally {
  clearTimeout(timer); clearInterval(heartbeat); clearTimeout(forceKill)
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
  await writes; await log.close(); await release()
}
