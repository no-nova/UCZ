// P8-环节四 探针：试压采样机制审计。
//
// 三件事：
//   1) 采样保真度：对每个真实区域，把候选池里每个规则都用**整段真实编码**测出真值，
//      再和四种采样口径的排名对比（top-1 命中率、错选遗憾 Regret 字节数、Spearman）。
//      口径：pipeline（线上 3×13.6KB 三窗口，取自 chooseSpecSync 的 trials）、
//            w1-40k（单段连续 40KB）、w1-256k（单段连续 256KB）、truth（整段）。
//   2) 经验惩罚系数 A/B：planTuning.neutralPenalties 开关，端到端 evaluatePlan 对照。
//   3) 解析熵能否替代试压：对可用正向变换的候选，用 H0/H1 排名与真值排名对比。
//
// 用法：node scripts/diag/run.mjs probe-p8-sample [切片字节数=524288] [文件...]
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { analyze } from '../../src/lib/analyze'
import { candidatesFor, chooseSpecSync, sampleWindow, sampleWindows, candidateAlignment, encodeSpec, evaluatePlan, planTuning, ID, specLabel } from '../../src/lib/codec'
import type { Spec, Trial } from '../../src/lib/codec'
import { deltaFwd, medFwd, d16Fwd, bcjFwd, anchorFoldFwd } from '../../src/lib/transforms'

const argN = Number(process.argv[2] ?? 512 * 1024)
const files = process.argv.slice(3).length ? process.argv.slice(3) : ['osdb', 'mozilla', 'webster', 'ooffice']
await mkdir('/tmp/p8-sample', { recursive: true })

const key = (sp: Spec) => `${sp.id},${sp.s},${sp.r}`
const parse = (k: string): Spec => { const [id, s, r] = k.split(',').map(Number); return { id, s, r } }

function h0(d: Uint8Array): number {
  const h = new Float64Array(256)
  for (let i = 0; i < d.length; i++) h[d[i]]++
  let e = 0
  for (let i = 0; i < 256; i++) if (h[i]) { const p = h[i] / d.length; e -= p * Math.log2(p) }
  return e
}
function h1(d: Uint8Array): number {
  const j = new Float64Array(256 * 256), m = new Float64Array(256)
  for (let i = 1; i < d.length; i++) { j[d[i - 1] * 256 + d[i]]++; m[d[i - 1]]++ }
  let e = 0
  const n = Math.max(1, d.length - 1)
  for (let a = 0; a < 256; a++) {
    if (!m[a]) continue
    for (let b = 0; b < 256; b++) {
      const c = j[a * 256 + b]
      if (c) e -= (c / n) * Math.log2(c / m[a])
    }
  }
  return e
}
/** 采样口径：与 chooseSpecImpl 同一套窗口函数，只改预算/窗口数。 */
function sampled(seg: Uint8Array, sp: Spec, base: number, budget: number, maxWindows: number, align: number): number {
  const windows = sampleWindows(seg, budget, align, maxWindows)
  let size = 0
  for (const { sample, start } of windows) {
    size += encodeSpec(sample, sp, undefined, 0, base + start).length
    if (sp.id === ID.ANCHOR_FOLD || sp.id === ID.PEEL) size += 4
    if (sp.id === ID.ANCHOR) { let v = size; do { size++; v = Math.floor(v / 128) } while (v) }
  }
  return size
}
function spearman(a: number[], b: number[]): number {
  const rank = (x: number[]) => {
    const idx = x.map((v, i) => [v, i] as [number, number]).sort((p, q) => p[0] - q[0])
    const r = new Array(x.length)
    idx.forEach(([, i], k) => { r[i] = k })
    return r
  }
  const ra = rank(a), rb = rank(b), n = a.length
  const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / n
  const ma = mean(ra), mb = mean(rb)
  let num = 0, da = 0, db = 0
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2 }
  return da && db ? num / Math.sqrt(da * db) : 0
}
/** 正向变换（只有 transforms.ts 导出的这几个能算解析熵）。 */
function fwd(d: Uint8Array, sp: Spec, base: number): Uint8Array | null {
  try {
    switch (sp.id) {
      case ID.TEXT: case ID.BIN: case ID.TEXT_V2: case ID.BIN_V2: case ID.TEXT_V3: case ID.BIN_V3: case ID.O0: case ID.STORE: return d
      case ID.DELTA: case ID.DELTA_V3: return deltaFwd(d, sp.s)
      case ID.GRAD: case ID.GRAD_V2: case ID.GRAD_V3: return medFwd(d, sp.s, sp.r)
      case ID.D16: return d16Fwd(d, sp.s, sp.r)
      case ID.BCJ: case ID.BCJ_V2: case ID.BCJ_V3: return bcjFwd(d, base)
      case ID.ANCHOR_FOLD: return anchorFoldFwd(d, sp.s, sp.r)
      default: return null
    }
  } catch { return null }
}

type Var = { name: string; top1: number; total: number; regretBytes: number; regretPct: number[]; rho: number[] }
const VARS: Var[] = ['pipeline', 'w1-40k', 'w3-40k', 'w1-256k', 'h0', 'h1'].map(name => ({ name, top1: 0, total: 0, regretBytes: 0, regretPct: [], rho: [] }))

