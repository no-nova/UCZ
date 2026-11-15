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
import type { CompressionLevel } from './codec'

export type NcdMode = 'cm' | 'container'

export interface NcdOptions {
  mode?: NcdMode
  profile?: 'auto' | 'text' | 'bin'
  level?: CompressionLevel
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

const TEMP_KEY = 'ncd-临时流'

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

function cmCost(d: Uint8Array, profile: 'text' | 'bin'): number {
  const options = profile === 'text' ? { context: 'text-vertcol' as const, matchDist: true } : { matchDist: true }
  return encodeCM(d, profile, 1, 1, undefined, 0, undefined, undefined, 'v20', 0, false, undefined, undefined, options).length
}

export async function computeNCD(x: Uint8Array, y: Uint8Array, options?: NcdOptions): Promise<NcdPairResult> {
  const mode: NcdMode = options?.mode ?? 'cm'
  const autoText = printableRatio(x) >= 0.85 && printableRatio(y) >= 0.85
  const profile: 'text' | 'bin' = options?.profile && options.profile !== 'auto' ? options.profile : autoText ? 'text' : 'bin'

  if (mode === 'container') {
    const level = options?.level ?? 'fast'
    const enc = async (d: Uint8Array) => (await compressAdaptive(d, undefined, { level })).container.length
    const cx = await enc(x), cy = await enc(y), cxy = await enc(concat(x, y)), cyx = await enc(concat(y, x))
    const ncd = Math.max(0, (Math.min(cxy, cyx) - Math.min(cx, cy)) / Math.max(cx, cy))
    return {
      cx, cy, cxy, cyx,
      conditionalYGivenX: Math.max(0, cxy - cx),
      conditionalXGivenY: Math.max(0, cyx - cy),
      ncd, profile, mode,
    }
  }

  const cx = cmCost(x, profile)
  const cy = cmCost(y, profile)
  const cxy = cmCost(concat(x, y), profile)
  const cyx = cmCost(concat(y, x), profile)
  const ncd = Math.max(0, (Math.min(cxy, cyx) - Math.min(cx, cy)) / Math.max(cx, cy))
  void TEMP_KEY
  return {
    cx, cy, cxy, cyx,
    conditionalYGivenX: Math.max(0, cxy - cx),
    conditionalXGivenY: Math.max(0, cyx - cy),
    ncd, profile, mode,
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
      : cmCost(d, options?.profile && options.profile !== 'auto' ? options.profile : printableRatio(d) >= 0.85 ? 'text' : 'bin')
    return costs[i]
  }
  const pairCost = async (a: Uint8Array, b: Uint8Array): Promise<number> => {
    if (mode === 'container') return (await compressAdaptive(concat(a, b), undefined, { level: options?.level ?? 'fast' })).container.length
    const pr = options?.profile && options.profile !== 'auto'
      ? options.profile
      : printableRatio(a) >= 0.85 && printableRatio(b) >= 0.85 ? 'text' : 'bin'
    return cmCost(concat(a, b), pr)
  }
  for (let i = 0; i < n; i++) await single(i)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const cxy = await pairCost(items[i].data, items[j].data)
      const cyx = await pairCost(items[j].data, items[i].data)
      const lo = Math.max(1, Math.min(costs[i], costs[j]))
      const hi = Math.max(costs[i], costs[j])
      const d = Math.max(0, (Math.min(cxy, cyx) - lo) / hi)
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
