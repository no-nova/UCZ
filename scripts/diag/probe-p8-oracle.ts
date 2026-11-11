// P8-环节三/环节四 核心探针：暴力神谕对照实验（Brute-Force Selection Oracle）。
//
// 在**完全相同的段划分**下比较五种策略的真实容器字节数：
//   A  现状：compressAdaptive（analyze → 采样选规则 → 合并/分组/归一/v15/wordPre）
//   A' 现状的第一阶段：analyze 段 + chooseSpecSync（40KB 采样 + 512KB 复核）→ evaluatePlan
//   B  去采样偏差：同一个候选池（candidatesFor），但每个段做**整段真实编码**选最小 → evaluatePlan
//   C  全局暴力神谕：无视地形分类，每个段在全部核心变换族上整段真实编码选最小 → evaluatePlan
//   D  纯恒等基线：整份切片当一个段，取 TEXT_V3 / BIN_V3 里更小的那个 → evaluatePlan
//   E  无分组参照：C 的逐段独立编码之和（不共享 CM、不含头部），量化“分组共享”的价值
//   F  粒度神谕（环节二）：把切片按 64 KiB 均匀网格重切，再做 C 的暴力选规则 → evaluatePlan
//
// A' − B = 采样筛选损失（环节四）    B − C = 地形分类/候选池封锁损失（环节三）
// C − D = 空间变换的净贡献          A' − F = 段划分（512 网格 + 平滑）造成的损失
//
// 用法：node scripts/diag/run.mjs probe-p8-oracle [切片字节数=524288] [文件...]
// 每个文件的结果写 /tmp/p8-oracle/<file>.json，stdout 打一行汇总。
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { analyze, detectLagCandidates, detectAnchors, detectRecordStride, detectWide16Lag } from '../../src/lib/analyze'
import { compressAdaptive, evaluatePlan, candidatesFor, chooseSpecSync, sampleWindow, encodeSpec, ID, specLabel } from '../../src/lib/codec'
import type { Spec } from '../../src/lib/codec'
import type { Cls } from '../../src/lib/analyze'

const argN = Number(process.argv[2] ?? 512 * 1024)
const GRID = 64 * 1024
const files = process.argv.slice(3).length ? process.argv.slice(3)
  : ['mozilla', 'samba', 'ooffice', 'osdb', 'webster', 'mr', 'sao', 'xml']
await mkdir('/tmp/p8-oracle', { recursive: true })

const ID_NAME: Record<number, string> = {}
for (const [k, v] of Object.entries(ID)) ID_NAME[v] = k
const key = (sp: Spec) => `${sp.id},${sp.s},${sp.r}`

/**
 * 全部核心变换族：不看地形分类，也不看“采样上有没有希望”。
 * 只保留用户点名的核心算子族（每个族取有限几个相位/步长），
 * 避免把 11 个步长 × 6 个转置变体这种组合爆炸算进时间预算。
 */
