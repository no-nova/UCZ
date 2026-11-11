// 诊断：按 onStage 消息把 compressAdaptive 拆成可归因的阶段。
// 只依据对外可见的回调，不修改 codec 源码。
import { readFile } from 'node:fs/promises'
import { compressAdaptive } from '../../src/lib/codec'

const file = process.argv[2] ?? '/tmp/corpus/xml'
const data = await readFile(file)
const t0 = performance.now()
const events: { msg: string; pct: number; t: number }[] = []
const comp = await compressAdaptive(data, (msg: string, pct: number) => { events.push({ msg, pct, t: performance.now() - t0 }) })
const total = performance.now() - t0

const first = (pred: (m: string) => boolean) => {
  for (const e of events) if (pred(e.msg)) return e
  return undefined
}
const last = (pred: (m: string) => boolean) => {
  for (let i = events.length - 1; i >= 0; i--) if (pred(events[i].msg)) return events[i]
  return undefined
}
const stagePct = (p: number) => events.find(e => e.pct >= p)

const analyzeEnd = stagePct(15)?.t ?? null
const trialEnd = last(m => m.startsWith('区域'))?.t ?? null
const encodeStart = first(m => m.startsWith('编码地形'))?.t ?? null
const encodeEnd = last(m => m.startsWith('编码地形'))?.t ?? null

const out = {
  file: file.split('/').pop(),
  size: data.length,
  totalMs: Math.round(total),
  events: events.length,
  analyzeMs: analyzeEnd != null ? Math.round(analyzeEnd) : null,
  trialMs: analyzeEnd != null && trialEnd != null ? Math.round(trialEnd - analyzeEnd) : null,
  anchorUnifyMs: trialEnd != null && encodeStart != null ? Math.round(encodeStart - trialEnd) : null,
  finalEncodeMs: encodeStart != null && encodeEnd != null ? Math.round(encodeEnd - encodeStart) : null,
  assembleMs: encodeEnd != null ? Math.round(total - encodeEnd) : null,
  segs: comp.segs.length,
  bytes: comp.container.length,
}
console.log(JSON.stringify(out))
