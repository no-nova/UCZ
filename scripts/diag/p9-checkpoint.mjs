// P9 的小型、可审查持久记录。压缩字节不在这里实现。
import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, readdir, mkdir, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { hostname, cpus } from 'node:os'
import { execFileSync } from 'node:child_process'

export const SCHEMA = 1
export const RESULT_DIR = 'scripts/diag/p9-results'
export const STATE_DIR = '.diag-state'
export const BRANCH = 'arena/1220f47e-test'
export const SOURCE_PATHS = [
  'src/lib', 'package.json', 'package-lock.json', 'tsconfig.json',
  'scripts/diag/run.mjs', 'scripts/diag/run-p9.mjs',
  'scripts/diag/probe-p9-ab.ts', 'scripts/diag/p9-checkpoint.mjs', 'scripts/diag/baseline.json',
  'scripts/diag/bench-one.ts', 'scripts/diag/check-baseline.mjs', 'scripts/diag/probe-p10-smoke.ts', 'scripts/diag/probe-p11-smoke.ts', 'scripts/diag/probe-p111-smoke.ts', 'scripts/diag/freeze-p111-references.mjs', 'scripts/diag/run-check.mjs', 'scripts/build-worker-code.mjs',
]

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
export const sha256 = value => createHash('sha256').update(value).digest('hex')
export const jobKey = identity => sha256(canonical(identity))

// 不用 HEAD 当缓存键：只提交结果/报告不应让所有样本重新编码。
export async function sourceFingerprint(root) {
  const files = {}
  async function walk(rel) {
    const path = join(root, rel)
    const entries = await readdir(path, { withFileTypes: true }).catch(e => {
      if (e.code === 'ENOTDIR') return null
      throw e
    })
    if (entries === null) { files[rel] = sha256(await readFile(path)); return }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error(`源码指纹不接受符号链接：${rel}/${entry.name}`)
      await walk(`${rel}/${entry.name}`)
    }
  }
  for (const path of SOURCE_PATHS) await walk(path)
  return { sha256: sha256(canonical(files)), files }
}

export function runtimeIdentity() {
  return { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch }
}
export function environment() {
  return { ...runtimeIdentity(), cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length }
}
export function gitHead(root) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  catch { return null }
}

export async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (e) { if (e.code === 'ENOENT') return null; throw e }
}

// 同目录临时文件 + fsync + rename；中断最多留下 .tmp，绝不把半截 JSON 当完成。
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  const file = await open(tmp, 'wx')
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await file.sync()
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  } finally { await file.close() }
  try { await rename(tmp, path) }
  finally { await unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e }) }
  const dir = await open(dirname(path), 'r')
  try { await dir.sync() } finally { await dir.close() }
}

export function sealResult(record) {
  const { recordSha256: _, ...body } = record
  return { ...body, recordSha256: sha256(canonical(body)) }
}

export async function loadResult(path, identity) {
  const rec = await readJson(path) // 损坏文件必须报错，不能悄悄花几分钟重跑掩盖它。
  if (rec === null) return null
  const { recordSha256, ...body } = rec
  const valid = rec.schema === SCHEMA && rec.status === 'complete' && rec.verified === true
    && rec.key === jobKey(identity) && canonical(rec.identity) === canonical(identity)
    && recordSha256 === sha256(canonical(body))
    && /^[a-f0-9]{64}$/.test(rec.containerSha256 ?? '')
    && rec.n === identity.input.n && Number.isSafeInteger(rec.ucz) && rec.ucz > 0
  if (!valid) throw new Error(`无效检查点（拒绝跳过或覆盖）：${path}`)
  return rec
}

async function processStamp(pid = process.pid) {
  // PID 会在新沙箱复用；同时核对 boot_id 和 /proc 启动 tick。
  const [boot, stat] = await Promise.all([
    readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    readFile(`/proc/${pid}/stat`, 'utf8'),
  ])
  return { host: hostname(), boot: boot.trim(), start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] }
}
async function ownerAlive(owner) {
  try {
    const current = await processStamp(owner.pid)
    return owner.host === current.host && owner.boot === current.boot && owner.start === current.start
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ESRCH') return false
    throw e // 无法检查时不冒险抢锁
  }
}

export async function acquireLock(path) {
  await mkdir(dirname(path), { recursive: true })
  const owner = { ...await processStamp(), pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() }
  for (let i = 0; i < 3; i++) {
    let file
    try { file = await open(path, 'wx') }
    catch (e) {
      if (e.code !== 'EEXIST') throw e
      const old = await readJson(path) // 半写锁 fail closed，不盲删未知进程的锁。
      if (old === null) continue
      if (await ownerAlive(old)) throw new Error(`已有测量进程 PID=${old.pid}；不要重复启动（锁 ${path}）`)
      // 多个恢复者不能同时删除旧锁（第二个可能误删第一个的新锁）。
      // 恢复锁不自动抢占；若死在这个极短临界区，宁可报错停下供人工检查。
      let reaper
      try { reaper = await open(`${path}.reaping`, 'wx') }
      catch (e) {
        if (e.code === 'EEXIST') throw new Error(`另一个恢复操作持有 ${path}.reaping；请检查进程后再恢复`)
        throw e
      }
      try {
        await reaper.writeFile(JSON.stringify(owner)); await reaper.sync()
        const current = await readJson(path)
        if (current && !await ownerAlive(current)) await unlink(path)
      } finally {
        await reaper.close()
        await unlink(`${path}.reaping`)
      }
      continue
    }
    try { await file.writeFile(JSON.stringify(owner)); await file.sync() }
    finally { await file.close() }
    return async () => {
      const current = await readJson(path)
      if (current?.token === owner.token) await unlink(path)
    }
  }
  throw new Error(`无法取得测量锁：${path}`)
}

export function pathsFor(root, key) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('无效 job key')
  return {
    result: join(root, RESULT_DIR, `${key}.json`),
    state: join(root, RESULT_DIR, 'jobs', `${key}.json`),
  }
}

// 仅提交小型结果目录；绝不 git add .，不夹带已有暂存或源码修改。
export function checkpointResults(root, message, resultDir = RESULT_DIR) {
  if (![RESULT_DIR, 'scripts/diag/p10-results', 'scripts/diag/p11-results'].includes(resultDir)) throw new Error('无效检查点结果目录')
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  if (git('branch', '--show-current') !== BRANCH) throw new Error(`必须在 ${BRANCH} 上保存检查点`)
  if (git('diff', '--cached', '--name-only')) throw new Error('已有暂存改动；拒绝将其混入测量检查点')
  if (git('status', '--porcelain', '--', ...SOURCE_PATHS)) throw new Error('被测源码尚未提交；请先保存代码检查点，或明确使用 --local-only')
  git('add', '--', resultDir)
  if (git('diff', '--cached', '--name-only')) git('commit', '-m', message)
  // 显式分支；push 失败直接抛出，保留本地数据，停止后续测量。绝不 force push。
  git('push', 'origin', BRANCH)
  return git('rev-parse', '--short', 'HEAD')
}

export function projectRoot() {
  return resolve(process.env.P9_PROJECT_ROOT ?? process.cwd())
}
