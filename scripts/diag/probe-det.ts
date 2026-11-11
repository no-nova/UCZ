// 诊断：同一 GCC 输入连续编码两次，字节是否稳定（排除编码器跨调用状态）。
// 用法：node scripts/diag/run.mjs probe-det <文件>
import { readFile } from 'node:fs/promises'
import { encodeTerrainGroup, ID } from '../../src/lib/codec'
const data = await readFile(process.argv[2] ?? '/tmp/corpus/samba')
const n = Math.min(data.length, 3 * 1024 * 1024)
const parts = [data.subarray(0, n / 2), data.subarray(n / 2, n)]
for (const [name, spec] of [['CM-TEXT3', { id: ID.TEXT_V3, s: 1, r: 1 }], ['CM-BIN3', { id: ID.BIN_V3, s: 1, r: 1 }]] as const) {
  const a = encodeTerrainGroup(parts, spec as never).length
  const b = encodeTerrainGroup(parts, spec as never).length
  // 用前缀样本"热身"后再整段编码，检查是否被影响
  encodeTerrainGroup([parts[0].subarray(0, 200_000)], spec as never)
  const c = encodeTerrainGroup(parts, spec as never).length
  console.log(`${name}: 第一次 ${a}，第二次 ${b}，被样本预热后 ${c}  ${a === b && b === c ? 'OK' : '不稳定'}`)
}
