// 诊断：带 CostBins 与不带 CostBins 的转置方案必须产出相同字节，
// 并且代价仓必须真的被填满（用于热力图）。改动 Task 1 后用它守住等价性。
// 用法：node scripts/diag/run.mjs probe-costmap <文件> [MiB] [步长]
import { readFile } from 'node:fs/promises'
import { evaluatePlan, ID } from '../../src/lib/codec'

const file = process.argv[2] ?? '/tmp/corpus/dickens'
const mib = Number(process.argv[3] || 2)
const width = Number(process.argv[4] || 4)
const data = (await readFile(file)).subarray(0, mib * 1024 * 1024).slice()
const picks = [{ start: 0, end: data.length, cls: 'binary' as const, spec: { id: ID.TRANSPOSE_GROUP, s: width, r: 1 } }]
const a = evaluatePlan(data, picks, { alreadyMerged: true })
const b = evaluatePlan(data, picks, { alreadyMerged: true })
console.log(JSON.stringify({
  file: file.split('/').pop(), size: data.length, width,
  bytes: a.totalBytes, deterministic: a.totalBytes === b.totalBytes,
  header: a.headerBytes, payload: a.payloadBytes,
}))
