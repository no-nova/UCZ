/**
 * P31.0：零先验条件复杂度 C(y|x) 与归一化压缩距离（NCD）引擎。
 *
 * 关键设计：UCZ 的 CM 是**因果在线**模型，所以 `x || y` 必须在同一个模型实例里
 * 连续编码 —— 一旦地形分段把 `x`、`y` 分成两个组，哈希表会在 `|x|` 处重置，
 * 跨文件的"条件学习"就消失了。`mode: 'cm'` 因此直接构造单段连续流：
 * `C(x)`、`C(y)`、`C(x||y)`、`C(y||x)` 四次编码，四种长度都可复现。
 */
import { encodeCM } from './coder'
import { compressAdaptive } from './codec'
import { deltaFwd } from './transforms'
import { fingerprintStream } from './inspect'
import type { CompressionLevel } from './codec'

export type NcdMode = 'cm' | 'container'

export interface NcdOptions {
  mode?: NcdMode
  profile?: 'auto' | 'text' | 'bin'
  level?: CompressionLevel
  /** `cm` 模式下每个输入的样本上限（默认 32 KiB）。0 表示不截断。 */
  maxBytes?: number
  /** `cm` 模式下按检测到的多通道步长做 `deltaFwd` 预对齐（默认开启）。 */
  alignManifold?: boolean
}

export interface NcdPairResult {
  /** C(x)：x 单独编码的字节数。 */
  cx: number
  /** C(y)：y 单独编码的字节数。 */
  cy: number
  /** C(x||y)：连续编码 x 后接 y 的总字节数。 */
  cxy: number
  /** C(y||x)：连续编码 y 后接 x 的总字节数。 */
  cyx: number
  /** C(y|x) = max(0, C(xy) - C(x))。 */
  conditionalYGivenX: number
  /** C(x|y) = max(0, C(yx) - C(y))。 */
  conditionalXGivenY: number
  ncd: number
  profile: 'text' | 'bin'
  mode: NcdMode
  /** 实际用于条件编码的多通道步长（1 = 未做 delta 预对齐）。 */
  alignedStride: number
  /** 每个输入实际参与编码的字节数。 */
  windowBytes: number
}

export interface NCDMatrixResult {
  names: string[]
  /** 对称矩阵，matrix[i][i] = 0。 */
  matrix: number[][]
  /** 每项最相近的邻居下标与距离。 */
  nearest: { index: number; distance: number }[]
  costs: number[]
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}


function printableRatio(d: Uint8Array): number {
  if (!d.length) return 0
  let p = 0
  const step = Math.max(1, Math.floor(d.length / 65536))
  let seen = 0
  for (let i = 0; i < d.length; i += step) {
    const b = d[i]
    seen++
    if ((b >= 0x20 && b <= 0x7e) || b === 9 || b === 10 || b === 13) p++
  }
  return seen ? p / seen : 0
}

/** 代表性窗口：取中段的连续片段，避免冷启动主导。 */
function representative(d: Uint8Array, maxBytes: number): Uint8Array {
  // 取**前缀**窗口而不是中段：前缀包含文件的语法/表头（最有跨文件共性的部分），
  // 中段窗口取到的是纯数据区，跨文件共享的信息更少。
  return d.length <= maxBytes ? d : d.subarray(0, maxBytes)
}

/**
 * 多通道预对齐：交错流（s >= 2）直接喂给 CM 会把不同通道混在同一个上下文里，
 * 共享的流形结构就被藏起来了。`deltaFwd(buf, s)` 把每个通道相对"同通道上一帧"
 * 的差编码出来，通道间的共同结构才暴露成可压缩的统计。
 */
function align(buf: Uint8Array, stride: number): Uint8Array {
  if (stride < 2 || buf.length < stride + 2) return buf
  return deltaFwd(buf, stride)
}

function commonStride(x: Uint8Array, y: Uint8Array): number {
  // 只有**两端都**报告同一个 >=2 的步长时才做 delta 预对齐。
  // 单侧证据不足：文本流偶尔会被 `detectRecordStride` 报出一个伪周期，
  // 照它做 delta 会把可压缩结构直接打碎（实测会把散文对的 NCD 抬高 0.2+）。
  const sx = fingerprintStream(x).detectedStride
  const sy = fingerprintStream(y).detectedStride
  return sx >= 2 && sx === sy ? sx : 0
}

