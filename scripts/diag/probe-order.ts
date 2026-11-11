// 诊断：归一时“组内顺序拼接”与“原区域顺序拼接”的字节差（说明为何按区域顺序）。
// 用法：node scripts/diag/run.mjs probe-order <文件>
import { readFile } from 'node:fs/promises'
import { compressAdaptive, encodeTerrainGroup, ID } from '../../src/lib/codec'

const data = await readFile(process.argv[2] ?? '/tmp/corpus/samba')
const comp = await compressAdaptive(data)
for (const [name, id] of [['TEXT', ID.TEXT_V3], ['BIN', ID.BIN_V3]] as const) {
  const members = comp.segs.filter(s => s.spec.id === id)
  if (members.length < 2) continue
  const parts = members.map(s => data.subarray(s.start, s.end))
  const natural = encodeTerrainGroup(parts, { id, s: 1, r: 1 }).length
  // 用规则族里“另一种成员”的段序近似“按组拼接”的乱序效应：取模 3 交错。
  const shuffled = parts.filter((_, i) => i % 3 === 0).concat(parts.filter((_, i) => i % 3 === 1), parts.filter((_, i) => i % 3 === 2))
  const inter = encodeTerrainGroup(shuffled, { id, s: 1, r: 1 }).length
  console.log(`${name}: 区域顺序 ${natural} B，交错顺序 ${inter} B（${((inter / natural - 1) * 100).toFixed(2)}%），段数 ${parts.length}`)
}
