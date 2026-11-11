// 阶段耗时分解：把 compressAdaptive 的 onStage 消息按阶段归并成时间片。
// 用法：node scripts/diag/run.mjs probe-stages <文件> [--serial]
//
// 说明：onStage 消息是"阶段开始"信号，因此每条消息到下一条的间隔就是该阶段
// 实际耗时。归并口径：
//   区域 / 并行试探  → chooseSpec（逐区域试探，独立、可并行）
//   同族规则归一      → unify（族内归一，串行实验）
//   编码地形 / 并行编码 → groupEncode（分组编码，P4-3 的目标阶段）
//   其余              → other（分析、锚点归一、容器序列化…）
import { readFile } from 'node:fs/promises'
import { compressAdaptive, parallelReport } from '../../src/lib/codec'
import { closePool } from '../../src/lib/parallel-pool'
import { threadCount } from '../../src/lib/parallel'

const args = process.argv.slice(2)
const file = args.find(a => !a.startsWith('--')) ?? '/tmp/corpus/xml1m'
const serial = args.includes('--serial')
const data = await readFile(file)

const t0 = performance.now()
let last = t0
const rows: { ms: number; msg: string }[] = []
const out = await compressAdaptive(data, msg => {
  const now = performance.now()
  rows.push({ ms: now - last, msg })
  last = now
}, serial ? { serial: true } : undefined)
const total = performance.now() - t0

const phase = (m: string) =>
  m.startsWith('区域') || m.startsWith('并行试探') ? 'chooseSpec'
    : m.startsWith('编码地形') || m.startsWith('并行编码') ? 'groupEncode'
      : m.startsWith('同族') ? 'unify' : 'other'
const sums: Record<string, number> = {}
for (const r of rows) sums[phase(r.msg)] = (sums[phase(r.msg)] ?? 0) + r.ms
for (const k of Object.keys(sums)) sums[k] = Math.round(sums[k])

console.log(JSON.stringify({
  file: file.split('/').pop(), serial, threads: threadCount(), parallelUsed: parallelReport.used,
  parallelJobs: parallelReport.groups,
  bytes: out.container.length, total: Math.round(total), stages: sums,
  afterLastStage: Math.round(performance.now() - last), events: rows.length,
}))
await closePool()
