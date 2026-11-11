// P2-2/3 探针：mozilla / samba 的区域与分组构成，找出字节花在哪里。
// 用法：node scripts/diag/run.mjs probe-moz-groups /tmp/corpus/mozilla
import { readFile } from 'node:fs/promises'
import { compressAdaptive } from '../../src/lib/codec'

const file = process.argv[2] ?? '/tmp/corpus/mozilla'
const raw = await readFile(file)
const t = performance.now()
const c = await compressAdaptive(raw)
const ms = Math.round(performance.now() - t)
const total = c.container.length

const bySel = new Map<string, { n: number; raw: number; comp: number }>()
for (const s of c.segs) {
  const k = s.label
  const e = bySel.get(k) ?? { n: 0, raw: 0, comp: 0 }
  e.n++; e.raw += s.rawLen; e.comp += s.compLen
  bySel.set(k, e)
}
const rows = [...bySel.entries()].map(([label, v]) => ({
  label, segs: v.n, rawMiB: +(v.raw / 1048576).toFixed(2), rawPct: +(v.raw / raw.length * 100).toFixed(1),
  comp: v.comp, compPct: +(v.comp / total * 100).toFixed(2), bpi: +(v.comp * 8 / Math.max(1, v.raw)).toFixed(3),
})).sort((a, b) => b.comp - a.comp)

// 短区域（<=4 KB）的体量与占比
let smallN = 0, smallRaw = 0, smallComp = 0
for (const s of c.segs) if (s.rawLen <= 4096) { smallN++; smallRaw += s.rawLen; smallComp += s.compLen }

console.log(JSON.stringify({
  file: file.split('/').pop(), size: raw.length, ucz: total, pct: +(total / raw.length * 100).toFixed(2),
  version: c.container[3], segs: c.segs.length, groups: rows.length, encMs: ms, header: c.overhead,
  groupsDetail: rows,
  smallIslands: { count: smallN, rawBytes: smallRaw, compBytes: smallComp, compPct: +(smallComp / total * 100).toFixed(2) },
}, null, 1))
