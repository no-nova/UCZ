// P9 A/B：只调用线上入口；完整无损校验后原子保存，再允许续跑跳过。
// 推荐入口：node scripts/diag/run-p9.mjs --bytes 2097152 [文件...]
// 直接入口仍支持：node scripts/diag/run.mjs probe-p9-ab <字节数> [文件...]
// P9_LABEL / P9_SET 保留；P9_CORPUS 默认项目 .diag-data/corpus，不再写 /tmp。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { compressAdaptive, decompress, planTuning } from '../../src/lib/codec'
import { a2Tuning, modelTuning, cmV20Tuning } from '../../src/lib/coder'
import {
  SCHEMA, STATE_DIR, projectRoot, sourceFingerprint, runtimeIdentity, environment, gitHead,
  sha256, jobKey, atomicJson, readJson, sealResult, loadResult, acquireLock, pathsFor,
} from './p9-checkpoint.mjs'

const root = projectRoot()
const TUNING: Record<string, Record<string, unknown>> = { planTuning, a2Tuning, modelTuning, cmV20Tuning }
const applied: string[] = []
for (const kv of (process.env.P9_SET ?? '').split(',')) {
  const t = kv.trim()
  if (!t) continue
  const match = /^([\w]+)\.([\w]+)=(.+)$/.exec(t)
  if (!match) throw new Error(`P9_SET 需要 对象.键=值，收到 ${t}`)
  const [, name, key, raw] = match
  const obj = Object.hasOwn(TUNING, name) ? TUNING[name] : null
  if (!obj || !Object.hasOwn(obj, key)) throw new Error(`未注册的旋钮：${name}.${key}`)
  const val: unknown = raw === 'true' ? true : raw === 'false' ? false
    : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw
  if (typeof val !== typeof obj[key] || (typeof val === 'number' && !Number.isFinite(val))) {
    throw new Error(`旋钮类型错误：${name}.${key}=${raw}`)
  }
  obj[key] = val
  applied.push(`${name}.${key}=${JSON.stringify(val)}`)
}
const knobs = JSON.parse(JSON.stringify(TUNING))
const nArg = Number(process.argv[2] ?? 2097152)
const maxJobs = Number(process.env.P9_MAX_JOBS ?? 1)
if (!Number.isSafeInteger(nArg) || nArg < 0 || !Number.isSafeInteger(maxJobs) || maxJobs < 1) {
  throw new Error('字节数必须是非负整数，P9_MAX_JOBS 必须是正整数')
}
const files = process.argv.slice(3).length ? process.argv.slice(3)
  : ['mozilla', 'samba', 'webster', 'dickens', 'osdb', 'ooffice']
if (files.some(f => !/^[\w.-]+$/.test(f) || f === '.' || f === '..')) throw new Error('文件参数只能是语料文件名')
const label = process.env.P9_LABEL ?? 'run'
const corpus = process.env.P9_CORPUS ?? join(root, '.diag-data/corpus')
const statusOnly = process.env.P9_MODE === 'status'
const emit = (value: object) => console.log(JSON.stringify(value))
const release = statusOnly ? async () => {} : await acquireLock(join(root, STATE_DIR, 'p9-codec.lock'))

// 读实际容器字典，不把逐段 trials 的赢家误当最终分组/内核。
function containerGroups(c: Uint8Array) {
  let p = c[3] >= 19 ? 6 : c[3] >= 17 ? 5 : 4
  const variable = () => {
    let value = 0, mul = 1
    for (let i = 0; i < 8 && p < c.length; i++) {
      const b = c[p++]; value += (b & 127) * mul
      if (!(b & 128)) return value
      mul *= 128
    }
    throw new Error('无法读取刚生成的容器字典')
  }
  variable(); variable()
  const count = variable(), groups = []
  for (let i = 0; i < count; i++) {
    const id = variable(), s = variable(), rRaw = variable(), payloadBytes = variable()
    const v15 = c[3] >= 15 && !!(rRaw & 0x8000), wordPre = c[3] >= 15 && !!(rRaw & 0x4000)
    groups.push({ id, s, r: v15 || wordPre ? rRaw & 0x3fff : rRaw, v15, v20:c[3]>=20 && !!(rRaw&0x10000), wordPre, payloadBytes })
  }
  return groups
}

