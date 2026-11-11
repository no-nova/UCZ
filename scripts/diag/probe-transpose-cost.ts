// 诊断：TRANSPOSE-G 方案在“编码期方案比较”里的实际开销。
// 走真实路径 evaluatePlan(spec = TRANSPOSE_GROUP)，而不是分别调用原语，
// 这样改动前后的字节数与耗时可以直接对比。
// 用法：node scripts/diag/run.mjs probe-transpose-cost <文件> <MiB> [步长]
import { readFile } from 'node:fs/promises'
import { evaluatePlan, encodeTerrainGroup, ID } from '../../src/lib/codec'

const file = process.argv[2] ?? '/tmp/corpus/mozilla'
const mib = Number(process.argv[3] || 8)
const width = Number(process.argv[4] || 24)
const data = (await readFile(file)).subarray(0, mib * 1024 * 1024).slice()
const parts = [data]

const t0 = performance.now()
const plan = evaluatePlan(data, [{ start: 0, end: data.length, cls: 'binary', spec: { id: ID.TRANSPOSE_GROUP, s: width, r: 1 } }], { alreadyMerged: true })
const planMs = performance.now() - t0

// 单看三块原语的耗时，用于说明开销分布（不参与判定）
const one = (fn: () => Uint8Array) => { const t = performance.now(); const n = fn().length; return { ms: Math.round(performance.now() - t), bytes: n } }
const legacy = one(() => encodeTerrainGroup(parts, { id: ID.TRANSPOSE_GROUP, s: width, r: 1 }))
const v3 = one(() => encodeTerrainGroup(parts, { id: ID.TRANSPOSE_GROUP_V3, s: width, r: 1 }))
const t2d = one(() => encodeTerrainGroup(parts, { id: ID.TRANSPOSE_2D, s: width, r: 1 }))

console.log(JSON.stringify({
  file: file.split('/').pop(), size: data.length, width,
  plan: { ms: Math.round(planMs), totalBytes: plan.totalBytes, payloadBytes: plan.payloadBytes, headerBytes: plan.headerBytes },
  primitives: { legacy, v3, transpose2d: t2d },
}, null, 1))
