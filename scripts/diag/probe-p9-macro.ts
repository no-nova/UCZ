// P9-1.2 归因探针：整片"单一规则单组"到底该用哪条规则。
//
// 为什么需要它：报告 2 §3.4 的 −20,644 B 不是"候选池漏了 TG_V3"（probe-p9-tg3
// 实测逐段口径只值 1,168 B），而是"**整片换成单一 TRANSPOSE-G3(4) 组**"。
// 也就是说这笔钱属于 P9-1.2（整文件单组兜底门），而现有 macroUniformGate
// 只在 [TEXT_V3, BIN_V3] 里挑 —— 转置族整片都试不到，等于把这笔钱留在桌上。
//
// 本探针对同一切片逐一算真实 `evaluatePlan` 字节：
//   pipeline（线上 compressAdaptive） / 单一 TEXT_V3 / 单一 BIN_V3 /
//   单一 TRANSPOSE_GROUP_V3(s) 若干步长 / 单一 TRANSPOSE_GROUP(s)
// 用法：node scripts/diag/run.mjs probe-p9-macro [字节数] [文件...] [offset|mid]
import { readFile } from 'node:fs/promises'
import { compressAdaptive, evaluatePlan, ID } from '../../src/lib/codec'

const argN = Number(process.argv[2] ?? 1048576)
const fileArgs = process.argv.slice(3).filter(a => !/^(mid|\d+)$/.test(a))
const files = fileArgs.length ? fileArgs : ['mozilla']
// 报告 2 §3.4 用的是"1 MiB 中部切片"，而默认从头取会让 mozilla 落在完全不可压的区段
// （开头 1 MiB 流水线 640,732 B vs 报告 2 恒等基线 318,832 B）。必须能指定偏移。
const offArg = process.argv.slice(3).find(a => /^(mid|\d+)$/.test(a)) ?? '0'
const STRIDES = [2, 4, 8, 16, 24, 28, 38, 56]

for (const f of files) {
  const raw = await readFile('/tmp/corpus/' + f)
  const off = offArg === 'mid' ? Math.max(0, Math.floor((raw.length - argN) / 2)) : Number(offArg)
  const data = argN > 0 ? raw.subarray(off, Math.min(off + argN, raw.length)) : raw
  const n = data.length
  const one = (id: number, s = 1, r = 1) => {
    try {
      return evaluatePlan(data, [{ start: 0, end: n, cls: 'text', spec: { id, s, r } }]).totalBytes
    } catch { return -1 }
  }
  const t0 = Date.now()
  const pipe = (await compressAdaptive(data, undefined, { serial: true })).container.length
  const out: Record<string, number> = {
    pipeline: pipe,
    TEXT_V3: one(ID.TEXT_V3),
    BIN_V3: one(ID.BIN_V3),
  }
  for (const s of STRIDES) out[`TG_V3(s=${s})`] = one(ID.TRANSPOSE_GROUP_V3, s)
  for (const s of [4, 28, 38]) out[`TG(s=${s})`] = one(ID.TRANSPOSE_GROUP, s)
  const best = Object.entries(out).filter(([, v]) => v > 0).sort((a, b) => a[1] - b[1])[0]
  const bestPlain = Math.min(out.TEXT_V3, out.BIN_V3)
  console.log(JSON.stringify({
    file: f, n, offset: off, pipeline: pipe, candidates: out,
    best: best[0], bestBytes: best[1],
    gainVsPipeline: pipe - best[1],
    gainPct: +((pipe - best[1]) / pipe * 100).toFixed(3),
    // 现有 macroUniformGate 只看 TEXT_V3/BIN_V3，会漏掉多少
    missedByPlainOnly: bestPlain - best[1],
    ms: Date.now() - t0,
  }))
}
console.log(JSON.stringify({ kind: 'done', files }))