function brutePool(seg: Uint8Array, cls: Cls, bestS: number, lagSample: Uint8Array): Spec[] {
  const c: Spec[] = []
  const add = (id: number, s = 1, r = 1) => {
    if (!Number.isSafeInteger(s) || !Number.isSafeInteger(r) || s < 0 || r < 1) return
    if (!c.some(sp => sp.id === id && sp.s === s && sp.r === r)) c.push({ id, s, r })
  }
  const uniq = (xs: (number | undefined | null)[]) => [...new Set(xs.filter((x): x is number => !!x && Number.isFinite(x)))]
  // 恒等族（含 STORE 逃生口 + 全部三代 CM 内核）
  add(ID.STORE); add(ID.O0); add(ID.RLE)
  add(ID.TEXT); add(ID.BIN); add(ID.TEXT_V2); add(ID.BIN_V2); add(ID.TEXT_V3); add(ID.BIN_V3)
  // 一阶差分族
  for (const s of uniq([1, 2, 4, bestS]).filter(x => x >= 1 && x <= 16)) { add(ID.DELTA, s); add(ID.DELTA_V3, s) }
  // 16 位差分族
  add(ID.D16, 1, 1); add(ID.D16, 1, 2); add(ID.D16, 2, 1); add(ID.D16, 2, 2)
  // 二维 MED / 现场拟合微种子
  const lags = detectLagCandidates(seg, bestS).filter(l => l > 0 && seg.length > l * 3)
  for (const lag of lags.slice(0, 2)) {
    if (bestS <= 16 && lag <= 4096) { add(ID.GRAD_V3, bestS, lag); add(ID.MICRO, bestS, lag) }
  }
  if (lags.length && bestS <= 16) { add(ID.GRAD, bestS, lags[0]); add(ID.GRAD_V2, bestS, lags[0]) }
  if (bestS <= 16) add(ID.MICRO, bestS, 1)
  // x86 相对地址重写族
  add(ID.BCJ); add(ID.BCJ_V2); add(ID.BCJ_V3)
  // 转置族（含分组转置 / 递归剥离 / 子通道）
  const stride = detectRecordStride(seg)
  for (const s of uniq([2, 4, 8, 16, bestS, stride]).filter(x => x >= 2 && x <= 64)) {
    add(ID.TRANSPOSE, s)
    if (seg.length >= 32768) add(ID.TRANSPOSE_GROUP, s)
    if (s >= 4) add(ID.PEEL, s)
  }
  for (const s of uniq([stride, bestS]).filter(x => x >= 2 && x <= 64)) {
    add(ID.SUB_TRANSPOSE, s, 1); add(ID.SUB_TRANSPOSE_V3, s, 1); add(ID.SUB_TRANSPOSE_V3, s, 2)
  }
  // 语法锚点族
  for (const a of detectAnchors(lagSample, cls)) {
    add(ID.ANCHOR_FOLD, a.s, a.r); add(ID.SUB_ANCHOR, a.s, a.r); add(ID.SUB_ANCHOR_V3, a.s, a.r); add(ID.ANCHOR, a.s + 1)
  }
  // 宽行 16 位族
  const wide = detectWide16Lag(seg)
  if (wide) { add(ID.WIDE_GRAD, 2, wide); add(ID.WIDE_GRAD, 1, wide) }
  return c
}

/** 整段真实编码（与线上同一个 encodeSpec / 同一个内核），失败记 null。 */
function realSize(seg: Uint8Array, sp: Spec, base: number): number | null {
  try { return encodeSpec(seg, sp, undefined, 0, base).length } catch { return null }
}

type SegRec = {
  start: number; end: number; len: number; cls: Cls; bestS: number
  poolN: number; bruteN: number; bruteErr: number
  bySample: { label: string; spec: Spec; size: number | null } | null
  bestPool: { label: string; spec: Spec; size: number } | null
  bestBrute: { label: string; spec: Spec; size: number } | null
  bestPoolInBrute: number | null
  textV3: number | null; binV3: number | null
  regretSample: number; regretPool: number
  pool: { label: string; size: number }[]
  brute: { label: string; size: number }[]
}

/**
 * 一次遍历同时算出三种口径的选择：采样、候选池整段真实编码、暴力池整段真实编码。
 * 整段编码只做一次（池的并集），三种策略共享同一张 size 表，保证完全可比。
 */
