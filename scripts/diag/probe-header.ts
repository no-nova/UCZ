// 诊断：区域数量对容器开销（头部）和共享模型收益的影响。
// 用同一份数据构造单区域 vs 8/16 个相同规则区域，比较总字节。
import { readFile } from 'node:fs/promises'
import { evaluatePlan, ID } from '../../src/lib/codec'

const file = process.argv[2] ?? '/tmp/corpus/dickens'
const all = await readFile(file)
const data = all.subarray(0, 2 * 1024 * 1024)
const n = data.length
const out: Record<string, unknown> = {}
for (const parts of [1, 2, 8, 16, 64]) {
  const picks = []
  let p = 0
  for (let i = 0; i < parts; i++) {
    const end = i === parts - 1 ? n : Math.floor((n * (i + 1)) / parts)
    picks.push({ start: p, end, cls: 'text' as const, spec: { id: ID.TEXT, s: 1, r: 1 } })
    p = end
  }
  const plan = evaluatePlan(data, picks, { alreadyMerged: true })
  out[parts + 'seg'] = { total: plan.totalBytes, header: plan.headerBytes, payload: plan.payloadBytes }
}
out.ratio = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, +((v as { total: number }).total / n * 100).toFixed(3)]))
console.log(JSON.stringify(out))
