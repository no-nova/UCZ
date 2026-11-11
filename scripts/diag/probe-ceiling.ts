// 诊断：对“整文件单区域”的大文件，比较实际选中的规则与更强的同族规则，
// 衡量采样选择（>1 MiB 不做全区复核）带来的压缩率损失。
// 用法：node scripts/diag/run.mjs probe-ceiling <文件>
import { readFile } from 'node:fs/promises'
import { compressAdaptive, evaluatePlan, ID } from '../../src/lib/codec'

const file = process.argv[2]
const data = await readFile(file)
const n = data.length
const comp = await compressAdaptive(data)
const chosen = comp.segs.length === 1 ? comp.segs[0].spec : null
const res: Record<string, unknown> = {
  file: file.split('/').pop(), size: n, segs: comp.segs.length,
  chosen: chosen ? `${chosen.id},${chosen.s},${chosen.r}` : comp.segs.map(s => s.label),
  adaptiveBytes: comp.container.length,
}
if (chosen) {
  const alts = [
    { id: ID.BIN, s: 1, r: 1 }, { id: ID.BIN_V2, s: 1, r: 1 }, { id: ID.BIN_V3, s: 1, r: 1 },
    { id: ID.TEXT, s: 1, r: 1 }, { id: ID.TEXT_V2, s: 1, r: 1 }, { id: ID.TEXT_V3, s: 1, r: 1 },
    { id: ID.O0, s: 1, r: 1 },
  ].filter(sp => !(sp.id === chosen.id && sp.s === chosen.s && sp.r === chosen.r))
  const rows = []
  for (const sp of alts) {
    const t = performance.now()
    try {
      const plan = evaluatePlan(data, [{ start: 0, end: n, cls: 'binary', spec: sp }], { alreadyMerged: true })
      rows.push({ spec: `${sp.id}`, bytes: plan.totalBytes, pct: +(plan.totalBytes / n * 100).toFixed(2), ms: Math.round(performance.now() - t) })
    } catch (e) { rows.push({ spec: `${sp.id}`, error: String((e as Error).message).slice(0, 50) }) }
  }
  res.alts = rows.sort((a, b) => (a.bytes ?? Infinity) - (b.bytes ?? Infinity))
  const best = res.alts.find(r => typeof r.bytes === 'number') as { bytes: number } | undefined
  if (best) res.lossVsBestPct = +((comp.container.length / best.bytes - 1) * 100).toFixed(2)
}
console.log(JSON.stringify(res, null, 1))