function evalSegs(data: Uint8Array, segs: { start: number; end: number; cls: Cls; bestS: number }[]): { recs: SegRec[]; ms: number } {
  const t0 = Date.now()
  const recs: SegRec[] = []
  const sampleLimit = data.length > 5 * 1024 * 1024
    ? Math.min(16000, Math.max(4096, Math.floor(8 * 1024 * 1024 / Math.max(1, segs.length))))
    : 40000
  for (const s of segs) {
    const seg = data.subarray(s.start, s.end)
    const center = sampleWindow(seg, sampleLimit, s.bestS)
    const pool = candidatesFor(seg, s.cls, s.bestS, center.sample)
    const brute = brutePool(seg, s.cls, s.bestS, center.sample)
    const rec: SegRec = {
      start: s.start, end: s.end, len: seg.length, cls: s.cls, bestS: s.bestS,
      poolN: pool.length, bruteN: brute.length, bruteErr: 0,
      bySample: null, bestPool: null, bestBrute: null, bestPoolInBrute: null,
      textV3: null, binV3: null, regretSample: 0, regretPool: 0, pool: [], brute: [],
    }
    // 采样口径（线上第一阶段）
    const picked = chooseSpecSync(seg, s.cls, s.bestS, sampleLimit, s.start)
    rec.bySample = { label: specLabel(picked.spec), spec: picked.spec, size: realSize(seg, picked.spec, s.start) }
    // 整段真实编码：池 ∪ 暴力池去重后各编一次，三种策略共享这张 size 表
    const sizes = new Map<string, number>()
    const union: Spec[] = []
    const seen = new Set<string>()
    for (const sp of [...brute, ...pool]) { const k = key(sp); if (!seen.has(k)) { seen.add(k); union.push(sp) } }
    for (const sp of union) {
      const sz = realSize(seg, sp, s.start)
      if (sz === null) { rec.bruteErr++; continue }
      sizes.set(key(sp), sz)
    }
    const ranked = [...sizes.entries()].sort((a, b) => a[1] - b[1])
    rec.brute = ranked.map(([k, size]) => ({ label: k, size }))
    const poolKeys = new Set(pool.map(sp => key(sp)))
    const poolRanked = rec.brute.filter(x => poolKeys.has(x.label))
    rec.pool = poolRanked
    const parse = (k: string): Spec => { const [id, s, r] = k.split(',').map(Number); return { id, s, r } }
    if (poolRanked.length) rec.bestPool = { label: poolRanked[0].label, spec: parse(poolRanked[0].label), size: poolRanked[0].size }
    if (rec.brute.length) rec.bestBrute = { label: rec.brute[0].label, spec: parse(rec.brute[0].label), size: rec.brute[0].size }
    if (rec.bySample?.size != null && rec.bestPool) rec.regretSample = rec.bySample.size - rec.bestPool.size
    if (rec.bestPool && rec.bestBrute) rec.regretPool = rec.bestPool.size - rec.bestBrute.size
    const inBrute = rec.brute.find(x => x.label === key(rec.bySample!.spec))
    rec.bestPoolInBrute = inBrute ? inBrute.size : null
    rec.textV3 = sizes.get(key({ id: ID.TEXT_V3, s: 1, r: 1 })) ?? null
    rec.binV3 = sizes.get(key({ id: ID.BIN_V3, s: 1, r: 1 })) ?? null
    recs.push(rec)
  }
  return { recs, ms: Date.now() - t0 }
}

/** 从逐段记录里导出某一种策略的规则分配。 */
function picksOf(segs: { start: number; end: number; cls: Cls }[], recs: SegRec[], mode: 'sample' | 'pool' | 'brute') {
  return segs.map((s, i) => {
    const r = recs[i]
    const spec = mode === 'sample' ? r.bySample!.spec : mode === 'pool' ? (r.bestPool ?? r.bySample!).spec : (r.bestBrute ?? r.bySample!).spec
    return { start: s.start, end: s.end, cls: s.cls, spec }
  })
}

