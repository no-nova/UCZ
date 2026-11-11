// P8-环节二 探针：段粒度阶梯 + 网格相位敏感性。
//
// 1) 粒度阶梯：同一份切片分别按 4 KiB / 16 KiB / 64 KiB 均匀网格和 analyze 的
//    真实分段切开，每段只在 {TEXT_V3, BIN_V3} 里整段真实编码取小者，
//    然后分别看“逐段独立之和”和“evaluatePlan（同规则共享 CM + 头部）”。
//    如果细网格并不更小，说明 512 网格 + 平滑并不是瓶颈。
// 2) 相位敏感性：把整份切片平移 0..7 字节再编码同一个步长规则，
//    量出“真实结构边界与固定网格错开 1~3 字节”到底值多少字节。
//
// 用法：node scripts/diag/run.mjs probe-p8-grid [切片字节数=524288] [文件...]
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { analyze, detectRecordStride } from '../../src/lib/analyze'
import { encodeSpec, evaluatePlan, ID } from '../../src/lib/codec'
import type { Spec } from '../../src/lib/codec'
import type { Cls } from '../../src/lib/analyze'

const argN = Number(process.argv[2] ?? 512 * 1024)
const files = process.argv.slice(3).length ? process.argv.slice(3)
  : ['mozilla', 'osdb', 'sao', 'mr', 'x-ray', 'webster', 'ooffice', 'xml']
await mkdir('/tmp/p8-grid', { recursive: true })

const TEXT_V3: Spec = { id: ID.TEXT_V3, s: 1, r: 1 }
const BIN_V3: Spec = { id: ID.BIN_V3, s: 1, r: 1 }

const out: unknown[] = []
for (const f of files) {
  const raw = await readFile('/tmp/corpus/' + f)
  const data = argN > 0 ? raw.subarray(0, Math.min(argN, raw.length)) : raw
  const n = data.length
  const an = analyze(data)
  const analyzeSegs = an.segs.map(s => ({ start: s.start, end: s.end, cls: s.cls }))

  const grids: Record<string, { start: number; end: number; cls: Cls }[]> = { analyze: analyzeSegs }
  for (const G of [4096, 16384, 65536]) {
    const arr: { start: number; end: number; cls: Cls }[] = []
    for (let p = 0; p < n; p += G) {
      const host = analyzeSegs.find(s => s.start <= p && p < s.end) ?? analyzeSegs[0]
      arr.push({ start: p, end: Math.min(n, p + G), cls: host?.cls ?? 'binary' })
    }
    grids[`g${G}`] = arr
  }

  const ladder: Record<string, unknown> = {}
  for (const [name, segs] of Object.entries(grids)) {
    let sumStandalone = 0, nText = 0
    const picks = segs.map(s => {
      const seg = data.subarray(s.start, s.end)
      const t = encodeSpec(seg, TEXT_V3, undefined, 0, s.start).length
      const b = encodeSpec(seg, BIN_V3, undefined, 0, s.start).length
      sumStandalone += Math.min(t, b)
      if (t <= b) nText++
      return { start: s.start, end: s.end, cls: s.cls, spec: t <= b ? TEXT_V3 : BIN_V3 }
    })
    let plan: { bytes: number | null; groups?: number; segs?: number; header?: number }
    try {
      const c = evaluatePlan(data, picks)
      plan = { bytes: c.totalBytes, groups: c.groupCount, segs: c.segmentCount, header: c.headerBytes }
    } catch (e) { plan = { bytes: null } ; void e }
    ladder[name] = { segs: segs.length, sumStandalone, planBytes: plan.bytes, groups: plan.groups, header: plan.header, textSegs: nText }
  }
  // 纯恒等对照：整份切片一个段
  const uni: Record<string, number> = {}
  for (const [k, sp] of [['TEXT_V3', TEXT_V3], ['BIN_V3', BIN_V3]] as [string, Spec][]) {
    try { uni[k] = evaluatePlan(data, [{ start: 0, end: n, cls: 'text', spec: sp }]).totalBytes } catch { uni[k] = -1 }
  }

  // ---- 相位敏感性 ----
  const stride = detectRecordStride(data)
  const phase: Record<string, unknown> = { stride }
  if (stride >= 2) {
    for (const sp of [{ id: ID.TRANSPOSE, s: stride, r: 1 }, { id: ID.TRANSPOSE_GROUP, s: stride, r: 1 }] as Spec[]) {
      const sizes: number[] = []
      for (let off = 0; off < 8; off++) {
        const seg = data.subarray(off, n - 8 + off)
        try { sizes.push(encodeSpec(seg, sp, undefined, 0, off).length) } catch { sizes.push(-1) }
      }
      const ok = sizes.filter(x => x > 0)
      phase[`id${sp.id}`] = { sizes, spread: ok.length ? Math.max(...ok) - Math.min(...ok) : 0, best: ok.length ? Math.min(...ok) : -1, atPhase0: sizes[0] }
    }
  }

  const rec = { file: f, n, analyzeSegs: analyzeSegs.length, stride, ladder, uniform: uni, phase }
  out.push(rec)
  await writeFile(`/tmp/p8-grid/${f}.json`, JSON.stringify(rec))
  console.log(JSON.stringify({ file: f, n, stride, uniform: uni, ladder: Object.fromEntries(Object.entries(ladder).map(([k, v]: [string, any]) => [k, { segs: v.segs, standalone: v.sumStandalone, plan: v.planBytes }])) }))
}
console.log(JSON.stringify({ kind: 'done', files: out.map(o => (o as any).file) }))
