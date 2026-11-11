// 诊断：验证同族归一的“试算前置判断”是否与全量择优结论一致（不改变字节）。
// 用法：node scripts/diag/run.mjs probe-unify-guard <文件> [分段数]
import { readFile } from 'node:fs/promises'
import { encodeTerrainGroup, ID } from '../../src/lib/codec'

const data = await readFile(process.argv[2] ?? '/tmp/corpus/samba')
const parts = Number(process.argv[3] ?? 4)
const per = Math.ceil(data.length / parts)
const slices: Uint8Array[] = []
for (let i = 0; i < parts; i++) slices.push(data.subarray(i * per, Math.min(data.length, (i + 1) * per)))
const SAMPLE = 256 * 1024
// 现状：偶数段用 CM-BIN，奇数段用 CM-TEXT（模拟“同族不同成员”）。
// 传第二个参数 all=bin 时，所有段都用 CM-BIN，只留“分块边界”这一个差异。
const allBin = process.argv[4] === 'bin'
const specs = slices.map((_, i) => ({ id: allBin ? ID.BIN : (i % 2 ? ID.TEXT : ID.BIN), s: 1, r: 1 }))
const sampleOf = (g: Uint8Array[]) => {
  const out: Uint8Array[] = []
  let raw = 0
  for (const p of g) { if (raw >= SAMPLE) break; const take = Math.min(p.length, SAMPLE - raw); out.push(p.subarray(0, take)); raw += take }
  return { out, raw }
}
for (const targetId of [ID.BIN_V3, ID.TEXT_V3]) {
  const target = { id: targetId, s: 1, r: 1 }
  let sep = 0
  for (let i = 0; i < slices.length; i++) sep += encodeTerrainGroup([slices[i]], specs[i]).length
  const uni = encodeTerrainGroup(slices, target).length
  // 试算：按“分组”取样（本例每个分组只有一段）
  const pieces: Uint8Array[] = []
  let raw = 0, sepSample = 0
  for (let i = 0; i < slices.length; i++) {
    const { out, raw: r } = sampleOf([slices[i]])
    pieces.push(...out); raw += r
    sepSample += encodeTerrainGroup(out, specs[i]).length
  }
  const uniSample = encodeTerrainGroup(pieces, target).length
  const verdict = uniSample >= sepSample * 1.02 ? '试算跳过' : '进入全量'
  const truth = uni < sep ? '全量更小' : '全量不更小'
  console.log(`目标 ${targetId}: 试算 ${uniSample} vs ${sepSample} (${((uniSample / sepSample - 1) * 100).toFixed(2)}%) → ${verdict}；全量 ${uni} vs ${sep} (${((uni / sep - 1) * 100).toFixed(2)}%) → ${truth}${verdict === '试算跳过' && truth === '全量更小' ? '  ❌ 误杀' : ''}`)
}