const out: Record<string, unknown>[] = []
for (const f of files) {
  const raw = await readFile('/tmp/corpus/' + f)
  const data = raw.subarray(0, Math.min(argN, raw.length))
  const t0 = Date.now()
  const an = analyze(data)
  const segs = an.segs.map(s => ({ start: s.start, end: s.end, cls: s.cls, bestS: s.bestS }))

  // A：真实现状
  const tA = Date.now()
  const comp = await compressAdaptive(data, undefined, { serial: true })
  const A = { bytes: comp.container.length, segs: comp.segs.length, groups: new Set(comp.segs.map(s => specLabel(s.spec))).size, ms: Date.now() - tA, labels: [...new Set(comp.segs.map(s => s.label))] }

  // 一次遍历算出全部逐段真实编码（三种策略共享同一张 size 表）
  const tS = Date.now()
  const { recs } = evalSegs(data, segs)
  const sA = { recs, ms: Date.now() - tS }
  const sB = sA, sC = sA

  const plan = (picks: { start: number; end: number; cls: Cls; spec: Spec }[]) => {
    try {
      const c = evaluatePlan(data, picks)
      return { bytes: c.totalBytes, header: c.headerBytes, payload: c.payloadBytes, groups: c.groupCount, segs: c.segmentCount }
    } catch (e) { return { error: String((e as Error).message).slice(0, 120) } }
  }
  const Ap = plan(picksOf(segs, recs, 'sample')), B = plan(picksOf(segs, recs, 'pool')), C = plan(picksOf(segs, recs, 'brute'))
  // G / H：同一 analyze 段划分下强制恒等规则——C 的正确对照（同分段、不做选择）
  const G = plan(segs.map(s => ({ start: s.start, end: s.end, cls: s.cls, spec: { id: ID.TEXT_V3, s: 1, r: 1 } })))
  const H = plan(segs.map(s => ({ start: s.start, end: s.end, cls: s.cls, spec: { id: ID.BIN_V3, s: 1, r: 1 } })))

  // D：整份切片一个段，纯恒等
  const dText = realSize(data, { id: ID.TEXT_V3, s: 1, r: 1 }, 0)
  const dBin = realSize(data, { id: ID.BIN_V3, s: 1, r: 1 }, 0)
  const Dspec = (dText ?? Infinity) <= (dBin ?? Infinity) ? { id: ID.TEXT_V3, s: 1, r: 1 } : { id: ID.BIN_V3, s: 1, r: 1 }
  const D = plan([{ start: 0, end: data.length, cls: 'text', spec: Dspec }])

  // E：C 的逐段独立编码之和（无共享 CM、无头部）
  const E = recs.reduce((a, r) => a + (r.bestBrute?.size ?? r.len), 0)

  // F：64 KiB 均匀网格 + 暴力池
  const grid: { start: number; end: number; cls: Cls; bestS: number }[] = []
  for (let p = 0; p < data.length; p += GRID) {
    const end = Math.min(data.length, p + GRID)
    const host = segs.find(s => s.start <= p && p < s.end) ?? segs[0]
    grid.push({ start: p, end, cls: host?.cls ?? 'binary', bestS: host?.bestS ?? 1 })
  }
  const tF = Date.now()
  const { recs: gridRecs } = evalSegs(data, grid)
  const F = plan(picksOf(grid, gridRecs, 'brute'))

  const rec = {
    file: f, n: data.length, analyzeSegs: segs.length, gridSegs: grid.length,
    A, Ap, B, C, D: { ...D, spec: ID_NAME[Dspec.id] }, E, F, G, H,
    dText: dText ?? null, dBin: dBin ?? null,
    sampleRecs: recs.map(r => ({ ...r, brute: r.brute.slice(0, 8), pool: r.pool.slice(0, 8) })),
    gridRecs: gridRecs.map(r => ({ ...r, brute: r.brute.slice(0, 8), pool: r.pool.slice(0, 8) })),
    ms: { A: A.ms, segOracle: sA.ms, grid: Date.now() - tF, total: Date.now() - t0 },
  }
  out.push(rec)
  await writeFile(`/tmp/p8-oracle/${f}.json`, JSON.stringify(rec))
  const num = (x: any) => (typeof x?.bytes === 'number' ? x.bytes : null)
  console.log(JSON.stringify({
    file: f, n: data.length, segs: segs.length,
    A: A.bytes, Ap: num(Ap), B: num(B), C: num(C), D: num(D), E, F: num(F), G: num(G), H: num(H),
    'C-min(G,H)': num(C) != null ? num(C) - Math.min(num(G) ?? Infinity, num(H) ?? Infinity) : null,
    'Ap-B': num(Ap) != null && num(B) != null ? num(Ap) - num(B) : null,
    'B-C': num(B) != null && num(C) != null ? num(B) - num(C) : null,
    'C-D': num(C) != null && num(D) != null ? num(C) - num(D) : null,
    'Ap-F': num(Ap) != null && num(F) != null ? num(Ap) - num(F) : null,
    sec: Math.round((Date.now() - t0) / 1000),
  }))
}
console.log(JSON.stringify({ kind: 'done', files: out.map(o => (o as any).file) }))
