// 一次性诊断：完整压缩一个文件，输出区域/规则构成、耗时、内存与外部基线。
// 用法：node scripts/diag/run.mjs bench-one <文件> [--no-single] [--no-bench] [--verbose-segs]
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import * as zlib from 'node:zlib'
import { compressAdaptive, decompress, singleModelSize, planTuning } from '../../src/lib/codec'
import { modelTuning, a2Tuning, cmV20Tuning } from '../../src/lib/coder'
import { projectRoot, sourceFingerprint, gitHead } from './p9-checkpoint.mjs'

const args = process.argv.slice(2)
const file = args.find(a => !a.startsWith('--'))
if (!file) throw new Error('用法: bench-one <文件>')
const flags = new Set(args.filter(a => a.startsWith('--')))
const data = await readFile(file)
const root = projectRoot(), source = await sourceFingerprint(root)
if (process.env.P9_SOURCE_SHA && process.env.P9_SOURCE_SHA !== source.sha256) throw Error('bench-one 打包/运行源码不一致')
const commit = gitHead(root) // A source archive may legitimately have no .git metadata.
const out: Record<string, unknown> = { file: file.split('/').pop(), size: data.length,
  source: { commit, gitAvailable: commit !== null, sha256: source.sha256 },
  knobs: JSON.parse(JSON.stringify({ modelTuning, a2Tuning, cmV20Tuning, planTuning, batchGuards: !flags.has('--no-batch-guards'), reuseGuardBases: !flags.has('--no-reuse-guard-bases') })),
}

const candidateDecisions: unknown[] = []
;(globalThis as any).__V15_STATS=candidateDecisions
const t0 = performance.now()
const comp = await compressAdaptive(data, undefined, { batchGuards: !flags.has('--no-batch-guards'), reuseGuardBases: !flags.has('--no-reuse-guard-bases') })
const encMs = performance.now() - t0
const encRssKiB = process.resourceUsage().maxRSS
const t1 = performance.now()
const back = decompress(comp.container)
const decMs = performance.now() - t1
out.ucz = comp.container.length
// v19/v20 uint16 配置只记录实际选中载荷的语义；不能从全局旋钮推断。
out.ver = comp.container[3]
out.modelFlags = comp.container[3] >= 19 ? comp.container[4] | (comp.container[5] << 8) : comp.container[3] >= 17 ? comp.container[4] : 0
out.guardStats = comp.guardStats ?? null
out.candidateDecisions=candidateDecisions
delete (globalThis as any).__V15_STATS
out.orphanComparison = comp.orphanComparison ?? null
out.macroComparison = comp.macroComparison ?? null
out.wideComparison = comp.wideComparison ?? null
out.pct = +(comp.container.length / data.length * 100).toFixed(2)
out.encMs = Math.round(encMs)
out.decMs = Math.round(decMs)
out.verified = Buffer.from(back.buffer, back.byteOffset, back.byteLength).equals(data)
// P7-0：无损校验失败绝不能只写进 JSON 就当没事——直接让进程失败，
// 这样 CI / 批量脚本不会把"解压后不一致"的记录当成 PASS。
if (!out.verified) {
  console.error(`[FATAL] 无损校验失败：${out.file} 解压后 ${back.length} B ≠ 原始 ${data.length} B`)
  process.exitCode = 1
}
out.segs = comp.segs.length
out.header = comp.overhead
out.sha256 = createHash('sha256').update(data).digest('hex')
// P17.2: peak RSS after decompression verification, plus the RSS right after the
// encoder finished. `process.resourceUsage().maxRSS` is a high-water mark, so the
// encoder figure has to be sampled before decode allocates anything for it to
// mean "what compression alone needed".
out.encMaxRSSMiB = +(encRssKiB / 1024).toFixed(1)
out.peakMaxRSSMiB = +(process.resourceUsage().maxRSS / 1024).toFixed(1)
out.maxRSSMiB = out.peakMaxRSSMiB
out.encKBps = encMs > 0 ? +(data.length / 1024 / (encMs / 1000)).toFixed(1) : null
out.decKBps = decMs > 0 ? +(data.length / 1024 / (decMs / 1000)).toFixed(1) : null
out.verifiedSha256 = out.verified ? createHash('sha256').update(back).digest('hex') === out.sha256 : false

const byCodec = new Map<string, { codec: string; n: number; raw: number; comp: number; modelFlags: number }>()
for (const sg of comp.segs) {
  const k = sg.label.replace(/\(.*/, '')
  const e = byCodec.get(k) ?? { codec: k, n: 0, raw: 0, comp: 0, modelFlags: 0 }
  e.n++; e.raw += sg.rawLen; e.comp += sg.compLen; e.modelFlags |= sg.modelFlags ?? 0
  byCodec.set(k, e)
}
out.codecs = [...byCodec.values()].sort((a, b) => b.raw - a.raw).map(e => ({
  ...e,
  rawPct: +(e.raw / data.length * 100).toFixed(1),
  compPct: +(e.comp / Math.max(1, comp.container.length) * 100).toFixed(1),
}))
const lens = comp.segs.map(s => s.end - s.start).sort((a, b) => a - b)
out.segDist = {
  median: lens[Math.floor(lens.length / 2)] ?? 0,
  p90: lens[Math.floor(lens.length * 0.9)] ?? 0,
  max: lens[lens.length - 1] ?? 0,
  under4k: lens.filter(l => l < 4096).length,
}
// 每个区域的合规性：实际大小 vs 最佳记录试探
if (flags.has('--verbose-segs')) {
  out.segList = comp.segs.map(s => {
    const trials = s.trials.slice().sort((a, b) => (a.fullSize ?? a.payloadSize ?? 0) - (b.fullSize ?? b.payloadSize ?? 0))
    return {
      range: [s.start, s.end], cls: s.cls, chosen: s.label, spec:s.spec, modelFlags:s.modelFlags, comp: s.compLen,
      bestTrials: trials.slice(0, 3).map(t => ({ label: t.label, sample: t.payloadSize, full: t.fullSize })),
    }
  })
}

if (!flags.has('--no-bench')) {
  const bench: Record<string, unknown> = {}
  const runs: [string, () => Buffer][] = [
    ['zstd3', () => zlib.zstdCompressSync(data, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } })],
    ['zstd19', () => zlib.zstdCompressSync(data, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } })],
    ['brotli5', () => zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })],
  ]
  for (const [k, fn] of runs) {
    try {
      const t = performance.now()
      const p = fn()
      bench[k] = { size: p.length, pct: +(p.length / data.length * 100).toFixed(2), ms: Math.round(performance.now() - t) }
    } catch (e) { bench[k] = { error: String((e as Error).message).slice(0, 80) } }
  }
  out.bench = bench
}
if (!flags.has('--no-single') && data.length <= 10 * 1024 * 1024) {
  const t = performance.now()
  out.singleCM = singleModelSize(data)
  out.singleMs = Math.round(performance.now() - t)
}
out.wallMs = Math.round(performance.now() - t0)
out.sourceUnchanged = (await sourceFingerprint(root)).sha256 === source.sha256
if (!out.sourceUnchanged) { console.error('[FATAL] bench-one 运行中源码改变'); process.exitCode = 1 }
console.log(JSON.stringify(out))
