// 诊断：>1 MiB 区域的“中尺度连续热身复核”是否真的能把采样误判纠正过来。
// 直接比较各候选在 40 KB 采样、512 KB 连续缓冲区和全区上的真实字节数。
// 用法：node scripts/diag/run.mjs probe-midprobe <文件...>
import { readFile } from 'node:fs/promises'
import { encodeSpec, sampleWindows, ID, specLabel, evaluatePlan } from '../../src/lib/codec'

const SPECS = [
  { id: ID.TEXT, s: 1, r: 1 },
  { id: ID.TEXT_V2, s: 1, r: 1 },
  { id: ID.TEXT_V3, s: 1, r: 1 },
  { id: ID.BIN, s: 1, r: 1 },
  { id: ID.BIN_V2, s: 1, r: 1 },
  { id: ID.BIN_V3, s: 1, r: 1 },
]

for (const file of process.argv.slice(2)) {
  const data = await readFile(file)
  const rows: Record<string, unknown>[] = []
  const probeSize = Math.min(data.length, 512 * 1024)
  const probeStart = Math.floor((data.length - probeSize) / 2)
  const probe = data.subarray(probeStart, probeStart + probeSize)
  for (const spec of SPECS) {
    const shortWindows = sampleWindows(data, 40000, 1)
    const short = shortWindows.reduce((a, w) => a + encodeSpec(w.sample, spec, undefined, 0, w.start).length, 0)
    const mid = encodeSpec(probe, spec, undefined, 0, probeStart).length
    let full = -1
    try { full = evaluatePlan(data, [{ start: 0, end: data.length, cls: 'text', spec }], { alreadyMerged: true }).payloadBytes } catch { /* ignore */ }
    rows.push({ spec: specLabel(spec), shortPct: +(short / 40000 * 100).toFixed(2), midPct: +(mid / probeSize * 100).toFixed(2), fullPct: full > 0 ? +(full / data.length * 100).toFixed(2) : null, fullBytes: full > 0 ? full : null })
  }
  const byShort = [...rows].sort((a, b) => (a.shortPct as number) - (b.shortPct as number))
  const byMid = [...rows].sort((a, b) => (a.midPct as number) - (b.midPct as number))
  const byFull = [...rows].filter(r => r.fullBytes).sort((a, b) => (a.fullBytes as number) - (b.fullBytes as number))
  console.log(JSON.stringify({ file: file.split('/').pop(), size: data.length, probeKB: probeSize / 1024, rows, shortPicks: byShort[0].spec, midPicks: byMid[0].spec, fullPicks: byFull[0]?.spec ?? null }))
}