/** `C(y)`：单独编码 y 的精确 bit 代价（因果逐块代价之和）。 */
function cmCost(d: Uint8Array, profile: 'text' | 'bin'): number {
  const blocks = Math.max(1, Math.ceil(d.length / SPLIT_BLOCK))
  const bins = new Float32Array(blocks)
  encodeCM(d, profile, 1, 1, undefined, 0, { values: bins, blockSize: SPLIT_BLOCK }, undefined, 'v20', 0, false, cmOptions(profile))
  return sumBins(bins, 0, blocks)
}

const SPLIT_BLOCK = 512

function cmOptions(profile: 'text' | 'bin') {
  return profile === 'text' ? { context: 'text-vertcol' as const, matchDist: true } : { matchDist: true }
}

function sumBins(bins: Float32Array, from: number, to: number): number {
  let c = 0
  for (let i = from; i < to; i++) c += bins[i]
  return c
}

/**
 * `C(y | M_x)`：把 x 截到 512 的整数倍（让 y 从块边界开始），一次性编码 `x||y`，
 * 只累加 y 覆盖的那些块的代价。这是**精确的因果条件代价**——y 的每一块只在
 * x 已经更新过模型之后才被编码，既没有"两次独立编码再相减"的长度失配，也不会
 * 像整条 `C(x||y)` 那样把两半的绝对代价混在一起。
 */
function condCost(prefix: Uint8Array, target: Uint8Array, profile: 'text' | 'bin'): number {
  const cut = (prefix.length >> 9) << 9
  const x = prefix.subarray(0, cut)
  const joined = concat(x, target)
  const blocks = Math.max(1, Math.ceil(joined.length / SPLIT_BLOCK))
  const bins = new Float32Array(blocks)
  encodeCM(joined, profile, 1, 1, undefined, 0, { values: bins, blockSize: SPLIT_BLOCK }, undefined, 'v20', 0, false, cmOptions(profile))
  return sumBins(bins, Math.ceil(cut / SPLIT_BLOCK), blocks)
}

export async function computeNCD(x: Uint8Array, y: Uint8Array, options?: NcdOptions): Promise<NcdPairResult> {
  const mode: NcdMode = options?.mode ?? 'cm'
  const autoText = printableRatio(x) >= 0.85 && printableRatio(y) >= 0.85
  const profile: 'text' | 'bin' = options?.profile && options.profile !== 'auto' ? options.profile : autoText ? 'text' : 'bin'

  if (options?.mode === 'container') {
    const level = options?.level ?? 'fast'
    const enc = async (d: Uint8Array) => (await compressAdaptive(d, undefined, { level })).container.length
    const cx = await enc(x), cy = await enc(y), cxy = await enc(concat(x, y)), cyx = await enc(concat(y, x))
    const ncd = Math.max(0, (Math.min(cxy, cyx) - Math.min(cx, cy)) / Math.max(cx, cy))
    return {
      cx, cy, cxy, cyx,
      conditionalYGivenX: Math.max(0, cxy - cx),
      conditionalXGivenY: Math.max(0, cyx - cy),
      ncd, profile, mode, alignedStride: 0, windowBytes: Math.max(x.length, y.length),
    }
  }

  const maxBytes = options?.maxBytes ?? 32768
  // 默认**不做**流形重排：两侧各自检测到的步长相同，并不代表相位相同，
  // 实测对英文散文与半结构化二进制都会把可压缩性打散（需要调用方显式开启）。
  const alignManifold = options?.alignManifold === true
  const alignedStride = alignManifold ? commonStride(x, y) : 0
  const wx = representative(x, maxBytes)
  const wy = representative(y, maxBytes)
  const ax = align(wx, alignedStride), ay = align(wy, alignedStride)
  // 拼接必须在**对齐之后**：`align` 按 s 取模，只有同一个起点拼接才不会让相位漂移。
  const axy = concat(ax, ay), ayx = concat(ay, ax)
  const cx = cmCost(ax, profile)
  const cy = cmCost(ay, profile)
  const cxy = condCost(ax, ay, profile)
  const cyx = condCost(ay, ax, profile)
  void axy; void ayx
  // 距离 = 两个方向上"条件代价 / 冷启动代价"的较小者，天然落在 [0, 1]：
  // 完全无关时 y 在 x 之后并不更便宜（比值 ≈ 1），共享结构时 << 1。
  const ncd = Math.max(0, Math.min(1, Math.min(cxy / Math.max(cy, 1), cyx / Math.max(cx, 1))))
  return {
    cx, cy, cxy, cyx,
    conditionalYGivenX: Math.max(0, cxy),
    conditionalXGivenY: Math.max(0, cyx),
    ncd, profile, mode, alignedStride, windowBytes: ax.length,
  }
}