const out: unknown[] = []
for (const f of files) {
  const raw = await readFile('/tmp/corpus/' + f)
  const data = raw.subarray(0, Math.min(argN, raw.length))
  const an = analyze(data)
  const segs = an.segs
  const segRecs: unknown[] = []
  for (const s of segs) {
    const seg = data.subarray(s.start, s.end)
    const sampleLimit = data.length > 5 * 1024 * 1024
      ? Math.min(16000, Math.max(4096, Math.floor(8 * 1024 * 1024 / Math.max(1, segs.length))))
      : 40000
    const pool = candidatesFor(seg, s.cls, s.bestS, sampleWindow(seg, sampleLimit, s.bestS).sample)
    const { trials } = chooseSpecSync(seg, s.cls, s.bestS, sampleLimit, s.start)
    const byKey = new Map<string, Trial>()
    for (const t of trials) byKey.set(key(t.spec), t)
    // 真值：整段真实编码
    const truth = new Map<string, number>()
    for (const sp of pool) {
      try { truth.set(key(sp), encodeSpec(seg, sp, undefined, 0, s.start).length) } catch { /* 参数越界等，跳过 */ }
    }
    const keys = [...truth.keys()]
    if (keys.length < 3) continue
    const trueRank = keys.slice().sort((a, b) => truth.get(a)! - truth.get(b)!)
    const trueBest = trueRank[0]
    // 各口径的“分数”（越小越好）
    const scores: Record<string, Map<string, number>> = {
      pipeline: new Map(), 'w1-40k': new Map(), 'w3-40k': new Map(), 'w1-256k': new Map(), h0: new Map(), h1: new Map(),
    }
    for (const k of keys) {
      const sp = parse(k)
      const t = byKey.get(k)
      if (t?.payloadSize != null) scores.pipeline.set(k, t.ratio)
      const align = candidateAlignment(sp, s.bestS)
      scores['w1-40k'].set(k, sampled(seg, sp, s.start, sampleLimit, 1, align))
      scores['w3-40k'].set(k, sampled(seg, sp, s.start, sampleLimit, seg.length < 32 * 1024 ? 1 : 3, align))
      if (seg.length > 256 * 1024) scores['w1-256k'].set(k, sampled(seg, sp, s.start, 256 * 1024, 1, align))
      const tf = fwd(seg, sp, s.start)
      if (tf) { scores.h0.set(k, h0(tf)); scores.h1.set(k, h1(tf)) }
    }
    const rec: Record<string, unknown> = { start: s.start, end: s.end, len: seg.length, cls: s.cls, bestS: s.bestS, trueBest, trueBestSize: truth.get(trueBest)!, poolN: keys.length, variants: {} }
    for (const v of VARS) {
      const sc = scores[v.name]
      if (sc.size < 3) continue
      const ranked = [...sc.keys()].sort((a, b) => sc.get(a)! - sc.get(b)!)
      const winner = ranked[0]
      const regret = (truth.get(winner) ?? 0) - truth.get(trueBest)!
      v.total++
      if (winner === trueBest) v.top1++
      v.regretBytes += regret
      v.regretPct.push(regret / truth.get(trueBest)! * 100)
      const common = [...sc.keys()].filter(k => truth.has(k))
      v.rho.push(spearman(common.map(k => sc.get(k)!), common.map(k => truth.get(k)!)))
      ;(rec.variants as any)[v.name] = { winner, winnerTrueSize: truth.get(winner) ?? null, regret, regretPct: +(regret / truth.get(trueBest)! * 100).toFixed(2), rho: +spearman(common.map(k => sc.get(k)!), common.map(k => truth.get(k)!)).toFixed(3) }
    }
    segRecs.push(rec)
  }
  // 惩罚系数 A/B：同一份切片、同一套采样，只切换 neutralPenalties
  const picksWith: { start: number; end: number; cls: any; spec: Spec }[] = []
  const picksWithout: { start: number; end: number; cls: any; spec: Spec }[] = []
  const sampleLimit = data.length > 5 * 1024 * 1024
    ? Math.min(16000, Math.max(4096, Math.floor(8 * 1024 * 1024 / Math.max(1, segs.length))))
    : 40000
  planTuning.neutralPenalties = false
  for (const s of segs) picksWith.push({ start: s.start, end: s.end, cls: s.cls, spec: chooseSpecSync(data.subarray(s.start, s.end), s.cls, s.bestS, sampleLimit, s.start).spec })
  planTuning.neutralPenalties = true
  for (const s of segs) picksWithout.push({ start: s.start, end: s.end, cls: s.cls, spec: chooseSpecSync(data.subarray(s.start, s.end), s.cls, s.bestS, sampleLimit, s.start).spec })
  planTuning.neutralPenalties = false
  const plan = (p: typeof picksWith) => { try { const c = evaluatePlan(data, p); return c.totalBytes } catch (e) { return null } }
  const pen = { withPenalty: plan(picksWith), neutral: plan(picksWithout), diffSegs: picksWith.filter((p, i) => key(p.spec) !== key(picksWithout[i].spec)).length }
  const rec = { file: f, n: data.length, segs: segs.length, segRecs, penaltyAB: pen }
  out.push(rec)
  await writeFile(`/tmp/p8-sample/${f}.json`, JSON.stringify(rec))
  console.log(JSON.stringify({ file: f, n: data.length, segs: segs.length, penaltyAB: pen,
    top1: Object.fromEntries(VARS.filter(v => v.total).map(v => [v.name, `${v.top1}/${v.total}`])) }))
}
console.log(JSON.stringify({
  kind: 'summary',
  vars: VARS.filter(v => v.total).map(v => ({
    name: v.name, top1: v.top1, total: v.total,
    top1Pct: +(v.top1 / v.total * 100).toFixed(1),
    regretBytes: v.regretBytes,
    regretPctMean: +(v.regretPct.reduce((a, b) => a + b, 0) / v.regretPct.length).toFixed(3),
    regretPctMax: +Math.max(...v.regretPct).toFixed(2),
    rhoMean: +(v.rho.reduce((a, b) => a + b, 0) / v.rho.length).toFixed(3),
  })),
}))