try {
  const source = await sourceFingerprint(root)
  if (process.env.P9_SOURCE_SHA && process.env.P9_SOURCE_SHA !== source.sha256) {
    throw new Error('打包期间源码变化；未运行测量，请固定源码后重试')
  }
  const baseline = JSON.parse(await readFile(join(root, 'scripts/diag/baseline.json'), 'utf8'))
  const commit = gitHead(root) // 仅记来源，不纳入 key（结果提交不使缓存失效）
  let measured = 0, cached = 0, pending = 0, missing = 0, blocked = 0
  for (const f of files) {
    let raw: Buffer
    try { raw = await readFile(join(corpus, f)) }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      missing++
      emit({ kind: 'status', file: f, status: 'missing-input', path: join(corpus, f) })
      continue
    }
    const offsetArg = process.env.P9_OFFSET ?? '0'
    const offset = offsetArg === 'mid' ? Math.max(0, Math.floor((raw.length - (nArg || raw.length)) / 2)) : Number(offsetArg)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= raw.length) throw new Error(`无效 P9_OFFSET：${offsetArg}`)
    const data = raw.subarray(offset, nArg > 0 ? Math.min(raw.length, offset + nArg) : raw.length)
    const fullSha256 = sha256(raw)
    const known = baseline.files.find((x: { file: string }) => x.file === f)
    if (known && (known.size !== raw.length || known.sha256 !== fullSha256)) {
      throw new Error(`${f} 与 baseline.json 的 Silesia 指纹不符；拒绝混用语料`)
    }
    const identity = {
      schema: SCHEMA, sourceSha256: source.sha256, knobs, runtime: runtimeIdentity(),
      trial: process.env.P9_TRIAL ?? '0',
      input: { file: f, kind: known ? 'Silesia' : 'custom', fullSha256, fullBytes: raw.length,
        sha256: sha256(data), offset, requestedBytes: nArg, n: data.length },
      encodeOptions: { serial: true },
    }
    const key = jobKey(identity)
    const paths = pathsFor(root, key)
    const saved = await loadResult(paths.result, identity)
    if (saved) {
      cached++
      emit({ kind: 'cached', label, file: f, key, ucz: saved.ucz, verified: true, resultPath: paths.result })
      continue
    }
    const previous = await readJson(paths.state)
    const failed = ['failed', 'timed-out'].includes(previous?.status)
    if (statusOnly || measured >= maxJobs || (failed && process.env.P9_RETRY_FAILED !== '1')) {
      pending++
      if (failed) blocked++
      emit({ kind: 'status', label, file: f, key,
        status: failed ? previous.status : previous?.status === 'running' ? 'unfinished' : 'pending',
        retryRequired: failed, statePath: paths.state })
      continue
    }
    const startedAt = new Date().toISOString()
    const state = { schema: SCHEMA, key, label, file: f, n: data.length, sourceSha256: source.sha256,
      resultPath: paths.result, startedAt, attempt: (previous?.attempt ?? 0) + 1, pid: process.pid }
    await atomicJson(paths.state, { ...state, status: 'running', updatedAt: startedAt })
    emit({ kind: 'start', ...state, statePath: paths.state })
    try {
      let lastPct = -1
      const t0 = performance.now()
      const comp = await compressAdaptive(data, (_message, pct) => {
        if (pct < lastPct + 10) return
        lastPct = pct
        emit({ kind: 'progress', key, file: f, pct, elapsedMs: Math.round(performance.now() - t0) })
      }, { serial: true })
      const encMs = Math.round(performance.now() - t0)
      const d0 = performance.now()
      const back = decompress(comp.container)
      if (!Buffer.from(back.buffer, back.byteOffset, back.byteLength).equals(data)) {
        throw new Error(`无损校验失败：${f}`)
      }
      const decMs = Math.round(performance.now() - d0)
      if ((await sourceFingerprint(root)).sha256 !== source.sha256) throw new Error('测量期间源码变化，结果不入账')
      const rec = sealResult({
        schema: SCHEMA, status: 'complete', key, identity, label, file: f, n: data.length,
        ucz: comp.container.length, ver: comp.container[3], containerSha256: sha256(comp.container),
        modelFlags: comp.container[3] >= 19 ? comp.container[4] | (comp.container[5] << 8) : comp.container[3] >= 17 ? comp.container[4] : null,
        groups: containerGroups(comp.container),
        macroComparison: comp.macroComparison ?? null,
        orphanComparison: comp.orphanComparison ?? null,
        // 全量时可直接喂给 check-baseline；切片会因 size/sha 不匹配而正确拒绝。
        size: data.length, sha256: sha256(data), pct: +(comp.container.length / data.length * 100).toFixed(6),
        set: applied, knobs, source, commit, environment: environment(), startedAt, completedAt: new Date().toISOString(),
        segs: comp.segs.length, header: comp.overhead, encMs, decMs, verified: true,
        maxRSSMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(1),
      })
      await atomicJson(paths.result, rec) // 完成凭证先写，状态文件后写；中断后仍能跳过。
      await atomicJson(paths.state, { ...state, status: 'complete', updatedAt: rec.completedAt })
      measured++
      emit({ kind: 'result', ...rec, resultPath: paths.result })
    } catch (e) {
      await atomicJson(paths.state, { ...state, status: 'failed', error: String(e), updatedAt: new Date().toISOString() })
      throw e // 单项失败立即终止，不能以最后一条 echo 的 0 覆盖。
    }
  }
  emit({ kind: 'done', label, measured, cached, pending, missing, blocked, statusOnly })
  if (!statusOnly && (missing || blocked)) process.exitCode = 2
} finally { await release() }
