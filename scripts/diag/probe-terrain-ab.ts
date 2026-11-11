// P7-2 对照：旧版"单一 kind 硬分类候选" vs 新版"多维特征并集候选"。
// 打印规则命中变化（哪些区域换了规则）、字节数、耗时与候选池规模。
// 用法：node scripts/diag/run.mjs probe-terrain-ab [切片字节数] [文件...]
import { readFile } from 'node:fs/promises'
import { compressAdaptive, planTuning } from '../../src/lib/codec'

const n = Number(process.argv[2] ?? 2 * 1024 * 1024)
const files = process.argv.slice(3).length ? process.argv.slice(3)
  : ['mozilla', 'ooffice', 'osdb', 'samba', 'sao', 'xml', 'mr', 'nci']
const rows: Record<string, unknown>[] = []
for (const f of files) {
  const raw = await readFile('/tmp/corpus/' + f)
  const data = raw.subarray(0, Math.min(n, raw.length))
  planTuning.featureCandidates = false
  const t0 = Date.now()
  const a = await compressAdaptive(data, undefined, { serial: true })
  const msA = Date.now() - t0
  planTuning.featureCandidates = true
  const t1 = Date.now()
  const b = await compressAdaptive(data, undefined, { serial: true })
  const msB = Date.now() - t1
  // 规则命中变化
  const key = (s: { label: string; start: number; end: number }) => `${s.start}-${s.end}:${s.label.replace(/\(.*/, '')}`
  const setA = new Set(a.segs.map(key)), setB = new Set(b.segs.map(key))
  const changed = [...setB].filter(k => !setA.has(k)).length
  const candAvg = (r: typeof a) => +(r.segs.reduce((s, x) => s + x.trials.length, 0) / Math.max(1, r.segs.length)).toFixed(1)
  const diff = [...setB].filter(k => !setA.has(k)).slice(0, 6)
  if (process.env.PROBE_DIFF) console.log(f, 'new-only:', diff.join(' | '), '| old-only:', [...setA].filter(k => !setB.has(k)).slice(0, 6).join(' | '))
  rows.push({
    file: f, n: data.length, old: a.container.length, new: b.container.length,
    delta: b.container.length - a.container.length,
    'pct%': +((b.container.length / a.container.length - 1) * 100).toFixed(3),
    segsOld: a.segs.length, segsNew: b.segs.length, changed,
    candOld: candAvg(a), candNew: candAvg(b), msOld: msA, msNew: msB,
    'ms%': +((msB / Math.max(1, msA) - 1) * 100).toFixed(1),
  })
  console.error('.. ' + f)
}
planTuning.featureCandidates = true
console.table(rows)
