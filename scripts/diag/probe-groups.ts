// P7-3：分组分布 + 孤儿组坍缩吸收的真实 A/B。
// 用法：node scripts/diag/run.mjs probe-groups [切片字节数] [文件...]
import { readFile } from 'node:fs/promises'
import { compressAdaptive, planTuning } from '../../src/lib/codec'

const n = Number(process.argv[2] ?? 2 * 1024 * 1024)
const files = process.argv.slice(3).length ? process.argv.slice(3)
  : ['mozilla', 'samba', 'ooffice', 'osdb', 'xml', 'nci', 'mr']
type Seg = { start: number; end: number; spec: { id: number; s: number; r: number }; label: string }
function dist(segs: Seg[]) {
  const m = new Map<string, { key: string; n: number; raw: number }>()
  for (const s of segs) {
    const k = `${s.spec.id},${s.spec.s},${s.spec.r}`
    const e = m.get(k) ?? { key: k, n: 0, raw: 0 }
    e.n++; e.raw += s.end - s.start
    m.set(k, e)
  }
  const gs = [...m.values()].sort((a, b) => b.raw - a.raw)
  const total = gs.reduce((a, g) => a + g.raw, 0)
  const main = gs[0]?.raw ?? 0
  const orphans = gs.filter(g => g.raw < 128 * 1024 && g.raw > 0)
  return {
    segs: segs.length, groups: gs.length,
    mainKey: gs[0]?.key ?? '-', mainPct: +((main / Math.max(1, total)) * 100).toFixed(1),
    orphanN: orphans.length, orphanBytes: orphans.reduce((a, g) => a + g.raw, 0),
    small64k: gs.filter(g => g.raw < 64 * 1024).length,
  }
}

const rows: Record<string, unknown>[] = []
for (const f of files) {
  const raw = await readFile('/tmp/corpus/' + f)
  const data = raw.subarray(0, Math.min(n, raw.length))
  planTuning.orphanConsolidation = false
  const t0 = Date.now()
  const a = await compressAdaptive(data, undefined, { serial: true })
  const msA = Date.now() - t0
  planTuning.orphanConsolidation = true
  const t1 = Date.now()
  const b = await compressAdaptive(data, undefined, { serial: true })
  const msB = Date.now() - t1
  rows.push({
    file: f, n: data.length,
    old: a.container.length, new: b.container.length, delta: b.container.length - a.container.length,
    'pct%': +((b.container.length / a.container.length - 1) * 100).toFixed(3),
    groupsOld: dist(a.segs).groups, groupsNew: dist(b.segs).groups,
    orphanN: dist(a.segs).orphanN, orphanKB: +(dist(a.segs).orphanBytes / 1024).toFixed(0),
    mainPct: dist(a.segs).mainPct, msOld: msA, msNew: msB,
  })
  console.error('.. ' + f)
}
planTuning.orphanConsolidation = true
console.table(rows)
