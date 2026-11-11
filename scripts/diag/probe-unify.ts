// 诊断：把自适应选出的区域规则“统一”成单一强规则后重算实际字节，
// 衡量规则碎片化（同族模型被拆成多个 spec、各自冷启动）的代价。
// 用法：node scripts/diag/run.mjs probe-unify <文件> [切片MiB]
import { readFile } from 'node:fs/promises'
import { compressAdaptive, evaluatePlan, ID } from '../../src/lib/codec'
import type { PlanSegment } from '../../src/lib/codec'

const file = process.argv[2]
const mib = Number(process.argv[3] || 0)
const data = mib ? (await readFile(file)).subarray(0, mib * 1024 * 1024).slice() : await readFile(file)
const n = data.length
const comp = await compressAdaptive(data)
const base = comp.container.length
const isTextCM = (id: number) => id === ID.TEXT || id === ID.TEXT_V2 || id === ID.TEXT_V3
const isBinCM = (id: number) => id === ID.BIN || id === ID.BIN_V2 || id === ID.BIN_V3

const variants: Record<string, PlanSegment[]> = {
  adaptive: comp.segs.map(s => ({ start: s.start, end: s.end, cls: s.cls, spec: s.spec })),
  // 所有文本族 CM 统一为 v13 九上下文
  textToV3: comp.segs.map(s => ({ start: s.start, end: s.end, cls: s.cls, spec: isTextCM(s.spec.id) ? { id: ID.TEXT_V3, s: 1, r: 1 } : s.spec })),
  // 所有二进制族 CM 统一为 v13 九上下文
  binToV3: comp.segs.map(s => ({ start: s.start, end: s.end, cls: s.cls, spec: isBinCM(s.spec.id) ? { id: ID.BIN_V3, s: 1, r: 1 } : s.spec })),
  // 所有 CM（文本+二进制）统一成同一个模型
  allCMtoBinV3: comp.segs.map(s => ({ start: s.start, end: s.end, cls: s.cls, spec: (isTextCM(s.spec.id) || isBinCM(s.spec.id)) ? { id: ID.BIN_V3, s: 1, r: 1 } : s.spec })),
}

const out: Record<string, unknown> = { file: file.split('/').pop(), size: n, segs: comp.segs.length }
for (const [name, segs] of Object.entries(variants)) {
  const t = performance.now()
  try {
    const p = evaluatePlan(data, segs, { alreadyMerged: true })
    out[name] = { bytes: p.totalBytes, pct: +(p.totalBytes / n * 100).toFixed(3), groups: p.groupCount, ms: Math.round(performance.now() - t), vsAdaptive: +((p.totalBytes / base - 1) * 100).toFixed(2) }
  } catch (e) { out[name] = { error: String((e as Error).message).slice(0, 80) } }
}
console.log(JSON.stringify(out, null, 1))