export async function computeNCDMatrix(
  items: Array<{ name: string; data: Uint8Array }>,
  options?: NcdOptions,
): Promise<NCDMatrixResult> {
  const mode: NcdMode = options?.mode ?? 'cm'
  const n = items.length
  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  const costs = new Array(n).fill(0)
  // 单项成本只算一次：C(x) 与 C(y) 就是单项编码长度。
  const single = async (i: number): Promise<number> => {
    if (costs[i]) return costs[i]
    const d = items[i].data
    costs[i] = mode === 'container'
      ? (await compressAdaptive(d, undefined, { level: options?.level ?? 'fast' })).container.length
      : cmCost(representative(d, maxBytes), pairProfile(d, d))
    return costs[i]
  }
  const maxBytes = options?.maxBytes ?? 32768
  const alignManifold = options?.alignManifold === true
  // 每对用各自最合适的模型（双方都可打印才用 text），配合有界的 f4 归一化，
  // 才不会出现"散文对因 text 模型更省、分母变小而显得更远"的倒挂。
  const pairProfile = (a: Uint8Array, b: Uint8Array): 'text' | 'bin' =>
    options?.profile && options.profile !== 'auto'
      ? options.profile
      : printableRatio(a) >= 0.85 && printableRatio(b) >= 0.85 ? 'text' : 'bin'
  const pairCost = async (a: Uint8Array, b: Uint8Array, reverse: boolean): Promise<number> => {
    if (mode === 'container') return (await compressAdaptive(concat(a, b), undefined, { level: options?.level ?? 'fast' })).container.length
    const s = alignManifold ? commonStride(a, b) : 0
    const wa = align(representative(a, maxBytes), s), wb = align(representative(b, maxBytes), s)
    // 条件代价的比值：反向遍历即可得到 C(x|M_y)/C(x)。
    return reverse ? condCost(wb, wa, pairProfile(a, b)) : condCost(wa, wb, pairProfile(a, b))
  }
  for (let i = 0; i < n; i++) await single(i)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const cxy = await pairCost(items[i].data, items[j].data, false)
      const cyx = await pairCost(items[i].data, items[j].data, true)
      // cxy/cyx 已经是 C(y|M_x) 与 C(x|M_y) 的绝对 bit 代价，直接除以各自的冷启动代价。
      const d = Math.max(0, Math.min(1, Math.min(cxy / Math.max(costs[j], 1), cyx / Math.max(costs[i], 1))))
      matrix[i][j] = d
      matrix[j][i] = d
    }
  }
  const nearest = matrix.map((row, i) => {
    let best = { index: -1, distance: Infinity }
    for (let j = 0; j < n; j++) if (j !== i && row[j] < best.distance) best = { index: j, distance: row[j] }
    return { index: best.index, distance: Number.isFinite(best.distance) ? best.distance : 0 }
  })
  return { names: items.map(i => i.name), matrix, nearest, costs }
}

export function formatNCDMatrixReport(res: NCDMatrixResult): string {
  const out: string[] = []
  const w = Math.max(...res.names.map(n => n.length), 8)
  out.push('=== UCZ Zero-Prior NCD Distance Matrix ===')
  out.push(`${''.padEnd(w)}  ${res.names.map((_, i) => String(i).padStart(7)).join(' ')}`)
  res.matrix.forEach((row, i) => {
    out.push(`${res.names[i].padEnd(w)}  ${row.map(v => (i === 0 && v === 0 ? '      ·' : v.toFixed(4).padStart(7))).join(' ')}`)
  })
  out.push('')
  out.push('Nearest neighbour:')
  res.names.forEach((nm, i) => {
    const nb = res.nearest[i]
    out.push(`  ${nm.padEnd(w)} → ${nb.index >= 0 ? res.names[nb.index] : '—'}  (NCD=${nb.distance.toFixed(4)})`)
  })
  return out.join('\n')
}
