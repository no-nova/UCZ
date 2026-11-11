// 诊断：同族归一在真实文件上的决策链（组分、试算、采纳/拒绝），只看决策值。
// 用法：node scripts/diag/run.mjs probe-unify-decide <文件>
import { readFile } from 'node:fs/promises'
import { compressAdaptive } from '../../src/lib/codec'

const data = await readFile(process.argv[2] ?? '/tmp/corpus/xml')
const lines: string[] = []
let t = performance.now()
await compressAdaptive(data, (msg: string) => {
  if (msg.startsWith('同族')) { lines.push(`${((performance.now() - t) / 1000).toFixed(1)}s ${msg}`); t = performance.now() }
})
console.log(JSON.stringify({ file: process.argv[2].split('/').pop(), lines }))
