// 诊断：CM 内核的每比特成本随上下文数增长的关系（决定速度上限）。
import { readFile } from 'node:fs/promises'
import { encodeCM } from '../../src/lib/coder'

const data = (await readFile('/tmp/corpus/dickens')).subarray(0, 1 << 20)
const rows = []
for (const [name, args] of [
  ['o1 (2 ctx)', ['o1', 1, 1, undefined, 0, undefined, undefined, false, 0]],
  ['text legacy (7 ctx)', ['text', 1, 1, undefined, 0, undefined, undefined, false, 0]],
  ['text v13 (9 ctx)', ['text', 1, 1, undefined, 0, undefined, undefined, 'v13', 0]],
  ['bin v13 (9 ctx)', ['bin', 1, 1, undefined, 0, undefined, undefined, 'v13', 0]],
] as const) {
  encodeCM(data.subarray(0, 1 << 16), args[0] as never, args[1] as never, args[2] as never, undefined, 0, undefined, undefined, args[7] as never, 0)
  const t = performance.now()
  const out = encodeCM(data, args[0] as never, args[1] as never, args[2] as never, undefined, 0, undefined, undefined, args[7] as never, 0)
  const ms = performance.now() - t
  rows.push({ name, bytes: out.length, pct: +(out.length / data.length * 100).toFixed(2), ms: Math.round(ms), kbPerSec: Math.round(data.length / 1024 / (ms / 1000)), nsPerBit: +(ms * 1e6 / (data.length * 8)).toFixed(0) })
}
console.log(JSON.stringify(rows, null, 1))
