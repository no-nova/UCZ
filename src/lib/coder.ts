import { ByteWriter } from './byte-writer'
import { V21_FLAG_CONTEXTS, contextCodeOf, type CMContext, type CMOptions } from './context-policy'
export type { CMOptions, CMContext } from './context-policy'
import { markPayloadModel, payloadModelFlags } from './payload-model'
import {
  V18_FLAG_TEXT_A2_OFF, V18_FLAG_BIG_TABLE_22, V18_FLAG_TABLE_23,
  V18_FLAG_MATCH_21, V18_FLAG_MATCH_22, V18_FLAG_RES_A2_OFF,
  V18_FLAG_WORD_PRE_A2_OFF, V18_FLAG_UNSCOPED,
  V19_FLAG_TABLE_24, V19_FLAG_MATCH_23, V19_FLAG_MHT4_20,
  V20_FLAG_TRANSFORMS, V20_FLAG_CM, V20_FLAG_BIN_RECOVERY,
  V22_FLAG_MATCH_DISTANCE, CM_FLAGS_MASK, MAX_CONTAINER_VERSION,
  containerHasChecksum, containerHasFreshDistance, containerIsStrict,
} from './container/format'

export {
  V18_FLAG_TEXT_A2_OFF, V18_FLAG_BIG_TABLE_22, V18_FLAG_TABLE_23,
  V18_FLAG_MATCH_21, V18_FLAG_MATCH_22, V18_FLAG_RES_A2_OFF,
  V18_FLAG_WORD_PRE_A2_OFF, V18_FLAG_UNSCOPED,
  V19_FLAG_TABLE_24, V19_FLAG_MATCH_23, V19_FLAG_MHT4_20,
  V20_FLAG_TRANSFORMS, V20_FLAG_CM, V20_FLAG_BIN_RECOVERY,
  V22_FLAG_MATCH_DISTANCE, CM_FLAGS_MASK, MAX_CONTAINER_VERSION,
} from './container/format'


// 二进制算术编码器 + 逐比特上下文混合(Context Mixing)预测器
// 全部使用整数运算 / 确定性表,保证编码端与解码端逐比特一致 => 严格无损。

// 'v15' 是 P2 新增的 APM/SSE 校准版内核；布局与解码路径见 codec.ts 的
// "逐组择优" 逻辑（每个分组用 payload 首字节的最高位标记是否启用 v15）。
export type CMVariant = boolean | 'v13' | 'v15' | 'v20'
export const isAPMKernel = (variant: CMVariant): variant is 'v15' | 'v20' => variant === 'v15' || variant === 'v20'
/** v20 candidates are strictly compared against retained v15 streams. */
export const cmV20Tuning = { enabled: true, binRecovery: true }
/**
 * P24.4 `text-vertcol` high-entropy handling. `emaErr` is an integer EMA of the
 * mean bit-prediction error per byte, accumulated from `(y, pr)` — the two values
 * encoder and decoder are guaranteed to share bit for bit — so every decision
 * below is synchronized without any wire marker.
 */
export const vertTuning = {
  /** Predicted-bit error per byte above which a stream counts as high entropy. */
  thr: 13000,
  /** Damp the final probability toward 2048 (random bits are unpredictable). */
  damp: true,
  /** Freeze the row/word tracker so random bytes cannot pollute real columns. */
  freeze: true,
  /** Also stop reading and training `vertTbl` on frozen (random) bytes: the
   *  column stays pinned, so every bit would train one hot table entry. */
  freezeTbl: true,
  /** Deep-noise threshold for the stronger damping shift. */
  thr2: 14800,
  /**
   * Feed both previous-row predictors on every bit. The table key already
   * contains `c0`, so prefix-match and prefix-mismatch learn separate
   * probabilities; the digit/character-class alignment of the row above stays
   * useful after the MSB prefix diverges.
   */
  ungated: true,
}
/** P18.0 universal low-cardinality symbol modes (symbol-agnostic). */
export type SymContext = 'sym-2bit' | 'sym-5bit' | 'sym-5bit-gap'
export const isSymContext = (c?: string): c is SymContext => c === 'sym-2bit' || c === 'sym-5bit' || c === 'sym-5bit-gap'
export interface SymAlphabet { k: number; bits: number; symToByte: Uint8Array; byteToSym: Uint8Array; compByte: Uint8Array; minCount?: number }
/**
 * Rank alphabet: distinct bytes sorted by descending frequency (ties by first
 * occurrence). `rank ^ 1` is the universal antiparallel involution (`compByte`),
 * so no ASCII/DNA literal is ever needed.
 */
export function symAlphabetFromList(list: ArrayLike<number>, context: SymContext): SymAlphabet {
  return symAlphabetBuild(Array.from(list), context)
}
function symAlphabetBuild(orderIn: number[], context: SymContext): SymAlphabet {
  const bits = context === 'sym-2bit' ? 2 : 5
  const limit = bits === 2 ? 4 : 32
  const order = orderIn
  if (order.length > limit) throw Error('低基数符号模式超出字母表上限')
  const symToByte = new Uint8Array(32), byteToSym = new Uint8Array(256), compByte = new Uint8Array(256)
  order.forEach((b, r) => { symToByte[r] = b; byteToSym[b] = r })
  for (let b = 0; b < 256; b++) compByte[b] = symToByte[byteToSym[b] ^ 1]
  return { k: order.length, bits, symToByte, byteToSym, compByte }
}
/** P19.1: canonical first-occurrence tie-break, independent of raw byte labels. */
function involutionChoice(data: Uint8Array, order: number[]): number {
  const scan = Math.min(data.length, 65536)
  if (scan < 10) return 1
  const rank = new Uint8Array(256)
  order.forEach((b, r) => { rank[b] = r })
  const fwd = new Set<number>()
  const hash = (i: number, tau: number): number => {
    let h = 0x811c9dc5
    for (let j = 9; j >= 0; j--) {
      const r = tau === 1 ? rank[data[i + j]] ^ 1 : tau === 2 ? rank[data[i + j]] ^ 2 : rank[data[i + j]] ^ 3
      h = Math.imul(h ^ (r + 1), 0x01000193)
    }
    return h >>> 0
  }
  for (let i = 0; i + 10 <= scan; i++) {
    let h = 0x811c9dc5
    for (let j = 0; j < 10; j++) h = Math.imul(h ^ (rank[data[i + j]] + 1), 0x01000193)
    fwd.add(h >>> 0)
  }
  let best = 1, bestHits = -1
  for (let tau = 1; tau <= 3; tau++) {
    let hits = 0
    for (let i = 0; i + 10 <= scan; i++) if (fwd.has(hash(i, tau))) hits++
    if (hits > bestHits) { bestHits = hits; best = tau }
  }
  return best
}


/** P19.2: canonical, non-zero internal byte keys for symbol modes. */
const CANON_SYM_BASE = 65
function canonicalModelMap(map: SymAlphabet): SymAlphabet {
  const order = Array.from({ length: map.k }, (_, i) => CANON_SYM_BASE + i)
  return symAlphabetBuild(order, map.bits === 2 ? 'sym-2bit' : 'sym-5bit')
}
function canonicalizeSymbols(data: Uint8Array, map: SymAlphabet): Uint8Array {
  const out = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = CANON_SYM_BASE + map.byteToSym[data[i]]
  return out
}

export function symAlphabetOf(data: Uint8Array, context: SymContext): SymAlphabet {
  const cnt = new Float64Array(256), first = new Int32Array(256).fill(-1)
  for (let i = 0; i < data.length; i++) {
    const b = data[i]
    if (cnt[b] === 0) first[b] = i
    cnt[b]++
  }
  const order: number[] = []
  for (let b = 0; b < 256; b++) if (cnt[b] > 0) order.push(b)
  order.sort((a, b) => cnt[b] - cnt[a] || first[a] - first[b])
  // P19.1: discover the antiparallel involution from the stream itself.  The
  // three fixed-point-free pairings are the only possibilities for K=4.
  if (context === 'sym-2bit' && order.length === 4) {
    const tau = involutionChoice(data, order)
    if (tau === 2) { const o = order.slice(); [o[1], o[2]] = [o[2], o[1]]; order.splice(0, order.length, ...o) }
    else if (tau === 3) { const o = order.slice(); [o[1], o[3]] = [o[3], o[1]]; order.splice(0, order.length, ...o) }
  }
  const sm = symAlphabetBuild(order, context)
  let min = Infinity
  for (const b of order) min = Math.min(min, cnt[b])
  sm.minCount = min
  return sm
}
/**
 * P18.4: distributional symbol tree. Symbols with similar left/right flanking
 * distributions become siblings, so the existing binary subdivision of each
 * 5-bit symbol is also a conservative amino-acid substitution tree. The result
 * is written into the ordinary 1+K symbol header, so decoding needs no change.
 */
function symContextOrder(data: Uint8Array, map: SymAlphabet): number[] {
  const K = map.k
  const clean = map.minCount !== undefined && map.minCount >= (data.length >>> 10)
  const identity = Array.from({ length: K }, (_, i) => map.symToByte[i])
  if (K < 4 || K > 32 || data.length < 3) return identity
  const rank = new Uint8Array(256)
  for (let r = 0; r < K; r++) rank[map.symToByte[r]] = r
  const L = new Float64Array(K * K), R = new Float64Array(K * K)
  let prev = rank[data[0]]
  for (let i = 1; i < data.length - 1; i++) {
    const a = rank[data[i]], next = rank[data[i + 1]]
    L[a * K + prev]++
    R[a * K + next]++
    prev = a
  }
  const vec = new Float64Array(2 * K * K)
  for (let a = 0; a < K; a++) {
    if (data.length > 2000000 && clean) {
      let sl = 0, sr = 0
      for (let x = 0; x < K; x++) { sl += L[a * K + x]; sr += R[a * K + x] }
      sl += K; sr += K
      let nl = 0, nr = 0
      for (let x = 0; x < K; x++) {
        const vl = Math.sqrt((L[a * K + x] + 1) / sl), vr = Math.sqrt((R[a * K + x] + 1) / sr)
        vec[a * 2 * K + x] = vl; vec[a * 2 * K + K + x] = vr
        nl += vl * vl; nr += vr * vr
      }
      nl = Math.sqrt(nl) || 1; nr = Math.sqrt(nr) || 1
      for (let x = 0; x < K; x++) { vec[a * 2 * K + x] /= nl; vec[a * 2 * K + K + x] /= nr }
    } else {
      let nl = 0, nr = 0
      for (let x = 0; x < K; x++) { nl += L[a * K + x] * L[a * K + x]; nr += R[a * K + x] * R[a * K + x] }
      nl = Math.sqrt(nl) || 1
      nr = Math.sqrt(nr) || 1
      for (let x = 0; x < K; x++) {
        vec[a * 2 * K + x] = L[a * K + x] / nl
        vec[a * 2 * K + K + x] = R[a * K + x] / nr
      }
    }
  }
  type Node = { members: number[]; c: Float64Array; left?: Node; right?: Node; dummy: boolean }
  let level: Node[] = []
  for (let a = 0; a < 32; a++) {
    const dummy = a >= K
    const c = new Float64Array(2 * K)
    if (!dummy) c.set(vec.subarray(a * 2 * K, (a + 1) * 2 * K))
    level.push({ members: dummy ? [] : [a], c, dummy })
  }
  const sim = (a: Node, b: Node): number => {
    if (a.dummy || b.dummy) return -2
    let d = 0
    for (let i = 0; i < a.c.length; i++) d += a.c[i] * b.c[i]
    return d
  }
  // Keep the tree perfectly balanced (32 leaves -> 5 bits) by pairing every
  // level. Dummy leaves carry K up to 32 without changing the bit depth.
  while (level.length > 1) {
    const used = new Uint8Array(level.length), next: Node[] = []
    for (let i = 0; i < level.length; i++) {
      if (used[i]) continue
      let bj = -1, bs = -Infinity
      for (let j = i + 1; j < level.length; j++) {
        if (used[j]) continue
        const v = sim(level[i], level[j])
        if (v > bs) { bs = v; bj = j }
      }
      if (bj < 0) { next.push(level[i]); used[i] = 1; continue }
      const c = new Float64Array(level[i].c.length)
      for (let q = 0; q < c.length; q++) c[q] = (level[i].c[q] + level[bj].c[q]) / 2
      let nn = 0
      for (let q = 0; q < c.length; q++) nn += c[q] * c[q]
      nn = Math.sqrt(nn) || 1
      for (let q = 0; q < c.length; q++) c[q] /= nn
      next.push({ members: [...level[i].members, ...level[bj].members], c, left: level[i], right: level[bj], dummy: level[i].dummy && level[bj].dummy })
      used[i] = used[bj] = 1
    }
    level = next
  }
  const order: number[] = []
  const walk = (n: Node) => {
    if (n.left) { walk(n.left); walk(n.right!) }
    else if (!n.dummy) order.push(n.members[0])
  }
  walk(level[0])
  return order.map(r => map.symToByte[r])
}
/**
 * v22 writer switch. Write-only: the decoder is driven purely by the container flag
 * (withContainerModel → containerModel.matchDistance), so flipping it can never
 * change how an existing stream is interpreted. Tests/archived replay turn it off
 * to reproduce the exact pre-v22 bytes.
 */
export const cmV22Tuning = { matchDist: true }
/** 实验开关：关闭 v15 的 8 字节长距匹配表（探针用）。 */
export let noMht8 = false
export function setNoMht8(v: boolean) { noMht8 = v }

/**
 * P8 诊断钩子（只读，不改一个比特）：
 *
 * `attribHook` 在 `encodeCMImpl` 每编完**一个字节**后被调用一次，参数是模型本身
 * 与该字节的算术编码比特数。探针据此把 -log2 P(y) 归因到“长匹配 / 高阶命中 /
 * 冷上下文 / 哈希碰撞”四个桶。为 null 时热路径只多一次分支判断。
 *
 * `modelBitsOverride` > 0 时强制上下文哈希表宽度（默认按输入长度自适应，
 * 默认超大组上限 2^24 槽）。用来实测“哈希碰撞到底吃掉多少字节”：把表放大到不再碰撞，
 * 输出体积的差就是碰撞的代价。默认 0 = 线上行为。
 */
export interface AttribModelView {
  pos: number; mlen: number; mptr: number; nctx: number
  idx: Int32Array; hashes: Int32Array; tables: Uint32Array[]; shift: number
  profile: string; isV15: boolean; geometry: CMTableShape
}
export let attribHook: ((m: AttribModelView, pos: number, bits: number) => void) | null = null
export function setAttribHook(fn: ((m: AttribModelView, pos: number, bits: number) => void) | null) { attribHook = fn }
export let modelBitsOverride = 0
export function setModelBitsOverride(bits: number) {
  // 0 = 关闭覆盖（线上自适应宽度）；其余值必须落在 10..26。
  if (bits !== 0 && (!Number.isInteger(bits) || bits < 10 || bits > 26)) throw new Error('modelBitsOverride 需为 0 或 10..26')
  modelBitsOverride = bits
}
// Research-only match variants. They are raw-CM experiments, not UCZ IDs.
export type MatchExperiment = 'single' | 'dual' | 'dual-distance'
export interface MatchStats { candidatesChecked:number; matchesStarted:number; olderWins:number; predictedBits:number; correctBits:number; distanceStarts:number[]; matchTableBytes:number }

export type Profile = 'o0' | 'o1' | 'text' | 'bin' | 'res' | 'res2d'

const SQ = [
  1, 2, 3, 6, 10, 16, 27, 45, 73, 120, 194, 310, 488, 747, 1101, 1546, 2047, 2549, 2994, 3348, 3607, 3785, 3901, 3975,
  4022, 4050, 4068, 4079, 4085, 4089, 4092, 4093, 4094,
]

export function squash(d: number): number {
  if (d > 2047) return 4095
  if (d < -2047) return 0
  const w = d & 127
  const i = (d >> 7) + 16
  return (SQ[i] * (128 - w) + SQ[i + 1] * w + 64) >> 7
}

const STRETCH = new Int16Array(4096)
;(() => {
  let pi = 0
  for (let x = -2047; x <= 2047; x++) {
    const v = squash(x)
    for (let i = pi; i <= v; i++) STRETCH[i] = x
    pi = v + 1
  }
  for (let i = pi; i < 4096; i++) STRETCH[i] = 2047
})()

// ===== APM / SSE（v15）=====
// 二级非线性校准层：线性混合出来的概率只是"各上下文预测的加权和"，
// 而真实条件概率对该和并非线性。PAQ/lpaq 的做法是在混合之后接一张
// 自适应概率映射表（APM / SSE）：把 stretch(pr) 量化到若干档，对每档
// 单独学习一个校准后的概率，再与原始预测按比例混合。
//
// 表结构：每个上下文 33 个 Uint16（0..65535 概率），用 q 与 q+1 线性插值。
// 33 = 32 段（stretch 的 -2047..2047 按 128 一档）+ 1 个右端点。
const APM_SLOTS = 33
/** 32 段 stretch 空间 → 33 个插值点：index = ((stretch+2048)*23)>>12。 */
const APM_SCALE = 23

/**
 * v15 校准层的可调参数。导出是为了让 `scripts/diag/probe-apm` 能在同一次
 * 进程里扫参（ctx 选哪种上下文、rate 多快、apm 占多少权重）。
 * 一旦定稿就应当固化成常量，不再从外部读取。
 */
/**
 * v15 的第二级 APM（a2）。第一级 a1 只按 c0（8 位）索引，看不到"上一个字节的
 * 类别"与"匹配状态"；a2 把这两者拼进上下文，等于让校准层知道"这是文本还是
 * 二进制、当前有没有匹配在跟着走"。
 * 上下文 = ((b1 >>> 5) << 9) | (mState << 8) | c0 → 2048 × 33 × 2 B ≈ 132 KiB，驻 L2。
 */
/**
 * a2 的适用面：只在 text / bin 上开。
 *
 * 依据（P5-1，`scripts/diag/probe-kernelab.ts` 与 `probe-a2prof.ts`）：
 *   * 2 MiB 端到端串行 A/B：mr（res2d）a1=408,321 / a1+a2=409,647（**+0.32%**），
 *     x-ray（res2d）a1=881,756 / a1+a2=882,701（**+0.11%**）——都是净回退；
 *   * 反过来，1D 残差（profile='res'，mozilla / samba / ooffice 的 DELTA_V3 段）
 *     在 a2 上是正收益（P5 关掉后全量反涨 1,722 B），所以只排除 res2d；
 *   * 1 MiB mr：202,818 → 203,290（+0.23%）。
 * 这与 P4-1 只在一个 text profile 上定标有关：res/res2d 的残差流里"上一字节
 * 类别 × 匹配状态"几乎没有判别力，a2 只是把 a1 的学习速度拖慢。
 */
function a2Eligible(profile: Profile, wordTokens = false): boolean {
  // P7-0：a2 在 1D 残差 'res' 上其实是净正收益，只有 res2d / o0 是净负。
  // 全量实测：mozilla / samba / ooffice 的 1D 残差段（DELTA_V3 s=2、
  // STRIDE4_DELTA、XOR_V3、SUB_ANCHOR_V3）开 a2 合计省 1,722 B。
  //
  // 但 x-ray 反过来：它的规则是 D16(s=1) / WIDE_GRAD(s=1)，内层同样是
  // `('res', 2, 1)`——与 DELTA_V3 s=2 **在 CM 层完全同形**，光看 profile 分不开。
  // 因此这里只按 profile 放开 'res'，由 codec 层按 **spec.id** 精确抑制
  // （D16 / WIDE_GRAD 一律不用 a2，见 a2Suppress）。编解码两侧都从 sp.id 推导，
  // 对称、无需改比特流格式、不碰 v13。
  return (profile === 'text' && (containerModel?.textOn ?? a2Tuning.textOn)
    && !(wordTokens && (containerModel?.wordPreTextOff ?? a2Tuning.wordPreTextOff))) || profile === 'bin'
    || (profile === 'res' && (containerModel?.resOn ?? a2Tuning.resOn))
}

/**
 * P9-2：上下文哈希表位宽上限。
 *
 * P8 §4.4 实测：表宽被硬钉在 2^21 时，4 MiB 切片的槽位碰撞率是 12 %~64 %；
 * 把上限提到 2^22，8 个文件在 4 MiB 上合计省 **70,221 B（0.59 %）**
 * （ooffice −19,201、dickens −11,205、osdb −9,544、webster −9,265、samba −8,067、
 * sao −8,005、mozilla −3,169、mr −1,765）。
 *
 * 21 = v15及更早；v17保留旧配置；v18记录22/23；v19记录24/23与显式mht4策略。
 * 表宽改变会让同一份数据的比特流完全不同，所以必须由容器版本告知解码端，
 * 见 codec.ts 的 `planHeader` / `decompress`。
 *
 * 内存：9上下文在22/23/24位时分别为144/288/576 MiB；并发预算必须覆盖此增长。
 */
export const LARGE_CM_MIN_BYTES = 512 * 1024
export const JUMBO_CM_MIN_BYTES = 4 * 1024 * 1024
export const HUGE_CM_MIN_BYTES = 8 * 1024 * 1024
/** P24.6：`bin` 的第三个上下文 `H[9] = hh(b2,b4,g(6))` 是 24 位稀疏哈希，
 * 冷启动要摊销一张新表，按 MDL 只有过半百 KiB 的流才回本。门槛是
 * 未压缩长度的单向下界，编码端用 `raw.length`、解码端用 `outLen`，两边必然一致，
 * 因此不新开协议位、不抬版本号，小流保持九上下文一字节不变。 */
export const BIN_TEN_MIN_BYTES = 64 * 1024
/**
 * P25.0: a `bin` stream whose synchronized `emaErr` stays above this level is
 * effectively incompressible (random lanes of P sit at ~16.3 K, while G peaks at
 * 15.5 K, O at 11.8 K and H's sparse outliers at 16.6 K for a handful of bytes).
 * Above the gate the sparse 3rd/4th-order contexts only spend mixer weight on
 * noise, so they are muted; this also removed the 11th context's cold-start cost
 * on P (272,702 -> 272,635 B).
 */
export const BIN_EMA_GATE = 15600
/**
 * P25.1: the twelfth slot costs another full 24-bit table, so it needs a longer
 * stream than the eleventh to amortise its cold start (measured: the 72 KB planner
 * canary loses its ANCHOR choice when it is enabled that early).
 */
export const BIN_TWELVE_MIN_BYTES = 256 * 1024
/** P25.2: the tenth `text-vertcol` slot only pays for itself past this length. */
export const TEXT_COL_WORD_MIN_BYTES = 64 * 1024

/** P25.3: 2-bit character-class history (digit/upper/lower/other) as a shape template. */
export const BIN_QUAD_ON = true
function shapeMask8(b1:number,b2:number,b3:number,b4:number,g5:number,g6:number,g7:number,g8:number) {
  return charShapeMask(b1,b2,b3,b4,g5,g6) | (charClass2(g7) << 12) | (charClass2(g8) << 14)
}
function charClass2(x:number) { return x>=48&&x<=57 ? 1 : x>=65&&x<=90 ? 2 : x>=97&&x<=122 ? 3 : 0 }
function fineShapeMask(b1:number,b2:number,b3:number,b4:number,g5:number,g6:number) {
  return charClass3(b1) | (charClass3(b2) << 3) | (charClass3(b3) << 6) | (charClass3(b4) << 9) | (charClass3(g5) << 12) | (charClass3(g6) << 15)
}
function charClass3(x:number) {
  return x>=48&&x<=57 ? 1 : x>=65&&x<=90 ? 2 : x>=97&&x<=122 ? 3 : (x===32||x===9) ? 4 : (x===10||x===13) ? 5 : (x===46||x===44||x===58||x===59) ? 6 : (x===45||x===43||x===47||x===95) ? 7 : 0
}
// P25.9: the bin 15th slot (8-byte coarse envelope) was measured and switched OFF:
// it won 253 B on the H_bcj slice but costs +15/+12 B on G/O slices and +61/+5 B on the
// full G/O files, and the zero-regression rule is absolute. Kept as a documented switch.

function binShape8(b1: number, b2: number, b3: number, b4: number, b5: number, b6: number, b7: number, b8: number): number {
  return ((b1 >>> 6) << 14) | ((b2 >>> 6) << 12) | ((b3 >>> 6) << 10) | ((b4 >>> 6) << 8) |
         ((b5 >>> 6) << 6) | ((b6 >>> 6) << 4) | ((b7 >>> 6) << 2) | (b8 >>> 6)
}
function nibbleMask6(b1: number, b2: number, b3: number, b4: number, b5: number, b6: number): number {
  return ((b1 >>> 4) << 20) | ((b2 >>> 4) << 16) | ((b3 >>> 4) << 12) |
         ((b4 >>> 4) << 8) | ((b5 >>> 4) << 4) | (b6 >>> 4)
}
function charShapeMask(b1: number, b2: number, b3: number, b4: number, g5: number, g6: number): number {
  const cls = (b: number): number => (b >= 48 && b <= 57 ? 1 : b >= 65 && b <= 90 ? 2 : b >= 97 && b <= 122 ? 3 : 0)
  return cls(b1) | (cls(b2) << 2) | (cls(b3) << 4) | (cls(b4) << 6) | (cls(g5) << 8) | (cls(g6) << 10)
}
export const modelTuning = { maxTableBits: 24, matchTableBits: 23, largeOnly: true }

/** Raw text and WORD-PRE keep a2 by default; saved flags retain legacy off policies. */
export const a2Tuning = { resOn: true, textOn: true, wordPreTextOff: false }

// UCZ v18 has its own wire namespace. NEVER interpret these as v17 flags.
// Diagnostic-only old global 21/22 + match20/21 policy. Not emitted by defaults.
// v19 extends the flags to a little-endian uint16; low v18 bits keep their labels.
// P11.1: only with an actual 24/23 feature. Old v19 without this bit keeps
// P11's expanded mht4; never silently reinterpret an existing v19 stream.
// v20 transform envelope; CM behavior is still v15 until a separate kernel flag.
/**
 * v22 container flag: at least one group uses the distance-split match model.
 *
 * Mechanism (generic, no data-specific tuning): a single-slot 4-gram table keeps
 * only the most recent occurrence of each 4-gram, so a 4-gram that recurs is
 * evicted by itself; and the 8-gram table cannot help below length 8, which leaves
 * repeats of length 4..7 unreachable. v22 keeps a second, older generation slot and
 * splits the match state table by quantized distance, because a match that resumes
 * 3 bytes away and one that resumes 3 MB away have very different reliability and
 * must not share a state. Cost: one extra Int32 per 4-gram slot and
 * 32x5 Uint16 state cells. Non-literal data measures exactly 0 B difference.
 */
const V22_FLAGS_MASK = CM_FLAGS_MASK | V21_FLAG_CONTEXTS | V22_FLAG_MATCH_DISTANCE
export const CM_FLAG_TABLE_24 = V19_FLAG_TABLE_24
export const CM_FLAG_MATCH_TABLE_23 = V19_FLAG_MATCH_23
export const CM_FLAG_BIG_TABLE = V18_FLAG_BIG_TABLE_22
export const CM_FLAG_TABLE_23 = V18_FLAG_TABLE_23
export const CM_FLAG_TEXT_A2_OFF = V18_FLAG_TEXT_A2_OFF
export const CM_FLAG_MATCH_TABLE_21 = V18_FLAG_MATCH_21
export const CM_FLAG_MATCH_TABLE_22 = V18_FLAG_MATCH_22
export const CM_FLAG_RES_A2_OFF = V18_FLAG_RES_A2_OFF
export const CM_FLAG_WORD_PRE_A2_OFF = V18_FLAG_WORD_PRE_A2_OFF
export interface ContainerModel {
  maxTableBits: number
  matchTableBits: number
  textOn: boolean
  resOn: boolean
  wordPreTextOff: boolean
  largeOnly: boolean
  groupSizing: boolean
  v19: boolean
  fixedMht4: boolean
  transformsV20: boolean
  kernelV20: boolean
  contextsV21: boolean
  binRecovery: boolean
  /** v22: distance-split match state + second-generation 4-gram slot. */
  matchDistance: boolean
  /**
   * v26: `matchDistance` is recomputed for every byte a match is live, not only when
   * a *new* match is started. v22..v25 left the stale value from the previous match in
   * place when a match was resumed by the 8-gram table or by gap recovery, so the
   * distance bucket could belong to a completely different match. Both sides compute
   * it identically, which is why it was only a compression loss, never a corruption.
   */
  matchDistanceFresh: boolean
  /** v23: strict zero-prior profile — no bitmap scanline prior is inferred. */
  strictPriors: boolean
  /** v24: the container ends with a CRC-32C of the decompressed payload. */
  checksum: boolean
}
const LEGACY_CONTAINER_MODEL: Readonly<ContainerModel> = Object.freeze({
  maxTableBits: 21, matchTableBits: 20, textOn: true, resOn: true,
  wordPreTextOff: false, largeOnly: false, groupSizing: false, v19: false, fixedMht4: true, transformsV20: false, kernelV20: false, contextsV21: false, binRecovery: false, matchDistance: false, matchDistanceFresh: false, strictPriors: false, checksum: false,
})
const V16_EXPERIMENTAL_MODEL: Readonly<ContainerModel> = Object.freeze({
  maxTableBits: 22, matchTableBits: 20, textOn: false, resOn: true,
  wordPreTextOff: false, largeOnly: false, groupSizing: false, v19: false, fixedMht4: true, transformsV20: false, kernelV20: false, contextsV21: false, binRecovery: false, matchDistance: false, matchDistanceFresh: false, strictPriors: false, checksum: false,
})
let containerModel: Readonly<ContainerModel> | null = null
/**
 * v23 strict zero-prior scope. The encoder sets this from the caller's option; the
 * decoder derives it from the container version, so both sides disable the same
 * priors. Everything the flag turns off is listed in PRIOR_REGISTRY.md.
 */
let strictPriorsFlag = false
export function setStrictPriors(on: boolean): () => void {
  const prev = strictPriorsFlag
  strictPriorsFlag = on
  return () => { strictPriorsFlag = prev }
}
export function strictPriorsOn(): boolean { return strictPriorsFlag || (containerModel?.strictPriors ?? false) }

let checksumFlag = false
/** v24 integrity trailer: enabled per operation, recorded as container version 24. */
export function setContainerChecksum(on: boolean): () => void {
  const prev = checksumFlag
  checksumFlag = on
  return () => { checksumFlag = prev }
}
export function containerChecksumOn(): boolean { return checksumFlag || (containerModel?.checksum ?? false) }
/** New encoders may try v20 transforms; old-container scopes may never decode them. */
export function transformsV20Enabled(): boolean { return containerModel?.transformsV20 ?? true }
let groupModelBytes = 0
let probeDepth = 0

/** Synchronous exploratory work: never inherits a large final-group model. */
export function withCMProbe<T>(fn: () => T): T {
  const saved = groupModelBytes
  groupModelBytes = 0; probeDepth++
  try { return fn() } finally { probeDepth--; groupModelBytes = saved }
}

/** Cache/config identity, NOT the final header; final payloads carry actual flags. */
export function encodingModelFlags(): number {
  if (![21, 22, 23, 24].includes(modelTuning.maxTableBits)
    || ![20, 21, 22, 23].includes(modelTuning.matchTableBits)
    || (!modelTuning.largeOnly && (modelTuning.maxTableBits > 22 || modelTuning.matchTableBits > 21))
    || typeof a2Tuning.textOn !== 'boolean' || typeof a2Tuning.resOn !== 'boolean'
    || typeof a2Tuning.wordPreTextOff !== 'boolean' || typeof modelTuning.largeOnly !== 'boolean'
    || typeof cmV20Tuning.enabled !== 'boolean' || typeof cmV20Tuning.binRecovery !== 'boolean'
    || modelBitsOverride !== 0) throw Error('不支持的容器模型配置')
  return (modelTuning.maxTableBits === 24 ? CM_FLAG_TABLE_24 : modelTuning.maxTableBits === 23 ? CM_FLAG_TABLE_23 : modelTuning.maxTableBits === 22 ? CM_FLAG_BIG_TABLE : 0)
    | (modelTuning.matchTableBits === 23 ? CM_FLAG_MATCH_TABLE_23 : modelTuning.matchTableBits === 22 ? CM_FLAG_MATCH_TABLE_22 : modelTuning.matchTableBits === 21 ? CM_FLAG_MATCH_TABLE_21 : 0)
    | (!a2Tuning.textOn ? CM_FLAG_TEXT_A2_OFF : 0)
    | (!a2Tuning.resOn ? CM_FLAG_RES_A2_OFF : 0)
    | (a2Tuning.wordPreTextOff ? CM_FLAG_WORD_PRE_A2_OFF : 0)
    | (!modelTuning.largeOnly ? V18_FLAG_UNSCOPED : 0)
    | (modelTuning.maxTableBits === 24 || modelTuning.matchTableBits === 23 ? V19_FLAG_MHT4_20 : 0)
    | (cmV20Tuning.enabled ? V20_FLAG_CM : 0) | (cmV20Tuning.binRecovery ? V20_FLAG_BIN_RECOVERY : 0)
}

/** Hard version split: v17 keeps its OWN old bit definitions and stream sizing. */
export function withContainerModel<T>(version: number, flags: number, fn: () => T): T {
  if (!Number.isInteger(version) || version < 1 || version > MAX_CONTAINER_VERSION) throw Error('不支持的 UCZ 格式版本')
  if ((version >= 17) && (!Number.isInteger(flags) || flags < 0
    || flags > (version === 17 ? 63 : version === 18 ? 255 : version === 19 ? 0x7ff : version === 20 ? CM_FLAGS_MASK : version === 21 ? CM_FLAGS_MASK | V21_FLAG_CONTEXTS : V22_FLAGS_MASK)
    || (version === 21 && (!(flags & V21_FLAG_CONTEXTS) || !(flags & V20_FLAG_CM)))
    || (version < 22 && !!(flags & V22_FLAG_MATCH_DISTANCE))
    || (version >= 20 && !!(flags & V20_FLAG_BIN_RECOVERY) && !(flags & V20_FLAG_CM))
    || (version >= 19 && !!(flags & V19_FLAG_MHT4_20) && !(flags & (V19_FLAG_TABLE_24 | V19_FLAG_MATCH_23)))
    || (version >= 18 && !!(flags & V18_FLAG_UNSCOPED) && !!(flags & (CM_FLAG_TABLE_23 | CM_FLAG_MATCH_TABLE_22 | CM_FLAG_TABLE_24 | CM_FLAG_MATCH_TABLE_23))))) {
    throw Error(`无效的 v${version} 模型配置`)
  }
  const model: Readonly<ContainerModel> = version >= 18 ? {
    maxTableBits: flags & CM_FLAG_TABLE_24 ? 24 : flags & CM_FLAG_TABLE_23 ? 23 : flags & CM_FLAG_BIG_TABLE ? 22 : 21,
    matchTableBits: flags & CM_FLAG_MATCH_TABLE_23 ? 23 : flags & CM_FLAG_MATCH_TABLE_22 ? 22 : flags & CM_FLAG_MATCH_TABLE_21 ? 21 : 20,
    textOn: !(flags & CM_FLAG_TEXT_A2_OFF), resOn: !(flags & CM_FLAG_RES_A2_OFF),
    wordPreTextOff: !!(flags & CM_FLAG_WORD_PRE_A2_OFF), largeOnly: !(flags & V18_FLAG_UNSCOPED), groupSizing: true, v19: version >= 19,
    transformsV20: version >= 20 && !!(flags & V20_FLAG_TRANSFORMS),
    kernelV20: version >= 20 && !!(flags & V20_FLAG_CM),
    contextsV21: version >= 21 && !!(flags & V21_FLAG_CONTEXTS),
    matchDistance: version >= 22 && !!(flags & V22_FLAG_MATCH_DISTANCE),
    matchDistanceFresh: containerHasFreshDistance(version),
    binRecovery: version >= 20 && !!(flags & V20_FLAG_BIN_RECOVERY),
    strictPriors: containerIsStrict(version),
    checksum: containerHasChecksum(version),
    fixedMht4: version === 18 || version >= 20 || !!(flags & V19_FLAG_MHT4_20),
  } : version === 17 ? {
    maxTableBits: flags & 0x01 ? 22 : 21,
    matchTableBits: flags & 0x04 ? 21 : 20,
    textOn: !(flags & 0x02), resOn: !(flags & 0x08),
    wordPreTextOff: !!(flags & 0x10), largeOnly: !!(flags & 0x20), groupSizing: false, v19: false, fixedMht4: true, transformsV20: false, kernelV20: false, contextsV21: false, binRecovery: false, matchDistance: false, matchDistanceFresh: false, strictPriors: false, checksum: false,
  } : version === 16 ? V16_EXPERIMENTAL_MODEL : LEGACY_CONTAINER_MODEL
  const prev = containerModel, prevGroup = groupModelBytes, prevProbe = probeDepth
  containerModel = model; groupModelBytes = 0; probeDepth = 0
  try { return fn() } finally { containerModel = prev; groupModelBytes = prevGroup; probeDepth = prevProbe }
}

/** Synchronous final-payload scope. NEVER wrap column/sample search in this. */
export function withCMBlockSize<T>(bytes: number, fn: () => T): T {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error('无效的 CM 分组长度')
  const prev = groupModelBytes
  groupModelBytes = bytes
  try { return fn() } finally { groupModelBytes = prev }
}

export interface CMTableShape {
  inputBytes: number; sizingBytes: number; cmBits: number; mht4Bits: number; mht8Bits: number
}
/** Pure arithmetic: boundary tests need neither a 4 MiB input nor a large allocation.
 * In v18, final TG/SUB channels inherit their complete group/block's size.
 * Below 512 KiB (or cap21), the original length-based allocation is unchanged. */
export function cmTableShape(n: number): CMTableShape {
  if (!Number.isSafeInteger(n) || n < 0) throw Error('无效的 CM 流长度')
  const configured = containerModel?.maxTableBits ?? modelTuning.maxTableBits
  const matchCap = containerModel?.matchTableBits ?? modelTuning.matchTableBits
  const largeOnly = containerModel?.largeOnly ?? modelTuning.largeOnly
  const groupSizing = containerModel?.groupSizing ?? true
  const wide = containerModel?.v19 ?? true
  const fixedMht4 = containerModel?.fixedMht4 ?? true
  const sizingBytes = n > 0 && largeOnly && groupSizing && !probeDepth ? (groupModelBytes || n) : n
  const tier = probeDepth ? 21 : wide && sizingBytes >= HUGE_CM_MIN_BYTES ? 24
    : sizingBytes >= JUMBO_CM_MIN_BYTES ? 23 : sizingBytes >= LARGE_CM_MIN_BYTES ? 22 : 21
  const cap = probeDepth ? Math.min(configured, 21) : largeOnly ? Math.min(configured, tier) : configured
  const geometryBytes = cap > 21 && groupSizing && largeOnly ? sizingBytes : n
  const bits = !containerModel && modelBitsOverride > 0 ? Math.min(modelBitsOverride, probeDepth ? 21 : 26)
    : Math.min(cap, Math.max(10, Math.ceil(Math.log2(Math.max(geometryBytes, 1) * 8)) + 1))
  const mht4Bits = Math.min(bits, probeDepth ? 20 : largeOnly ? (fixedMht4 ? 20 : Math.min(matchCap, tier - 1, 22)) : matchCap)
  const mht8Bits = Math.min(bits, probeDepth ? 20 : largeOnly ? Math.min(matchCap, tier - 1) : matchCap)
  return { inputBytes: n, sizingBytes, cmBits: bits, mht4Bits, mht8Bits }
}
export function cmTableBits(n: number): number { return cmTableShape(n).cmBits }

export const apm2Tuning = {
  /** 是否启用 a2 级联。 */
  on: true,
  /** a2 的自适应速率。 */
  rate: 5,
  /** a2 与 a1 输出的混合比：final = (a1out + w*a2out) / (1+w)。 */
  weight: 1,
  /**
   * a2 的上下文构成：
   *   0 = (b1>>>5, ms, c0)  2048 桶（默认，最细）
   *   1 = (ms, c0)           768 桶
   *   2 = (b1>>>6, ms)        12 桶（最粗，收敛最快）
   */
  ctx: 2,
}

/**
 * P6-2：v15 的**第二套细粒度混洗权重**（Dual-Context Mixer）。
 *
 * 主权重 `weightsAlt` 只有 24 组（bit × 匹配状态），看不到"前一个字节是什么类别"。
 * 辅权重按 profile 再分出 64 组（×8 个 bit = 512 组），初始为 0——因此**初始预测
 * 与 P5 完全相同**，只在其上叠加一个学习得到的修正项。
 *
 * 与双流等价性的关系：base 流（v13）只用 `weights`，一行没动；alt 流（v15）用
 * `altWeights + altWeights2`。单跑 v15 用 `weights + weights2`。两条路的点积顺序、
 * 初始值、学习率完全一致，所以 `encodeCMDual().alt ≡ encodeCM(...,'v15')`。
 */
export const mixer2Tuning = {
  /** 是否启用第二套混洗权重。 */
  on: true,
  /**
   * 辅权重的学习率。1 MiB 切片扫描（probe-mixer）：
   *   lr2=2 → dickens −0.15% / webster −0.20% / samba −0.23% / osdb −0.51% / ooffice −0.39%
   *   lr2=4 → 普遍略差；lr2=8 → dickens 反而 +0.08%
   * 取 2。
   */
  lr2: 2,
}

/**
 * Legacy v15 辅混洗只给 **bin**；v20 的 text/bin 策略在构造函数里单独固定。
 *
 * P6 的 text 上的收益只在 1~2 MiB 切片上成立（−0.10%~−0.17%），到全文件规模
 * 反而是轻微过拟合：P6 全量 webster +1,551 / dickens +899 / reymont +464 =
 * +2,914 B。原因很直接——text 的 `mctx2` 只看"前字节类别 × c0 低 2 位 × 匹配标志"
 * 这 6 位，词一级的结构它看不到，样本一多就把 5,120 个权重学成了噪声。
 * 收紧到 bin：mozilla / osdb / ooffice / samba 的 −76.1 KB 全部保住。
 */
function mixer2Eligible(profile: Profile): boolean {
  return profile === 'bin'
}

/**
 * P6-4：转置（列式）数据的 v15 内核**不用 a2、也不用辅混洗**。
 *
 * sao 全文件 7.25 MB 实测（v13 基线 3,750,881）：
 *   v15 + a2 + 混洗  3,750,867
 *   v15 无 a2 + 混洗  3,749,615
 *   v15 无 a2 无混洗  **3,748,319**（−2,562 B，−0.068%）
 * 转置把同列上下文摊平后，a2 的"上一字节类别 × 匹配状态"和辅混洗的"前字节类别"
 * 都是对同一信息的重复建模，纯粹在抢梯度。
 *
 * 这是**结构性**规则（spec 是转置族 + 内核是 v15），编解码双方各自推导，因此
 * 不需要在比特流里加标记位，也不会破坏 v13。
 */
export const transposeInnerSuppress = { depth: 0 }

/**
 * P7-0：按 **spec.id** 精确关掉 a2（D16 / WIDE_GRAD 行预测）。
 *
 * `xray2m` 切片实测：a2 开 882,701 / 关 881,756（−0.11%），整份 x-ray 差 4,479 B；
 * 而同样映射成 `('res', 2, 1)` 的 DELTA_V3（mozilla / samba / ooffice）开 a2 是正收益。
 * 两者在 CM 参数上不可区分，只能由 codec 层在 encode/decode 两侧按 sp.id 分别置位——
 * 结构性、对称推导，因此不需要任何标记位。
 */
export const a2Suppress = { depth: 0 }

export function mixer2Active(profile: Profile): boolean {
  return mixer2Tuning.on && transposeInnerSuppress.depth === 0 && mixer2Eligible(profile)
}

/**
 * P6-3：(a) bin profile 的 4 字节步长稀疏上下文（H[8] 换成 b4/b8 组合）；
 *        (b) v15 的断续匹配恢复（匹配被单字节差异打断后按原跨距重新对齐）。
 * 两者都只在 v15 且 useMatch / bin 的路径上生效，v13 比特流不受影响。
 */
export const match3Tuning = {
  /**
   * (a) H[8] 用 b1/b2/pos&3 + b4 + b8（false = P5 的 b1/b2/pos&3 + b4 + b5）。
   *
   * 实测（probe-match3，v15 内核）：
   *   1 MiB  mozilla −0.01% / samba −0.11% / osdb +0.01% / ooffice +0.07%
   *   2 MiB  mozilla −0.01% / samba −0.03% / osdb +0.02% / ooffice +0.06%
   * 四个文件**净负**，而且它会污染双流 v13 那条基线，默认关闭。
   */
  binCtx8: false,
  /**
   * (b) 断续匹配恢复。同样净负：
   *   1 MiB  mozilla 0 / samba +0.02% / osdb −0.11% / ooffice +0.02% / dickens +0.02%
   *   2 MiB  mozilla 0 / samba +0.02% / osdb −0.05% / ooffice +0.02%
   * 默认关闭；代码保留以便换语料复核。
   */
  gapResume: false,
  /** 中断后最多等多少字节。 */
  gapWait: 12,
}

export const apmTuning = {
  /** 0=全局单表 1=c0(256) 2=c0*3+匹配状态(768) 3=匹配状态(3) */
  ctx: 1,
  /** 自适应速率（右移位数），越小越快。 */
  rate: 5,
  /** APM 权重：final = (pr + w*apm) / (1+w)。 */
  weight: 1,
}

/** 文本类：把 b1 分成 8 类（控制符/空格/元音/辅音/大写/数字/标点/高位）。 */
function charClass8(c: number): number {
  if (c < 0x20) return 0
  if (c === 0x20) return 1
  if (c >= 0x61 && c <= 0x7a) return c === 0x61 || c === 0x65 || c === 0x69 || c === 0x6f || c === 0x75 ? 2 : 3
  if (c >= 0x41 && c <= 0x5a) return 4
  if (c >= 0x30 && c <= 0x39) return 5
  if (c < 0x80) return 6
  return 7
}

/** 二进制类：0x00 / 控制符 / ASCII / 高位。 */
function binClass4(c: number): number {
  return c === 0 ? 0 : c < 0x20 ? 1 : c < 0x80 ? 2 : 3
}

/** 残差幅值（把字节当有符号数看绝对值）。 */
function residualMag(c: number): number {
  return c < 128 ? c : 256 - c
}

function magClass8(c: number): number {
  const m = residualMag(c)
  return m === 0 ? 0 : m <= 2 ? 1 : m <= 4 ? 2 : m <= 8 ? 3 : m <= 16 ? 4 : m <= 32 ? 5 : m <= 64 ? 6 : 7
}

function magClass4(c: number): number {
  const m = residualMag(c)
  return m === 0 ? 0 : m <= 3 ? 1 : m <= 15 ? 2 : 3
}

function apm2CtxOf(prevByte: number, ms: number, c0: number): number {
  switch (apm2Tuning.ctx) {
    case 1: return ms * 256 + (c0 & 255)
    case 2: return ((prevByte >>> 6) & 3) * 3 + ms
    default: return (((prevByte >>> 5) & 7) << 9) | (ms << 8) | (c0 & 255)
  }
}

function apm2CtxCount2(): number {
  switch (apm2Tuning.ctx) {
    case 1: return 3 * 256
    case 2: return 4 * 3
    default: return 2048
  }
}

function apmCtxCount(): number {
  switch (apmTuning.ctx) {
    case 0: return 1
    case 1: return 256
    case 3: return 3
    default: return 256 * 3
  }
}

const DT = new Int32Array(256)
for (let n = 0; n < 256; n++) DT[n] = Math.floor(65536 / (n + 1.6))

// 仅用于展示的代价表(bit)
const COST = new Float32Array(4097)
for (let p = 1; p <= 4096; p++) COST[p] = -Math.log2(p / 4096)
COST[0] = 12

// 残差量化(整数阈值,保证确定性)
const QT = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96]
export const QV = new Uint8Array(256)
for (let v = 0; v < 256; v++) {
  const sv = v < 128 ? v : v - 256
  const a = Math.abs(sv)
  let q = 0
  for (const t of QT) if (a >= t) q++
  QV[v] = sv < 0 ? 14 + q : q
}

/**
 * FNV-style hash over up to six words, with missing arguments treated as 0.
 *
 * `h ^ 0 === h`, so every *trailing* zero argument is just a multiplication by
 * P = 0x01000193. Folding those into one final multiply removes up to five
 * `Math.imul` calls per hash — and most call sites pass only one to three words,
 * while this runs several times per input byte. The value is unchanged by
 * construction: P^k is exact mod 2^32, so `h * P^k` is the same integer.
 *
 * P17.2 also measured `Math.imul` itself: in an interpreter (QuickJS) it costs
 * about 35 % more than a plain multiply. Plain `*` is not a substitute here
 * because double rounding loses the low bits, so the multiply count is what we
 * reduce instead of the multiply kind.
 */
const FNV_P = 0x01000193
/** P^k mod 2^32 for k trailing zero words — applied with a single imul. */
const FNV_TAIL = [1, 0x01000193, 0x26027a69, 0x3ee6b34b, 0x502c3f11, 0x46a747c3].map(v => v | 0)

/** 32-bit integer mixer for the P17.7 column predictors (all inputs pre-packed). */
function mix32(x: number): number {
  let h = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  return (h ^ (h >>> 16)) | 0
}

/**
 * P25.6: two mixers over the same `inputs`, each with its own weight table chosen by a
 * coarse structural context (character/bin class, field column, alignment, match state,
 * MSB half). The dot products are averaged, which halves the estimator variance of the
 * primary mixer; the secondary table learns at the same rate because averaging already
 * damps the update. Costs 1024 × ninputs int32 (≈80 KiB) per model.
 */
const DUAL_MIXER_MIN_BYTES = 65536


function hh(a: number, b = 0, c = 0, d = 0, e = 0, f = 0): number {
  let h = 0x811c9dc5
  h = Math.imul(h ^ a, FNV_P)
  // Walk down from the highest supplied word, stopping at the last non-zero one.
  if (f !== 0) { h = Math.imul(h ^ b, FNV_P); h = Math.imul(h ^ c, FNV_P); h = Math.imul(h ^ d, FNV_P); h = Math.imul(h ^ e, FNV_P); h = Math.imul(h ^ f, FNV_P); return h }
  if (e !== 0) { h = Math.imul(h ^ b, FNV_P); h = Math.imul(h ^ c, FNV_P); h = Math.imul(h ^ d, FNV_P); h = Math.imul(h ^ e, FNV_P); return Math.imul(h, FNV_TAIL[1]) }
  if (d !== 0) { h = Math.imul(h ^ b, FNV_P); h = Math.imul(h ^ c, FNV_P); h = Math.imul(h ^ d, FNV_P); return Math.imul(h, FNV_TAIL[2]) }
  if (c !== 0) { h = Math.imul(h ^ b, FNV_P); h = Math.imul(h ^ c, FNV_P); return Math.imul(h, FNV_TAIL[3]) }
  if (b !== 0) { h = Math.imul(h ^ b, FNV_P); return Math.imul(h, FNV_TAIL[4]) }
  return Math.imul(h, FNV_TAIL[5])
}

const NCTX: Record<Profile, number> = { o0: 1, o1: 2, text: 7, bin: 8, res: 6, res2d: 8 }

/**
 * APM 校准的纯函数形式：给定上游 v13 概率、上下文与表，返回校准后的概率
 * 以及学习时需要的 (base, w)。`Model.step()` 与双流编码器共用这一份实现，
 * 保证两条路径逐位同构。
 */
function apmApply(pr: number, apmCtx: number, apmT: Uint16Array, weight = apmTuning.weight): { pr: number; base: number; w: number } {
  const st = STRETCH[pr & 4095]
  // (st+2048) ∈ [0,4095]；乘 23 后高 12 位是 0..32 档，低 12 位是插值权重。
  const pos = (st + 2048) * APM_SCALE
  let q = pos >> 12
  if (q > 31) q = 31
  const base = apmCtx * APM_SLOTS + q
  const w = pos & 4095
  // 表是 16 位概率，插值权重 4096 → (A*(4096-w)+B*w)>>16 正好落回 12 位。
  const apm = (apmT[base] * (4096 - w) + apmT[base + 1] * w) >> 16
  let out = (pr + weight * apm) / (1 + weight) | 0
  if (out < 1) out = 1
  else if (out > 4095) out = 4095
  return { pr: out, base, w }
}

function apmCtxOf(c0: number, ms: number): number {
  switch (apmTuning.ctx) {
    case 0: return 0
    case 1: return c0 & 255
    case 3: return ms
    default: return (c0 & 255) * 3 + ms
  }
}

class Model {
  private contextPeer?: Model
  buf: Uint8Array
  pos = 0
  c0 = 1
  bit = 0
  profile: Profile
  s: number
  r: number
  nctx: number
  ninputs: number
  get tblFrozen(): boolean { return vertTuning.freezeTbl && this.emaErr > vertTuning.thr }
  get dampShift(): number { return this.emaErr > vertTuning.thr2 ? 3 : 4 }
  shift: number
  hashes = new Int32Array(36)
  idx = new Int32Array(36)
  inputs = new Int32Array(36)
  // 每个上下文一张 32 位表：高 16 位是概率，低 8 位是更新计数。
  // 原实现用 Uint16Array + Uint8Array 两张表，同一槽位要两次随机访存；
  // 合并成一次读改写后，每比特的高延迟访存次数从 2·nctx 降到 nctx。
  tables: Uint32Array[]
  limit: number
  weights: Int32Array
  wbase = 0
  pr = 2048
  // match model
  useMatch: boolean
  minLen: number
  mht: Int32Array
  mhtOlder?: Int32Array
  /** P25.1: second older history table (`v20` only) — three-way candidate scan. */
  mhtO2?: Int32Array
  private matchTabs: Int32Array[] = []
  /**
   * v15 的 8 字节长距匹配表。4 字节哈希（mht）在 33 MB 跨度上会被高频短串
   * 碰撞覆盖，记不住几 MB 外的长重复块；8 字节上下文的碰撞率低几个数量级。
   * 只在 v15 且 useMatch 时分配。
   */
  mht8?: Int32Array
  mh8Shift = 0
  matchExperiment?: MatchExperiment
  /** v22, driven by CMOptions.matchDist and advertised through the container flag. */
  matchDistOn = false
  matchStats?: MatchStats
  matchDistance = 0
  /** v26: refresh the distance bucket on every live-match byte. */
  mdFresh = true
  mhShift: number
  mptr = 0
  mlen = 0
  mbyte = 0
  /** P6-3b：断续匹配——匹配中断时的跨距与剩余容忍步数。 */
  lastDist = 0
  gapLeft = 0
  msm = new Uint16Array(32).fill(49152)
  mIdx = -1
  mExpect = 0
  // word model
  wh = 0
  pwh = 0
  curWord = 0
  prevWord = 0
  prevPrevWord = 0
  context?: CMContext
  /** P26.0: set only for `ID.BCJ_V3` payloads — enables the x86-shaped 15th/16th contexts
   *  and the second/third mixer. Every other stream keeps its P25.9 behaviour exactly. */
  bcj?: boolean
  variant: CMVariant
  geomStride: number
  /** v15：APM/SSE 校准表（apmNctx × 33 个 16 位概率）。 */
  useApm = false
  apm2On = false
  apm2T!: Uint16Array
  apm2Base = 0
  apm2W = 0
  apm2Nctx2 = 0
  apmT!: Uint16Array
  apmNctx = 0
  apmBase = 0
  apmW = 0
  apmCtx = 0
  /** 本比特的匹配状态（0 无 / 1 短 / 2 长），APM 上下文的一部分。 */
  lastMs = 0
  /** 本比特校准**之前**的上游概率（v13 语义），双流编码的模型更新要用它。 */
  lastPr = 2048
  /**
   * 双流编码用的第二套混合权重（v13 语义）。
   * 只有 weights 在 v13 / v15 下不同构（误差项分别用上游概率与校准概率），
   * 而 tables / mht / msm 的演化只依赖上下文索引与真实比特，完全同构——
   * 所以双流只需各留一份 weights，其余状态共享。
   */
  altWeights!: Int32Array
  altWbase = 0
  altPr = 2048
  /** P6-2：v15 的细粒度辅混洗权重（64×8 组）与它们的学习索引。 */
  weights2?: Int32Array
  wbase2 = 0
  /** m2 上下文的"每字节固定部分"与低位部分（见 computeMix2）。 */
  m2hi = 0
  m2low = 0
  /** m2 是否取 c0 的低 2 位（text）／是否取匹配标志（text/bin）。 */
  m2UsesC0 = false
  m2UsesMs = true
  /** 是否 APM 内核（v15 或 v20；辅混合器仍有独立的存在性检查）。 */
  isV15 = false
  isV20 = false
  gapRecovery = false
  /** v20 `bin` 且流长达到 `BIN_TEN_MIN_BYTES`：启用第十个上下文。 */
  binTenOn = false
  /** v23: no bitmap scanline prior (see PRIOR_REGISTRY.md). */
  strictPriors = false
  /** P27.7: second word of history for the word trigram. */
  prev2Word = 0
  /** P28.5: causally detected scanline period for small `bin` blocks (0 = none). */
  scanPeriod = 0
  /** P28.8: the row above as a 10-bit window, aligned so that bit index 0..7
   * selects the three pixels {NW, N, NE} that sit directly above it. */
  scanUp10 = 0
  /** Two rows above, same alignment (`nnBit` selects one pixel). */
  scanNn = 0
  /** P28.2: hash of the first <=4 letters of the current token (prefix root). */
  curStem4 = 0
  /** P28.2: prefix root of the token that just ended. */
  prevStem4 = 0
  /** P28.2: hash of the last <=3 bytes of the token that just ended (inflection/unit tag). */
  prevSuffix = 0
  /** P28.2: letters seen in the current token (0 = not inside a word). */
  stemLen = 0
  /** P25.1: `bin` stream长到 `BIN_TWELVE_MIN_BYTES`，启用第十二个上下文。 */
  binLadderOn = false
  bcjOn = false
  dmOn = 0
  /** Secondary-mixer flavour chosen by `computeContexts` (0 = off, 2 = bin, 3 = bcj). */
  dmKind = 0
  /** Legacy gate flag of the 3-way mixer; 0 means "always on". */
  dmGate = 0
  /** Probe-only freeze hook of the vertcol experiments; false on every release path. */
  probeFreeze = false
  w1?: Int32Array
  w1base = 0
  w2?: Int32Array
  w2base = 0
  w3?: Int32Array
  w3base = 0
  w4?: Int32Array
  w4base = 0
  lastPrimaryMs = 0
  /** 双流模式：step() 额外算一遍 v13 权重，learn() 分别更新两套权重。 */
  dualPass = false
  /** 本比特未钳位的 squash 输出（APM 校准的输入）。 */
  rawPr = 2048
  /** 上一个完整字节（a2 的上下文用它的高 3 位类别）。 */
  prevByte = 0
  /**
   * WORD-PRE 词元模式：载荷里的 0x80..0xFF 是坍缩后的词元，不是原始字节。
   * 只有显式打开时 `byteUpdate` 才把高位字节当成词元，历史内核（v13/v2）不受影响。
   */
  wordTokens = false
  // ---- P17.7 'text-linecol' state -------------------------------------------
  // Column predictors for line-oriented / delimiter-structured text: every line
  // starts after '\n' with fields that tend to repeat or increment the
  // corresponding field of the previous line (<offset>:<id>:<title>). For the
  // first bytes of a line the 8-byte match window and orders 2..7 still straddle
  // the unique tail of the previous line, so those contexts are blind exactly
  // where the data is most predictable. These tables are tiny (256 + 8*64 bytes)
  // and are only allocated for this context.
  /** Byte offset since the last '\n' (0..255). */
  lineCol = 0
  /** Delimiter count since the last '\n' (0..7). */
  fieldIdx = 0
  /** Byte offset since the last '\n' or field delimiter (0..63). */
  fieldCol = 0
  /** Byte at `lineCol` on the previous line. */
  lineColBytes = new Uint8Array(0)
  /** Byte at `(fieldIdx << 6) | fieldCol` on the previous line. */
  fieldColBytes = new Uint8Array(0)
  /** Shift masks of recent line/field matches (low bit = most recent byte). */
  lineEqMask = 0xff
  fieldEqMask = 0xff
  // ---- P24 'text-vertcol' vertical predictor -------------------------------
  /** Learned P(next bit | previous-row/line byte, MSB-first prefix), 2 x 65536. */
  vertTbl?: Uint32Array
  /** Active table indices for this bit (-1 = predictor gated off). */
  vertIdx = -1
  vertIdx2 = -1
  /** P24.4 synchronized prediction-error EMA (identical in encoder and decoder). */
  byteErr = 0
  emaErr = 0
  /** P29.2: running count of ';' bytes, used to recognise semicolon tables. */
  semiCount = 0
  /** Non-P7 features actually used by this stream (not the global policy). */
  requiredFlags = 0
  geometry: CMTableShape

  constructor(n: number, profile: Profile, s: number, r: number, variant: CMVariant = false, geomStride = 0, matchExperiment?: MatchExperiment, matchStats?: MatchStats, wordTokens = false, options?: CMOptions, contextPeer?: Model) {
    this.contextPeer = contextPeer
    if (contextPeer) this.msm = contextPeer.msm
    this.context = options?.context
    if (this.context !== undefined) {
      if (!(() => { try { contextCodeOf(this.context!) ; return true } catch { return false } })() || variant !== 'v20'
        || (containerModel && !containerModel.contextsV21)
        || (this.context === 'bin-stride4' && (profile !== 'bin' || wordTokens))
        || (this.context === 'wide-geom' && (profile !== 'res2d' || geomStride <= 0 || wordTokens))
        || (this.context === 'text-sparse5' && (profile !== 'text' || geomStride !== 0 || wordTokens))
        || ((this.context === 'text-linecol' || this.context === 'text-lexcol' || this.context === 'text-tabcol' || this.context === 'text-vertcol') && (profile !== 'text' || geomStride !== 0 || wordTokens))
        || ((this.context === 'wp-token3' || this.context === 'wp-merge') && (profile !== 'text' || !wordTokens || geomStride !== 0)))
        throw Error('无效的 v21 CM 上下文 / profile / 格式标志')
      this.requiredFlags |= V21_FLAG_CONTEXTS
    }
    if (options?.matchDist) {
      // Residual profiles are excluded on principle, not by measurement alone:
      // their four-byte sequences collide through coincidence (all values near
      // zero) rather than through LZ repetition, so distance is not informative.
      // Probe encodes run with no container model pinned, so requesting matchDist
      // must be self-sufficient here: the container is what refuses an unrepresentable
      // payload, exactly as it does for every other model feature.
      if (variant !== 'v20' || (profile !== 'text' && profile !== 'bin'))
        throw Error('无效的 v22 matchDist / profile / 格式标志')
      this.matchDistOn = true
      this.mdFresh = containerModel ? containerModel.matchDistanceFresh : true
      // Mirror the context option: a payload asked for a v21 context must carry the
      // namespace flag itself, so priced headers match what the writer emits even
      // when this encoder is called directly rather than through a group wrapper.
      this.requiredFlags |= V22_FLAG_MATCH_DISTANCE | (options.context !== undefined ? V21_FLAG_CONTEXTS : 0)
    }
    this.matchExperiment = matchExperiment
    this.matchStats = matchStats
    if (!Number.isSafeInteger(geomStride) || geomStride < 0) throw Error('无效二维跨度')
    if (variant === 'v20' && containerModel && !containerModel.kernelV20) throw Error('v20 CM 缺少格式标志')
    this.isV20 = variant === 'v20'
    this.gapRecovery = this.isV20 ? profile === 'bin' && (containerModel?.binRecovery ?? cmV20Tuning.binRecovery) : variant === 'v15' && match3Tuning.gapResume
    this.variant = variant
    this.geomStride = geomStride
    // WORD-PRE 词元只对 v15 内核有意义：v13/v2 的比特流必须一字节不变。
    this.wordTokens = wordTokens && isAPMKernel(variant)
    if (this.context === 'text-linecol' || this.context === 'text-lexcol' || this.context === 'text-tabcol' || this.context === 'text-vertcol') {
      this.lineColBytes = new Uint8Array(256)
      this.fieldColBytes = new Uint8Array(8 * 64)
    }
    if (this.context === 'text-vertcol') this.vertTbl = new Uint32Array(2 * 65536).fill(32768 << 16)
    this.profile = profile
    this.s = Math.max(1, s)
    this.r = Math.max(1, r)
    this.buf = contextPeer?.buf ?? new Uint8Array(n + 1)
    const v3 = variant === 'v13' || isAPMKernel(variant)
    this.binTenOn = v3 && profile === 'bin' && variant === 'v20' && n >= BIN_TEN_MIN_BYTES
    // v23 strict zero-prior scope: no scanline period is inferred at all.
    this.strictPriors = strictPriorsOn()
    this.binLadderOn = this.binTenOn && n >= BIN_TWELVE_MIN_BYTES
    // P37.2：严格档只保留"原始字节滞后"上下文。H[10..13] 用 `b>>>2` / `b>>>3`
    // 做模拟量量化——那是在假设字节值的数值大小有意义，S256 置换后不再成立。
    if (this.strictPriors) { this.binTenOn = false; this.binLadderOn = false }
    this.bcjOn = v3 && variant === 'v20' && profile === 'bin' && !this.context && !!options?.bcj
    this.nctx = this.binLadderOn ? 13 : this.binTenOn ? 11
      : v3 ? (profile === 'res' ? 8 : profile === 'text' || profile === 'bin' || profile === 'res2d' ? 9 : NCTX[profile]) : variant && profile === 'text' ? 8 : NCTX[profile]
    // P25.2: `text-vertcol` spends a tenth slot on the word/column triple once the
    // stream is long enough. The counter stays the same nine-slot ladder otherwise.
    if (v3 && profile === 'text' && this.context === 'text-vertcol' && n >= TEXT_COL_WORD_MIN_BYTES) this.nctx = 12

    this.useMatch = profile === 'text' || profile === 'bin'
    this.minLen = profile === 'text' && !v3 ? 5 : 4
    // P9-2：表宽走 cmTableBits()，编码端与解码端共用同一个公式与同一个上限。
    this.geometry = cmTableShape(n)
    const sm = (options as any)?.symMap as SymAlphabet | undefined
    this.symBits = sm ? sm.bits : 8
    this.symAlphaK = sm ? sm.k : 256
    this.symToByte = sm ? sm.symToByte : null
    this.byteToSym = sm ? sm.byteToSym : null
    this.compByte = sm ? sm.compByte : null
    this.symKm9 = 0; this.symKm10 = 0; this.symDir = 1; this.symTbl = null
    // P18.2: the quaternary path uses the verified 17-mer multi-seed tracker.
    // sym-5bit keeps its original 8-mer seed/gate untouched.
    this.symDna = this.symBits === 2
    this.symProt = this.symBits === 5
    this.symSeedK = this.symDna ? 17 : 8
    this.symSeedGate = this.symDna ? 40 : 16
    this.symRc = this.symDna
    this.symExactOn = this.symDna || this.symProt
    this.symExactCut = this.symDna ? 5 : 3
    this.symMst = this.symDna || this.symProt
    this.symPrefix = this.symDna
    this.symMdir = this.symDna
    this.symSp4 = this.symDna
    this.symAlphabetK = sm ? sm.k : 20
    this.symP5Soft = this.symProt
    this.symP5Free = this.symProt
    this.symP5Coarse = this.symProt && this.context !== 'sym-5bit-gap'
    if (this.symProt) {
      this.symAepN = n
      this.symClean = sm?.k !== undefined && sm.k <= 21
      this.symSeedK2 = 8
      this.symSeedK = 8
      this.symSeedGate = 24
      this.symMM = 8
      this.symHyst = 2
      this.symPred = 2
      this.nctx = this.context === 'sym-5bit-gap' && this.symAepN > 3000000 ? 12 : 11
    }
    if (this.symProt) this.inputs = new Int32Array(this.nctx > 11 ? 16 : 12)
    // P18.2: the nine ladder lengths {2,3,4,5,6,7,8,9,11} are the winning
    // context ladder for quaternary streams (byte-identical in encoder/decoder).
    if (this.symDna) {
      this.symLadder = [2, 3, 4, 5, 6, 7, 9, 12, 0]
      this.symAepN = n
      this.symClean = false
    }
    const geo = this.geometry
    // P26.8/P26.9: the BCJ stream is a single 1 MB-1.3 MB executable image whose repeat
    // structure saturates a 22-bit table. It therefore gets a 24-bit table, affordable
    // only because P26.9 split the packed `(p << 16) | n` word into `tables` (u16
    // probability) + `counts` (u8 hit counter): 3 B/entry instead of 4 is 1.39 GiB for
    // 31 contexts instead of 1.86 GiB, and 24 bits is worth ~1.8 KiB on a 1 MiB x86 executable stream. `this.bcjOn` is
    // derived from `options.bcj` on BOTH sides (container v23 flag path), and
    // `requiredFlags` writes the width into the payload model flags, so the decoder
    // reconstructs exactly the same table without a container-format change.
    let bits = geo.cmBits
    if (this.bcjOn && n >= 524288 && bits < 23) bits = 23
    // P27.4: `text-vertcol` spends 16 sparse high-order contexts (word / column /
    // shape triples) on 1-3 MB text, but container v22 carries no table-width flag,
    // so `cmTableShape` clamped it to 21 bits and the sparse keys collided heavily.
    // `n` and the context are both known to the decoder, so the width needs no flag:
    // measured on the full streams 21 -> 23 bits is B -1,802, C -4,167, K -7,132 B
    // (rt=true throughout), at 16 x 32 MiB of tables.
    // P27.8: the 512 KiB cliff was the only reason 256-512 KiB prose and CSV files
    // (a 482 KiB prose file, a 427 KiB prose file, a 264 KiB numeric table
    // 264 KiB) starved on 21-bit tables: `text-vertcol` is offered from 256 KiB up by
    // `CONTEXT_SCREEN_MIN_BYTES`, but `cmTableShape` only reaches 22 bits at 512 KiB.
    // The tier is now smooth and, crucially, only applies to the real encode: trial
    // probes (`probeDepth`) keep their cheap 21-bit tables, which is what made the
    // planner re-plan (and regress large text streams by 5-8 KiB) whenever contexts grew.
    // P28.4: the plain v20 `bin` manifold (transpose lanes of `10.G`/`2.O`, 0.5-1.3 MB)
    // still ran on 22-bit tables while the BCJ stream already gets 23 bits. The
    // lanes are the same class of residual, so the tier is granted here too; it
    // stays final-encode only so planner trials keep their cheap tables.
    if (!probeDepth && v3 && variant === 'v20' && profile === 'bin' && !this.context && !this.bcjOn && n >= 524288 && bits < 23) bits = 23
    if (!probeDepth && v3 && variant === 'v20' && profile === 'text' && (options?.context === 'text-vertcol' || options?.context === 'text-tabcol')) {
      if (n >= 262144) { if (bits < 23) bits = 23 }
      else if (n >= 65536 && bits < 22) bits = 22
    }
    const { mht4Bits: mhBits, mht8Bits: mh8Bits } = geo
    const largeOnly = containerModel?.largeOnly ?? modelTuning.largeOnly
    if (bits > 23) this.requiredFlags |= CM_FLAG_TABLE_24
    else if (bits > 22) this.requiredFlags |= CM_FLAG_TABLE_23
    else if (bits > 21) this.requiredFlags |= CM_FLAG_BIG_TABLE
    this.shift = 32 - bits
    if (v3 && profile === 'text' && this.context === 'text-vertcol' && n >= TEXT_COL_WORD_MIN_BYTES) this.nctx = 14
    if (BIN_QUAD_ON && v3 && profile === 'bin' && this.binLadderOn) this.nctx = Math.max(this.nctx, 14)
    if (this.bcjOn) this.nctx = Math.max(this.nctx, 31)
    if (v3 && profile === 'text' && this.context === 'text-vertcol' && n >= TEXT_COL_WORD_MIN_BYTES) this.nctx = Math.max(this.nctx, 22)
    this.tables = []
    for (let i = 0; i < this.nctx; i++) {
      // 初值：概率 32768（居中），计数 0。
      this.tables.push(contextPeer && i < 8 ? contextPeer.tables[i] : new Uint32Array(1 << bits).fill(32768 << 16))
    }
    this.limit = profile === 'text' || profile === 'bin' ? 80 : 250
    this.ninputs = this.nctx + (this.vertTbl ? 4 : 2)
    const primaryGroups = this.isV20 ? 32 : 24 // 8 bits × 4 (or legacy 3) match states
    this.weights = new Int32Array(primaryGroups * this.ninputs)
    this.altWeights = new Int32Array(primaryGroups * this.ninputs)
    if (this.bcjOn) {
      // x86 instruction bytes are locally stationary in a way plain `bin` is not: the
      // secondary table keys on the two previous bytes' top 3 bits plus alignment, the
      // ternary one on the 4-byte (ModRM/SIB/dword) envelope.
      this.dmOn = 1
      this.dmKind = 2
      this.dmGate = 0
      this.w1 = new Int32Array(1024 * this.ninputs)
      this.w1.set(this.weights.subarray(0, this.ninputs))
      this.w2 = new Int32Array(1024 * this.ninputs)
      this.w2.set(this.weights.subarray(0, this.ninputs))
      this.w3 = new Int32Array(1024 * this.ninputs)
      this.w3.set(this.weights.subarray(0, this.ninputs))
      this.w4 = new Int32Array(1024 * this.ninputs)
      this.w4.set(this.weights.subarray(0, this.ninputs))
    }
    if (v3 && variant === 'v20' && n >= DUAL_MIXER_MIN_BYTES && (this.context === 'text-vertcol' || this.context === 'text-tabcol')) {
      this.dmOn = 1
      // Seeded below with the primary's initial weights so both dot products start
      // identical: the average then reproduces the single-mixer prediction exactly at
      // the start, and only the learning paths diverge.
      this.w1 = new Int32Array(1024 * this.ninputs)
      this.w2 = new Int32Array(1024 * this.ninputs)
    }
    const w0 = Math.floor((65536 * 1.2) / Math.max(this.nctx, 2))
    for (let set = 0; set < primaryGroups; set++) {
      for (let i = 0; i < this.nctx; i++) this.weights[set * this.ninputs + i] = w0
      this.weights[set * this.ninputs + this.nctx] = Math.floor(65536 * 0.4)
    }
    this.altWeights.set(this.weights)
    if (this.w1) this.w1.set(this.weights.subarray(0, this.ninputs))
    if (this.w2) this.w2.set(this.weights.subarray(0, this.ninputs))
    if (this.useMatch && mhBits > 21) this.requiredFlags |= CM_FLAG_MATCH_TABLE_22
    else if (this.useMatch && mhBits > 20) this.requiredFlags |= CM_FLAG_MATCH_TABLE_21
    this.mhShift = 32 - mhBits
    this.mht = contextPeer?.mht ?? new Int32Array(this.useMatch ? 1 << mhBits : 1)
    if (this.useMatch && isAPMKernel(variant) && !noMht8) {
      this.mht8 = contextPeer?.mht8 ?? new Int32Array(1 << mh8Bits)
      this.mh8Shift = 32 - mh8Bits
      if (mh8Bits > 22) this.requiredFlags |= CM_FLAG_MATCH_TABLE_23
      else if (mh8Bits > 21) this.requiredFlags |= CM_FLAG_MATCH_TABLE_22
      else if (mh8Bits > 20) this.requiredFlags |= CM_FLAG_MATCH_TABLE_21
    }
    if ((containerModel?.fixedMht4 ?? true) && (this.requiredFlags & (CM_FLAG_TABLE_24 | CM_FLAG_MATCH_TABLE_23)))
      this.requiredFlags |= V19_FLAG_MHT4_20
    if (!largeOnly && this.requiredFlags) this.requiredFlags |= V18_FLAG_UNSCOPED
    // v22 second-generation 4-gram slot: keeps the previous occurrence alive so a
    // 4-gram is not evicted by itself. Enabled by the serialized option, never by
    // the diagnostic experiment switch.
    if (this.matchDistOn) this.mhtOlder = new Int32Array(1 << mhBits)
    // P25.1: a 4-byte hash slot is overwritten by the next accidental collision, so
    // keep one more generation and pick the candidate with the longest verified
    // history (ties -> newest). Only `v20` streams get the extra table, keeping every
    // `v15` fixture byte-identical.
    else if (this.useMatch && matchExperiment && matchExperiment !== 'single') this.mhtOlder = new Int32Array(1 << mhBits)
    // P37.9：`mhtO2` is only ever *written* from `mhtOlder` (`mhtO2[h] = mhtOlder[h]`)
    // and otherwise read as all-zero, i.e. it contributes a candidate only when a
    // second match generation already exists. Allocating it when `mhtOlder` is absent
    // therefore bought 4 MiB per model of pure zeroes — keep it only when it can be
    // fed. Byte output is unchanged (a zero slot never wins the `older > 0` test).
    if (this.useMatch && this.isV20 && n >= BIN_TEN_MIN_BYTES && this.mhtOlder) this.mhtO2 = new Int32Array(1 << mhBits)
    this.matchTabs = [this.mhtOlder, this.mhtO2].filter((t): t is Int32Array => t !== undefined)
    if (this.symDna) this.msm = new Uint16Array(32 * 5 * 16).fill(49152)
    else if (this.symProt) this.msm = new Uint16Array(32 * 5 * 8).fill(49152)
    else if (this.matchDistOn || (this.useMatch && matchExperiment === 'dual-distance')) this.msm = new Uint16Array(32 * 5).fill(49152)
    if (matchStats) matchStats.matchTableBytes = this.mht.byteLength + (this.mhtOlder?.byteLength ?? 0) + (this.mhtO2?.byteLength ?? 0) + this.msm.byteLength
    if (this.isV20) {
      this.requiredFlags |= V20_FLAG_CM
      if (this.gapRecovery) this.requiredFlags |= V20_FLAG_BIN_RECOVERY
    }
    if (isAPMKernel(variant)) {
      this.isV15 = true
      // P6-2：细粒度辅混洗权重。64 个上下文组 × 8 bit × ninputs。
      if (this.isV20 ? transposeInnerSuppress.depth === 0 && (profile === 'bin' || profile === 'text') : mixer2Active(profile)) {
        this.weights2 = new Int32Array(64 * 8 * this.ninputs)
      }
      // 上下文 = c0（当前字节的部分前缀，0..255）× 匹配状态（0 无 / 1 短 / 2 长）。
      // 768 × 33 × 2 B ≈ 50 KiB，稳进 L2。
      this.useApm = true
      this.apmNctx = apmCtxCount()
      this.apmT = new Uint16Array(this.apmNctx * APM_SLOTS)
      for (let c = 0; c < this.apmNctx; c++) {
        const base = c * APM_SLOTS
        for (let j = 0; j < APM_SLOTS; j++) this.apmT[base + j] = squash((j - 16) * 128) * 16
      }
      // Record suppression only where P7 would actually run a2. Row predictors
      // and transpose-inner kernels already suppress it in P7: no configuration byte.
      if (n > 0 && apm2Tuning.on && transposeInnerSuppress.depth === 0 && a2Suppress.depth === 0) {
        if (profile === 'text') {
          if (!(containerModel?.textOn ?? a2Tuning.textOn)) this.requiredFlags |= CM_FLAG_TEXT_A2_OFF
          else if (this.wordTokens && (containerModel?.wordPreTextOff ?? a2Tuning.wordPreTextOff)) this.requiredFlags |= CM_FLAG_WORD_PRE_A2_OFF
        } else if (profile === 'res' && !(containerModel?.resOn ?? a2Tuning.resOn)) this.requiredFlags |= CM_FLAG_RES_A2_OFF
      }
      if (!this.symDna && !this.symProt && apm2Tuning.on && transposeInnerSuppress.depth === 0 && a2Suppress.depth === 0 && a2Eligible(this.profile, this.wordTokens)) {
        this.apm2On = true
        this.apm2Nctx2 = apm2CtxCount2()
        this.apm2T = new Uint16Array(this.apm2Nctx2 * APM_SLOTS)
        for (let c = 0; c < this.apm2Nctx2; c++) {
          const base = c * APM_SLOTS
          for (let j = 0; j < APM_SLOTS; j++) this.apm2T[base + j] = squash((j - 16) * 128) * 16
        }
      }
    }
    this.computeContexts()
  }

  private g(k: number): number {
    return this.pos - k >= 0 ? this.buf[this.pos - k] : 0
  }

  private computeMix2(b1:number,b2:number) {
    if (this.isV15 && this.weights2) {
      // 每组 6 位；低 3 位里 bit0 是匹配标志（text/bin），bit1-2 见下。
      if (this.profile === 'text') {
        this.m2hi = charClass8(b1) << 3
        this.m2low = 0
        this.m2UsesC0 = true
        this.m2UsesMs = true
      } else if (this.profile === 'bin') {
        this.m2hi = ((this.pos & 3) << 4) | (binClass4(b1) << 2)
        this.m2low = b1 === b2 ? 2 : 0
        this.m2UsesC0 = false
        this.m2UsesMs = true
      } else {
        this.m2hi = (magClass8(b1) << 3) | (magClass4(b2) << 1)
        this.m2low = b1 === b2 ? 1 : 0
        this.m2UsesC0 = false
        this.m2UsesMs = false
      }
    }
  }
  private computeGeometry(b1:number,b2:number) {
    const H=this.hashes
    if (this.variant && this.geomStride > 0 && (this.profile === 'bin' || this.profile === 'res2d')) {
      const R = this.geomStride
      const up = this.g(R), prev = this.pos >= R + 1 ? this.g(R + 1) : up
      const up2 = this.g(2 * R)
      H[6] = hh((b1 << 8) ^ up ^ (up2 << 16))
      H[7] = hh((b1 << 16) ^ (b2 << 8) ^ ((up - prev) & 255) ^ (up & 0xf0))
    }
  }

  /**
   * P28.5: 100% causal scanline period detector.
   *
   * Runs once over bytes that have already been coded (`this.buf[0..this.pos)`),
   * so encoder and decoder derive exactly the same value with no header bits.
   * Only *non-trivial* matches count: a match on a constant run
   * (`buf[j] === buf[j-1]`) is ignored, otherwise a block of `0x00` fill would
   * "prove" every period. A period is locked only when the match rate is far
   * above chance, which leaves random or code-like data untouched.
   */
  private detectScanPeriod(): void {
    const pos = this.pos
    if (this.scanPeriod !== 0) return
    // v23: the 2-D scanline family is a registered prior (PRIOR_REGISTRY.md §4);
    // the strict profile never infers it, and both sides agree because the flag is
    // carried by the container version.
    if (this.strictPriors) return
    // P28.6: a fax/bitmap segment pays 1-D cold start for every byte before the
    // lock, so the first checkpoint is at 1024 bytes (~4.7 scanlines of a 216-byte-wide fax bitmap).
    const early = pos === 1024
    if (!early && pos < 4096) return
    const win = Math.min(early ? 512 : 2048, pos)
    const maxP = early ? 256 : 512
    const from = pos - win
    let nonFlat = 0
    for (let j = from + 1; j < pos; j++) if (this.buf[j] !== this.buf[j - 1]) nonFlat++
    if (nonFlat < (early ? 64 : 256)) return
    // A 1-bit bitmap is dominated by white/black runs, i.e. by whole bytes of
    // 0x00 or 0xFF. Text, CSV and code are not, so this single statistic keeps
    // the 2-D path off every file where it has nothing to predict (small
    // semicolon-separated numeric tables regressed by 2-4 B without it).
    let flatBytes = 0
    for (let j = from; j < pos; j++) { const v = this.buf[j]; if (v === 0 || v === 0xff) flatBytes++ }
    if (flatBytes * 10 < win * 3) return
    let bestP = 0, bestN = 0
    for (let p = 16; p <= maxP && p < from; p++) {
      let hit = 0
      for (let j = from; j < pos; j++) if (this.buf[j] === this.buf[j - p] && this.buf[j] !== this.buf[j - 1]) hit++
      if (hit > bestN) { bestN = hit; bestP = p }
    }
    // A fax row is mostly flat runs, so only ~50% of the non-flat bytes can
    // repeat at the true period; a third is already ~1.5x the chance rate for a
    // 2-D-coded bitmap and leaves random data far below it.
    // A real scanline is at least 32 bytes wide. Without this floor `sum` locks
    // a spurious 16-byte period in its first kilobyte (0.60 match rate on
    // code bytes) and the 2-D templates cost it +370 B.
    if (bestP >= 32 && bestN >= (early ? 24 : 96) && bestN * 3 >= nonFlat) {
      if (bestP % 2 === 0 && bestP > 32) {
        let half = 0
        for (let j = pos - win; j < pos; j++) if (this.buf[j] === this.buf[j - (bestP >> 1)] && this.buf[j] !== this.buf[j - 1]) half++
        if (half * 10 >= bestN * 9) bestP >>= 1
      }
      this.scanPeriod = bestP
    }
  }

  private computeContexts() {
    // v26: the distance bucket describes the match that will predict THIS byte, so it is
    // derived here rather than carried over from whenever the match happened to start.
    if (this.mdFresh && this.matchDistOn && this.mlen > 0) {
      const d = this.pos - this.mptr
      this.matchDistance = d <= 16 ? 0 : d <= 256 ? 1 : d <= 4096 ? 2 : d <= 65536 ? 3 : 4
    }
    // P28.5: small `bin` blocks may be 2-D bitmaps (fax rows, 1-bit BMP). The
    // detector is causal and header-free; it runs only at power-of-two
    // boundaries (at most a handful of times per stream) and the size band keeps
    // the large transpose lanes (>= 512 KiB) on their tuned 1-D contexts.
    // P28.5: small `bin` blocks may be 2-D bitmaps (fax rows, 1-bit BMP). The
    // detector is causal and header-free; it runs only at power-of-two
    // boundaries (a handful of times per stream) and the size band keeps the
    // large transpose lanes (>= 512 KiB) on their tuned 1-D contexts.
    if (this.profile === 'bin' && !this.bcjOn && this.scanPeriod === 0 && this.pos >= 1024
      && (this.pos & (this.pos - 1)) === 0 && this.buf.length >= 4096 && this.buf.length <= 524289) this.detectScanPeriod()
    const H = this.hashes
    const b1 = this.g(1),
      b2 = this.g(2),
      b3 = this.g(3),
      b4 = this.g(4)
    if (this.isV20) this.computeMix2(b1,b2)
    if (this.variant === 'v13' || isAPMKernel(this.variant)) {
      const phase = this.pos % this.s, gs = this.g(this.s), gs2 = this.g(2*this.s)
      if (this.profile === 'res2d') {
        const gr=this.g(this.r),gnw=this.g(this.r+this.s),gne=this.r>this.s?this.g(this.r-this.s):gr
        H[0]=phase; H[1]=hh(phase,b1); H[2]=hh(phase,b1,b2); H[3]=hh(phase,gs); H[4]=hh(phase,gr)
        H[5]=hh(phase,QV[b1],QV[gs],QV[gr]); H[6]=hh(phase,gs,gr); H[7]=hh(phase,b1,gs,QV[gr]); H[8]=hh(phase,QV[gs],QV[gr],QV[gnw],QV[gne]); if(this.isV20)this.computeGeometry(b1,b2); return
      }
      if (this.profile === 'res') {
        H[0]=phase;H[1]=hh(phase,b1);H[2]=hh(phase,b1,b2);H[3]=hh(phase,gs);H[4]=hh(phase,QV[b1],QV[gs]);H[5]=hh(phase,gs,b1);H[6]=hh(phase,gs,gs2);H[7]=hh(phase,b1,QV[gs],QV[gs2]);return
      }
      if (this.profile === 'bin') {
        if (this.geomStride) {
          const S=this.geomStride,p=this.pos%S,a=this.g(S),a2=this.g(2*S),prev=this.g(S+1)
          H[0]=p;H[1]=hh(p,b1);H[2]=hh(p,b1,b2);H[3]=hh(p,b1,b2,b3);H[4]=hh(p,b1,b2,b3,b4);H[5]=hh(p,a);H[6]=hh(p,a,a2);H[7]=hh(p,b1,a);H[8]=hh(p,b1,(b1-prev)&255,a)
        } else {
          H[0]=0;H[1]=hh(b1);H[2]=hh(b1,b2);H[3]=hh(b1,b2,b3);H[4]=this.isV20?hh(b1,this.pos&3):hh(b1,b2,b3,b4);H[5]=hh(b1,b3);H[6]=hh(b3,b4);H[7]=hh(b1,b4)
          // P28.5: on a detected 2-D bitmap the two weakest slots (single byte,
          // byte pair) are replaced by the scanline cross — north `g(P)`,
          // north-west `g(P+1)`, north-east `g(P-1)` and two rows up `g(2P)`.
          // Nothing is spent when no period was found, so the slot budget and the
          // mixer layout stay exactly as they are for every other stream.
          if (this.scanPeriod > 0) {
            const np = this.scanPeriod, no = this.g(np), nw = this.g(np + 1), ne = this.g(np - 1)
            const nn = this.g(np << 1), nnn = this.g(np * 3)
            // P28.6: deeper JBIG-style templates. Slot 1 is the near horizon
            // (west + north-east/north-west), slot 2 the vertical spine, slot 4
            // the 2-D horizon, slot 5 the upper roof (three rows), slot 6 the
            // three-row vertical stroke. Measured on the four largest segments of a
            // segments: 29,870 -> 29,304 B versus keeping only slots 1/2, while
            // the pure diagonal variant (slot 7) was worse (29,420).
            // P28.7: a 1-bit bitmap packs eight horizontal pixels into every
            // byte, so a four-byte template hashes 32 pixels and misses whenever
            // an unrelated far pixel flips. The dense `(north, west)` pair has
            // exactly 2^16 states, and the halo/roof templates keep only the
            // pixels that physically touch the current byte: the low 4 bits of
            // `nw` (they touch `no`'s MSB) and the high 4 bits of `ne` (they
            // touch `no`'s LSB). Measured on the four largest bitmap segments:
            // full-byte templates 29,304 -> dense pair 27,195 -> this set 27,124.
            const halo = (nw & 15) | ((ne >>> 4) << 4)
            const roof = (nw & 7) | ((ne >>> 5) << 3) | ((b1 & 3) << 6)
            // `H[1]`/`H[2]` carry the same dense pair on purpose: two copies act
            // as a 2x weight on the strongest 2-D context, exactly like the
            // duplicated word-bigram slot in the text model.
            H[1] = hh(no, b1)
            H[2] = hh(no, b1)
            H[4] = hh(no, halo, b1)
            H[5] = hh(no, nn, roof)
            H[6] = hh(no, nnn, roof, b1)
            this.scanUp10 = ((nw & 1) << 9) | (no << 1) | (ne >>> 7)
            this.scanNn = nn
          }
          // P6-3a：v15 的稀疏上下文改用"4 字节步长"（b4）与"8 字节步长"（b8）：
          // 32 位定长指令 / 定长结构体里，当前字节与 pos-4、pos-8 强列相关。
          H[8]=this.isV20 ? (this.context === 'bin-stride4' ? hh(b4,this.g(8),this.g(12),this.pos&3) : hh(b2,b4)) : this.isV15 && match3Tuning.binCtx8
            ? hh((b1<<10)^(b2<<2)^(this.pos&3), b4, this.g(8))
            : hh((b1<<10)^(b2<<2)^(this.pos&3), b4, this.g(5))
          // P28.8: on a detected bitmap only four of fourteen slots were 2-D and
          // the 1-D skip-grams are near useless on a fax scanline. `H[9..13]` are
          // assigned further down (quad/ladder) so only these three survive; the
          // deeper variants measured identical sizes, i.e. exactly nothing.
          // Four largest bitmap segments: 27,124 -> 26,699 B.
          if (this.scanPeriod > 0) {
            const np = this.scanPeriod, no = this.g(np), nw = this.g(np + 1), ne = this.g(np - 1)
            const nn = this.g(np << 1), nnn = this.g(np * 3)
            const halo = (nw & 15) | ((ne >>> 4) << 4)
            H[3] = hh(no, halo, b1)
            H[7] = hh(no, nn, b1 & 15)
            H[8] = hh(no, nn, nnn)
          }
        }
        // P24.6: the tenth slot is only spent on streams long enough to amortise its
        // cold start; `bin-stride4` keeps its own layout and never reaches here.
        if(this.binTenOn) H[9]=hh(b2,b4,this.g(6))
        // P25.0: the eleventh slot is the quantized 3rd/6th/9th lag bundle — the
        // 2 LSBs of `b3` are analog quantisation noise on the waveform lanes, so
        // masking them lets the table learn the real trajectory; measured on
        // G_lane1 -364 B, H_bcj -2,052 B, O_mid -1,524 B, O1_lane1 -1 B.
        if(this.binTenOn) H[10]=hh(b3>>>2,this.g(6),this.g(9))
        // P25.0: high-entropy gate — identical integer `emaErr` on both sides.
        // P25.1: the twelfth slot takes the quantized consecutive waveform, which is
        // orthogonal to `H[10]`'s {3,6,9} lags: measured on G_lane1 -249 B, H_bcj
        // -1,661 B, O1_lane1 -135 B, O_mid -398 B when both slots exist.
        if(this.binLadderOn) H[11]=hh(b1>>>2,b2>>>2,b3>>>2)
        // P25.2: the thirteenth slot is the 5-bit-quantised 1..4 lag bundle. It is the
        // zero-regression winner of the 13A-13D screen (13B/13C/13D each gained on `H`
        // but lost 100-366 B on `G`/`O`): G_lane1 -111 B, H_bcj -640 B,
        // O1_lane1 -47 B, O_mid -146 B, P_seg0_lane0 0 B.
        if(this.binLadderOn) H[12]=hh(b1>>>3,b2>>>3,b3>>>3,b4>>>3)
        // P25.4: the even-stride quad with 5-bit quantization. P25.2's exact 32-bit key
        // gained 831 B on H_bcj but lost 114 B on G_lane1's noisy LSBs; shifting every
        // sample by 3 removes that noise and flips G to a gain as well.
        if(this.nctx>13) H[13]=hh(b2>>>3,b4>>>3,this.g(6)>>>3,this.g(8)>>>3)
        // P28.9: the 2-D overrides have to run AFTER the tenth/thirteenth-slot ladder,
        // which re-assigns `H[9..13]` further down the same branch — that is why the
        // P28.8 `H[9..13]` experiments measured exactly zero. Everything is inside
        // `scanPeriod > 0`, so every other stream is untouched.
        if (this.scanPeriod > 0) {
          const np = this.scanPeriod, no = this.g(np), nw = this.g(np + 1), ne = this.g(np - 1)
          // Reclaim the two ladder slots that exist at this size (64 KiB..256 KiB
          // models run `nctx = 11`, so only `H[9]`/`H[10]` are live; the larger
          // ladder slots are absent). `H[9]` alone costs 23 B, `H[10]` alone costs
          // 1 B, but the pair is worth 136 B: they are the only two slots that see
          // the north row *and* a horizontally adjacent run of pixels.
          if (this.binTenOn) H[9] = hh(no, b1, nw & 15)
          if (this.binTenOn) H[10] = hh(no, ne >>> 4, b1 & 15)
        }
        if(this.bcjOn && this.nctx>14) {
          // P26.0: x86-specific pair. `H[14]` is the 8-byte envelope of the top two bits
          // of each byte (instruction-class density), `H[15]` the 6-bit-quantised ladder
          // that pins displacement/immediate magnitude without its noisy low bits.
          H[14]=hh(binShape8(b1,b2,b3,b4,this.g(5),this.g(6),this.g(7),this.g(8)), b1, b2)
          if(this.nctx>15) H[15]=hh(b1, (b2>>>2)|((b3>>>2)<<6), (b4>>>2)|((this.g(5)>>>2)<<6), this.g(6)>>>2)
          if(this.nctx>16) {
            // P26.1: exact 5/6-gram (literal instruction+operand keys), the 6-nibble mask
            // (same key with the low nibbles — usually immediate data — erased), and the
            // "bridge" slot that skips one byte to read across a ModRM/SIB byte.
            // Slice screen: 5-gram -43 B, 6-gram -16 B, nibbleMask6 -71 B, bridge -14 B;
            // together with `W3` the full stream gains 2,631 B.
            H[16]=hh(b1,b2,b3,b4,this.g(5))
            if(this.nctx>17) H[17]=hh(b1,b2,b3,b4,this.g(5),this.g(6))
            if(this.nctx>18) H[18]=hh(nibbleMask6(b1,b2,b3,b4,this.g(5),this.g(6)), b1)
            if(this.nctx>19) H[19]=hh(b1,this.g(5),this.g(6),b2)
            if(this.nctx>20) H[20]=hh(b1,b2,this.g(5),this.g(6),this.g(7))
            if(this.bcjOn) {
              // P26.7: ModRM/SIB and immediate bridges. x86 encodings keep the opcode in
              // `b1` but spread the operands over ModRM/SIB plus 1 or 4 displacement bytes,
              // so the *next* instruction's opcode sits at a distance the fixed lags cannot
              // see. `H[21]` jumps a `disp32`, `H[22]`/`H[23]` jump a single ModRM/SIB byte
              // from either side, and `H[24]` keeps only the 5-bit register/opcode skeleton
              // so register renaming does not split the bucket.
              const g5=this.g(5), g6=this.g(6), g7=this.g(7), g8=this.g(8), frz=this.emaErr > BIN_EMA_GATE
              H[21]=frz?0:hh(b1,g6,g7,g8)
              H[22]=frz?0:hh(b1,b2,b4,g5,g6)
              H[23]=frz?0:hh(b1,b3,b4,g5)
              H[24]=frz?0:hh(b1,(b2>>>3)|((b3>>>3)<<5),(b4>>>3)|((g5>>>3)<<5),g6>>>3)
              // Phase-0: `disp32/imm32` bridges. The opcode that follows a 4-byte operand
              // sits at lag 5, and in `bcjMsbFwd` the E8/E9 target's sign byte is `b4`,
              // so both directions of the operand need their own jump.
              H[25]=frz?0:hh(b1,g5,g6,g7)
              H[26]=frz?0:hh(b4,g5,g6,g7)
              // Phase-2: the same jump for a two-byte prefix (REX/0F) in front of the operand.
              H[27]=frz?0:hh(b1,b2,this.g(7),this.g(8),this.g(9))
              H[28]=frz?0:hh(b1,b2,g6,g7,g8)
              // Strided skeleton and a two-sided prefix across the same displacement.
              H[29]=frz?0:hh(b1,b3,g5,g7)
              H[30]=frz?0:hh(b1,b2,b3,this.g(8),this.g(9))
            }
          }
        }
        if(this.binTenOn && this.emaErr > BIN_EMA_GATE) { H[3]=0; H[4]=0; H[9]=0; H[10]=0; if(this.binLadderOn){ H[11]=0; H[12]=0; H[13]=0; if(this.nctx>14){ H[14]=0; H[15]=0 } } }
        if(this.isV20)this.computeGeometry(b1,b2)
        if(this.context === 'bin-stride4') H[8]=hh(b4,this.g(8),this.g(12),this.pos&3)
        return
      }
      if(this.profile === 'text') {
        if (this.context === 'text-linecol' || this.context === 'text-lexcol' || this.context === 'text-tabcol' || this.context === 'text-vertcol') {
          // P17.8: `text-lexcol` is the source-code variant of the column model. It
          // keeps BOTH word slots (`word0 = hh(curWord,b1)` and the word bigram) and
          // spends the remaining two slots on the field/line hashes. `text-linecol`
          // keeps its P17.7 slot layout byte-for-byte: there the field hash is the
          // dominant source-code predictor (indentation column), and replacing it
          // with the word slot was measured to cost 1,298 B on AITDCC/B, so the two
          // layouts stay separate wire contexts and the group screen picks per file.
          const fPos = (this.fieldIdx << 6) | this.fieldCol
          const prevF = this.fieldColBytes[fPos]
          const prevL = this.lineColBytes[this.lineCol]
          H[0]=0;H[1]=hh(b1);H[2]=hh(b1,b2);H[3]=hh(b1,b2,b3);H[4]=hh(b1,b2,b3,b4)
          if (this.context === 'text-linecol') {
            const fieldHash = mix32((prevF | (this.fieldCol << 8) | (this.fieldIdx << 14) | ((this.fieldEqMask & 0x1f) << 17) | (b1 << 22)) | 0)
            const lineHash = (this.lineEqMask & 0x07) !== 0 && this.lineCol < 32
              ? mix32((prevL | (this.lineCol << 8) | (this.lineEqMask << 16) | (b1 << 24)) | 0)
              : hh(this.curWord, b1)
            H[5] = fieldHash
            H[6] = lineHash
            H[7] = hh(this.prevPrevWord, this.prevWord, this.curWord || b1)
            H[8] = hh(b1, b3, this.g(5))
            return
          }
          // P17.9: the lexical/tabular layouts put the CURRENT byte (`b1`) and the
          // PREDICTED column byte (`prevF`, `prevL`) in the discriminators instead of
          // hashing the column index into a high slot. `text-lexcol` (hybrid1) keeps a
          // constant word bigram in H[6]; `text-tabcol` (hybrid3) keeps that slot for
          // the conditional line hash and always spends H[8] on the field/line pair,
          // which wins on colon/tab delimited records (AITDCC C/K) while the constant
          // bigram wins on source code (B).
          const fieldHash = mix32((b1 | (prevF << 8) | (this.fieldIdx << 16) | ((this.fieldEqMask & 7) << 20)) | 0)
          const lineHash = mix32(((b2 | (prevF << 8) | (prevL << 16) | (Math.min(this.fieldCol, 63) << 24)) ^ Math.imul(this.fieldIdx, 2654435761)) | 0)
          const lineCond = (this.lineEqMask & 0x07) !== 0 && this.lineCol < 32
            ? mix32((prevL | (this.lineCol << 8) | (this.lineEqMask << 16) | (b1 << 24)) | 0)
            : hh(this.prevWord, this.curWord || b1)
          H[5] = hh(this.curWord, b1)
          H[6] = this.context === 'text-tabcol' || this.context === 'text-vertcol' ? lineCond : hh(this.prevWord, this.curWord || b1)
          H[7] = fieldHash
          H[8] = lineHash
          // P25.2: `text-vertcol` tenth slot — the word/column triple. Measured on the
          // direct `text` path: B -468 B, C -185 B, K -350 B; the 2D `hh(b1,prevF,prevL)`
          // variant gained on B but cost 70-190 B on C/K, and the 6-char template lost
          // on all three. Frozen (high-entropy) bytes keep the slot dark, like vertTbl.
          if (this.context === 'text-vertcol' && this.nctx > 9) H[9] = this.emaErr > vertTuning.thr ? 0 : hh(this.curWord ^ b1, this.prevWord, this.fieldIdx & 0xff)
          // P25.3: char-shape template (11th) and word trigram (12th). The shape mask
          // collapses every date/number/identifier of the same format into one context
          // (C -2,388 B, K -3,272 B, B -525 B); the trigram adds the second word of
          // history (another -208 B, and -195 B on top of the shape slot).
          if (this.context === 'text-vertcol' && this.nctx > 10) {
            const frz = this.emaErr > vertTuning.thr
            H[10] = frz ? 0 : hh(charShapeMask(b1,b2,b3,b4,this.g(5),this.g(6)), b1, this.fieldIdx & 0xff)
            if (this.nctx > 11) H[11] = frz ? 0 : hh(this.curWord ^ b1, this.prevWord, this.pwh ^ (this.fieldIdx & 0xff))
            // P25.4: 3-bit syntax shape (13th) and 8-byte coarse shape (14th). The 3-bit
            // classes finally separate `12.34` from `12\t34` from `12-34`, which the 2-bit
            // mask could not; the 8-byte mask is the same idea at twice the reach.
            if (this.nctx > 12) H[12] = frz ? 0 : hh(fineShapeMask(b1,b2,b3,b4,this.g(5),this.g(6)), (b1 << 8) | b2, this.fieldIdx & 0xff)
            if (this.nctx > 13) H[13] = frz ? 0 : hh(shapeMask8(b1,b2,b3,b4,this.g(5),this.g(6),this.g(7),this.g(8)), this.fieldIdx & 0xff, this.fieldCol & 0xff)
            // P25.9: 15th/16th slots — exact 3-gram keyed by the 2D table coordinate, and
            // the 3-generation word chain (curWord/prevWord/pwh) with the current byte.
            // Both are column-local views of a repeated template; the 3-gram pins the
            // literal while the word chain pins the identity. 256 KiB slice: B -158 B,
            // C -82 B, K -56 B, J -118 B, applied together.
            if (this.nctx > 14) {
              H[14] = frz ? 0 : hh(b1, b2, b3, (this.fieldIdx & 0xff) | (Math.min(this.fieldCol, 63) << 8))
              if (this.nctx > 15) H[15] = frz ? 0 : hh(this.curWord, this.prevWord, this.pwh, b1)
              // P27.5: the exact 5-gram/6-gram (17th/18th) and the two column-word
              // keys (19th/20th) only became affordable once P27.4 removed the 21-bit
              // ceiling — 20 sparse keys in 2M slots collided into noise. Measured on
              // the exact production streams (`matchDist` on, `bits = 23`): B -1,108 B,
              // C -872 B, applied together.
              if (this.nctx > 17) {
                const g5 = this.g(5), g6 = this.g(6)
                H[16] = frz ? 0 : hh(b1, b2, b3, b4, g5)
                H[17] = frz ? 0 : hh(b1, b2, b3, b4, g5, g6)
              }
              if (this.nctx > 19) {
                // P27.7: `H[18]` was P27.5's copy of the `H[15]` word bigram; the
                // second word of history is strictly more informative than the same
                // bigram twice (`pwh` only tracks the current word's prefix). The
                // 21st slot is the skip-`b3` template bridge, which is the one context
                // that paid on every 1-3 MB text file: B -859 B, C -272 B, K -290 B,
                // measured on the exact production streams at `bits = 23`.
                H[18] = frz ? 0 : hh(this.curWord, this.prevWord, this.prev2Word, b1)
                H[19] = frz ? 0 : hh(this.curWord, (this.fieldIdx & 0xff) | (Math.min(this.fieldCol, 63) << 8), this.prevWord)
                if (this.nctx > 21) H[21] = frz ? 0 : hh(this.curStem4, this.prevSuffix, this.prevStem4, b1)
                if (this.nctx > 20) H[20] = frz ? 0 : hh(b1, b2, b4, this.g(5), this.g(6))
              }
            }
          }
          return
        }
        if (this.symBits === 2 && this.symLadder) {
          for (let i = 0; i < 9; i++) H[i] = mix32((this.symK[this.symLadder[i]] + 1) * 2654435761 | 0)
          return
        }
        if (this.symProt) {
          H[0]=0;H[1]=hh(b1);H[2]=hh(b1,b2);H[3]=hh(b1,b2,b3);H[4]=hh(b1,b2,b3,b4)
          H[5]=hh(b1,b2,b3,b4,this.g(5)); H[6]=hh(b1,b3,b4); H[7]=this.context==='sym-5bit-gap' && this.symAepN > 2000000 ? hh(b1,b3,this.g(5)) : hh(b1,b2,b4); H[8]=hh(b1,b4,this.g(5))
          const b2s = this.byteToSym!
          if (this.mlen > 0) {
            const exp = b2s[this.buf[this.mptr]]
            H[9] = hh(exp + 1, this.symMMc > 0 ? 1 : 0, this.mlen < 4 ? this.mlen : 3)
            H[10] = hh(exp + 1, b2s[b1], this.mptr + 1 < this.pos ? b2s[this.buf[this.mptr + 1]] >> 2 : 8)
            if (this.nctx > 11) H[11] = (this.mptr > 0 && this.mptr + 1 < this.pos) ? hh(b2s[this.buf[this.mptr - 1]] + 1, exp + 1, b2s[this.buf[this.mptr + 1]] + 1) : 0
          } else {
            const bs = b2s
            H[9] = 0
            H[10] = this.symAepN > 262144
              ? hh(0x165667B1, b1, bs[this.g(2)] >> 2, bs[this.g(3)] >> 2, bs[this.g(4)] >> 2, bs[this.g(5)] >> 2) : 0
            if (this.nctx > 11) H[11] = this.symAepN > 2000000
              ? hh(0x9E3779B1, b1, bs[this.g(2)] >> 3, bs[this.g(3)] >> 3, bs[this.g(4)] >> 3, bs[this.g(5)] >> 3) : 0
          }
          return
        }
        H[0]=0;H[1]=hh(b1);H[2]=hh(b1,b2);H[3]=hh(b1,b2,b3);H[4]=hh(b1,b2,b3,b4);H[5]=hh(b1,b2,b3,b4,this.g(5),this.g(6));H[6]=this.symBits===2?mix32(this.symKm9):this.context==='sym-5bit-gap'?hh(b1,b2,b3,b4,this.g(5)):hh(this.curWord,b1);H[7]=this.symBits===2?mix32(this.symKm10):this.context==='sym-5bit-gap'?hh(b1,b2,b4,this.g(7),this.g(8)):hh(this.prevWord,this.curWord||b1);H[8]=this.context === 'wp-token3' ? hh(this.prevPrevWord,this.prevWord,this.curWord||b1) : this.context === 'text-sparse5' ? hh(b1,b3,this.g(5)) : hh(b1,b3,b4);return
      }
    }
    switch (this.profile) {
      case 'o0':
        H[0] = 0
        break
      case 'o1':
        H[0] = 0
        H[1] = hh(b1)
        break
      case 'text':
        if (this.strictPriors) {
          // P37.2：文本档的 H[6]/H[7] 用 `wh`/`pwh`（按字符类累加的单词哈希），
          // 那是 ASCII 字符类先验。严格档只留原始滞后上下文。
          H[0] = 0
          for (let i = 1; i < this.nctx; i++) H[i] = hh(b1, b2, b3, this.g(3 + i))
          break
        }
        H[0] = 0
        H[1] = hh(b1)
        H[2] = hh(b1, b2)
        H[3] = hh(b1, b2, b3)
        H[4] = hh(b1, b2, b3, b4)
        H[5] = hh(b1, b2, b3, b4, this.g(5), this.g(6))
        H[6] = hh(this.wh, this.pwh)
        if (this.variant) {
          H[6] = hh(this.curWord ^ (b1 << 8))
          H[7] = hh(this.prevWord ^ Math.imul(this.curWord || b1, 2246822519))
        }
        break
      case 'bin':
        H[0] = 0
        if (this.scanPeriod > 0) {
          // P28.5: 2D scanline neighbourhood. `g(P)` is the byte directly above
          // the current one, `g(P+1)` its north-west and `g(P-1)` its north-east
          // neighbour, `g(2P)` the row above that. A bitmap (fax, 1-bit BMP) is
          // strongly predicted by exactly this cross, which no 1-D context can
          // express.
          const np = this.scanPeriod, no = this.g(np), nn = this.g(np << 1)
          H[1] = hh(b1, no, this.g(np + 1), this.g(np - 1))
          H[2] = hh(no, nn, b1)
        } else {
          H[1] = hh(b1)
          H[2] = hh(b1, b2)
        }
        H[3] = hh(b1, b2, b3)
        H[4] = hh(b1, b2, b3, b4)
        H[5] = hh(b2)
        H[6] = hh(b3, b4)
        H[7] = this.variant && !this.geomStride ? hh((b1 << 10) ^ (b4 << 2) ^ (this.pos & 3)) : hh(b1, b4)
        break
      case 'res': {
        const gs = this.g(this.s)
        H[0] = 0
        H[1] = hh(b1)
        H[2] = hh(b1, b2)
        H[3] = hh(gs)
        H[4] = hh(QV[b1], QV[gs])
        H[5] = hh(gs, b1)
        break
      }
      case 'res2d': {
        const gs = this.g(this.s)
        const gr = this.g(this.r)
        H[0] = 0
        H[1] = hh(b1)
        H[2] = hh(b1, b2)
        H[3] = hh(gs)
        H[4] = hh(gr)
        H[5] = hh(QV[b1], QV[gs], QV[gr])
        H[6] = hh(gs, gr)
        H[7] = hh(b1, gs)
        break
      }
    }
    if (!this.isV20) { this.computeMix2(b1,b2); this.computeGeometry(b1,b2) }
  }


  /**
   * 字节级融合热路径：把原先每比特两次跨方法调用（p() + update()）合并成一次，
   * 并在字节循环外把所有只依赖模型拓扑的量（上下文槽位数、权重跨度、限幅值、
   * 各上下文表与计数表的引用）取成局部变量。
   *
   * 数值与比特流与 p()/update() 的组合**逐位等价**：仓内运算顺序、舍入
   * （| 0、>> 16 与 +0x8000 的偏置）、上下文哈希、匹配模型判定、上下文重算
   * 时机全部照搬，只是把重复的属性查找、跨界调用与数组解引用搬到了循环外。
   *
   * @param y 已编码/解码的比特；encode 为 true 时返回该比特的概率，否则返回算出的比特。
   */
  step(y: number, encode: boolean): number {
    const nctx = this.nctx, N = this.ninputs
    const hashes = this.hashes, idx = this.idx, inputs = this.inputs
    const tables = this.tables, weights = this.weights
    const STRETCH_l = STRETCH, shift = this.shift
    const useMatch = this.useMatch, msm = this.msm, symBits = this.symBits, byteToSym = this.byteToSym
    const matchExperiment = this.matchExperiment
    const matchDistOn = this.matchDistOn
    const useApm = this.useApm
    const apm2On = this.apm2On
    const apm2T = this.apm2T
    const dual = this.dualPass
    const apmT = this.apmT
    // P6-2：细粒度辅混洗（只作用于 v15 这条流，也就是双流里的主权重 `weights`）。
    const w2 = this.weights2
    const isV15 = this.isV15 && w2 !== undefined
    const m2hi = this.m2hi, m2low = this.m2low, m2UsesC0 = this.m2UsesC0, m2UsesMs = this.m2UsesMs
    const scanPer = this.scanPeriod, scanUp10 = this.scanUp10, scanNn = this.scanNn
    const mlenActive = this.mlen > 0 ? 1 : 0
    let apmBase = 0, apmW = 0, apmCtx = 0
    let apm2Base = 0, apm2W = 0
    let c0 = this.c0, bit = this.bit, pr = 0, wbase = 0, wbase2 = 0, mIdx = -1, mExpect = 0
    {
      const cm = Math.imul(c0, 0x9e3779b1)
      // 先把 9 个槽位算完，再做 9 次随机读：算索引只碰寄存器，
      // 而随机读是唯一的高延迟访存，集中起来更利于流水线重叠。
      const peer = this.contextPeer, first = peer ? 8 : 0
      if (peer) for (let i = 0; i < 8; i++) { idx[i] = peer.idx[i]; inputs[i] = peer.inputs[i] }
      for (let i = first; i < nctx; i++) {
        let h = Math.imul(hashes[i] ^ cm, 0x85ebca6b)
        h ^= h >>> 15
        idx[i] = h >>> shift
      }
      for (let i = first; i < nctx; i++) {
        inputs[i] = STRETCH_l[(tables[i][idx[i]] >>> 16) >>> 4]
      }
      let ms = 0, ms2 = 0
      if (useMatch && this.mlen > 0 && ((symBits < 8 ? (byteToSym![this.mbyte] | (1 << symBits)) : (this.mbyte | 256)) >> (symBits - bit)) === c0) {
        const eb = ((symBits < 8 ? (byteToSym![this.mbyte] | (1 << symBits)) : (this.mbyte | 256)) >> (symBits - 1 - bit)) & 1
        let reg = 0
        if (this.symExactOn && this.mlen >= (this.symProt ? 6 : 14)) {
          reg = this.symMMc === 0 && this.symExact >= this.symExactCut ? 2 : 1
        }
        const mi0 = (this.mlen > 31 ? 31 : this.mlen) + (matchDistOn || matchExperiment === 'dual-distance' ? this.matchDistance * 32 : 0)
        let mi = mi0
        if (this.symDna) {
          mi = ((mi0 * 4 + reg) * 2 + (this.symDir < 0 ? 1 : 0)) * 2 + (bit === 0 && this.symLastBitOk === 0 ? 1 : 0)
        } else if (this.symProt) {
          mi = (mi0 * 4 + reg) * 2 + (this.symP5Free && this.symMMc > 0 ? 1 : 0)
        }
        const st = STRETCH_l[msm[mi] >>> 4]
        inputs[nctx] = eb ? st : -st
        mIdx = mi
        mExpect = eb
        if ((this.symDna || this.symProt) && this.symMMc > this.symPred) inputs[nctx] = 0
        ms2 = this.mlen < 16 ? 1 : 2
        ms = this.isV20 ? ((this.symDna || this.symProt) ? reg : this.mlen < 6 ? 1 : this.mlen < 16 ? 2 : 3) : ms2
      } else {
        inputs[nctx] = 0
        if (this.symProt && this.symAepN > 1000000 && this.mlen > 0) ms = 4
      }
      const biasIdx = this.ninputs - 1
      inputs[biasIdx] = 256
      if (this.vertTbl) {
        // P24 vertical column predictor. `c0` is (1 << bit) | (prefix bits), so a
        // previous byte `p` has coded exactly the same MSB-first prefix iff
        // c0 === (1 << bit) | (p >>> (8 - bit)) (at bit 0 both sides equal 1).
        const vc0 = c0, vbit = bit
        const fPos = (this.fieldIdx << 6) | this.fieldCol
        const pf = this.fieldColBytes[fPos]
        const pl = this.lineColBytes[this.lineCol]
        // The key `(previous byte, c0)` already carries the prefix-match state:
        // c0's low `bit` bits are the prefix just coded, so `prefixOk` is a
        // deterministic function of the key. Feeding on every bit therefore lets
        // the table learn separate probabilities for match and mismatch, which
        // keeps the digit/character-class alignment signal of the row above alive
        // after the MSB prefix diverges.
        const okF = pf !== 0 && vc0 === ((1 << vbit) | (pf >>> (8 - vbit)))
        const okL = pl !== 0 && vc0 === ((1 << vbit) | (pl >>> (8 - vbit)))
        const ung = vertTuning.ungated
        const vfrz = this.tblFrozen
        if (!vfrz && pf !== 0 && (ung || okF)) { const k = (pf << 8) | vc0; this.vertIdx = k; inputs[nctx + 1] = STRETCH_l[(this.vertTbl[k] >>> 16) >>> 4] } else inputs[nctx + 1] = 0
        if (!vfrz && pl !== 0 && (ung || okL)) { const k = 65536 + ((pl << 8) | vc0); this.vertIdx2 = k; inputs[nctx + 2] = STRETCH_l[(this.vertTbl[k] >>> 16) >>> 4] } else inputs[nctx + 2] = 0
      }
      this.lastPrimaryMs = ms
      wbase = (bit * (this.symProt && this.symAepN > 1000000 ? 5 : this.isV20 ? 4 : 3) + ms) * N
      if (this.symDna && this.symAepClean) wbase = ((bit * 4 + ms) * 2 + (mIdx >= 0 && this.symMMc === 0 ? 1 : 0)) * N
      // 与 p() 相同的整数点积，按同样顺序累加以保证逐位一致。
      // P17.2: `inputs[N-1]` is the constant 256 bias, so its term is hoisted out
      // of the loop. Integer addition is associative and the loop order is
      // unchanged for the remaining terms, so the sum is bit-identical.
      let dot = weights[wbase + N - 1] * 256
      for (let i = 0, end = N - 1; i < end; i++) dot += weights[wbase + i] * inputs[i]
      if (this.dmOn) {
        const cls = (v: number) => (v >= 48 && v <= 57 ? 1 : v >= 65 && v <= 90 ? 2 : v >= 97 && v <= 122 ? 3 : 0)
        const mm = this.mlen > 0 ? 2 : 0, bb = bit >= 4 ? 1 : 0
        const g1 = this.g(1), g2 = this.g(2)
        const i1 = (this.profile === 'text'
          ? ((charClass3(g1) << 7) | (charClass3(g2) << 4) | (Math.min(this.fieldCol, 3) << 2) | mm | bb)
          : (((g1 >>> 5) << 7) | ((g2 >>> 5) << 4) | ((this.pos & 3) << 2) | mm | bb)) & 0x3ff
        const w1b = i1 * N
        this.w1base = w1b
        const w1l = this.w1!
        let d1 = w1l[w1b + N - 1] * 256
        for (let i = 0, end = N - 1; i < end; i++) d1 += w1l[w1b + i] * inputs[i]
        // Averaged estimators: the primary (full context ladder) plus coarse structural
        // views. Error falls as 1/n, and the spread across views shrinks.
        if (this.w2) {
          const i2s = this.profile === 'text'
            ? (((this.fieldIdx & 7) << 7) | (Math.min(this.fieldCol, 7) << 4) | (cls(g1) << 2) | mm | bb) & 0x3ff
            : ((((g1 >>> 6) << 8) | ((g2 >>> 6) << 6) | ((this.g(3) >>> 6) << 4) | ((this.g(4) >>> 6) << 2) | mm | bb)) & 0x3ff
          const w2b = i2s * N
          this.w2base = w2b
          const w2l = this.w2
          let d2 = w2l[w2b + N - 1] * 256
          for (let i = 0, end = N - 1; i < end; i++) d2 += w2l[w2b + i] * inputs[i]
          if (this.w4) {
            const i3s = this.bcjOn
              // The bit index (0..7) is worth more than the match flag on instruction
              // bytes: operands resolve byte-by-byte, so the mixer must know where in
              // the byte it is. 4 bits of g1 + 3 bits of g2 + 3 bits of `bit`, no overlap.
              ? ((((g1 >>> 4) << 6) | ((g2 >>> 5) << 3) | bit) & 0x3ff)
              : ((((g1 & 0xf0) << 2) | (g2 >>> 4) << 2) | mm | bb) & 0x3ff
            const w3b = i3s * N
            this.w3base = w3b
            const w3l = this.w3!
            let d3 = w3l[w3b + N - 1] * 256
            for (let i = 0, end = N - 1; i < end; i++) d3 += w3l[w3b + i] * inputs[i]
            const i4 = (((g2 >>> 4) << 6) | ((this.g(3) >>> 4) << 2) | mm | bb) & 0x3ff
            const w4b = i4 * N
            this.w4base = w4b
            const w4l = this.w4
            let d4 = w4l[w4b + N - 1] * 256
            for (let i = 0, end = N - 1; i < end; i++) d4 += w4l[w4b + i] * inputs[i]
            // P26.2: five normalised estimators. The old `(dot*2+d1+d2+d3)>>2` summed to
            // 5/4 of the average, inflating every probability table decision by 25%.
            dot = (dot + d1 + d2 + d3 + d4) >> 2
          } else if (this.w3) {
            const i3s = ((((g1 & 0xf0) << 2) | (g2 >>> 4) << 2) | mm | bb) & 0x3ff
            const w3b = i3s * N
            this.w3base = w3b
            const w3l = this.w3
            let d3 = w3l[w3b + N - 1] * 256
            for (let i = 0, end = N - 1; i < end; i++) d3 += w3l[w3b + i] * inputs[i]
            dot = (dot + d1 + d2 + d3) >> 2
          } else dot = (dot * 2 + d1 + d2) >> 2
        } else dot = (dot + d1) >> 1
      }
      if (isV15) {
        // 第二路：按"前字节类别 × 对齐相位 / c0 低位 × 匹配状态"再点积一次。
        // 权重初始为 0，因此初始预测与 P5 完全一致，只是叠加一个学习到的修正。
        let m2 = m2hi | m2low
        if (m2UsesC0) m2 |= (c0 & 3) << 1
        if (m2UsesMs) m2 |= mlenActive
        if (scanPer > 0) {

          // P28.8: five-pixel JBIG neighbourhood of the current bit — the three
          // pixels above {W, N, NE}, the pixel two rows up, and the pixel to the
          // west. It is invariant across byte boundaries, so the secondary mixer
          // selects one weight set per *pixel* instead of one per byte. The low
          // bit of `c0` refines it; the match flag and the bare bit index both
          // measured worse (26,198 / 25,946 versus 25,907 on the four segments).
          // P28.9: `bit` runs 0..7 with 0 = MSB, so the pixel column of the
          // current bit is `7 - bit`; the three pixels above it {NW,N,NE} are
          // scanUp10 bits [6-bit .. 8-bit]. P28.8 read [7-bit .. 9-bit], i.e. one
          // pixel too far right, and used the *last* bit index for the previous
          // byte's neighbour instead of the first.
          const up3 = (scanUp10 >>> (6 - bit)) & 7
          const nnb = (scanNn >>> (7 - bit)) & 1
          const wpx = bit === 0 ? (this.g(1) & 1) : (c0 & 1)
          // The full 6-pixel 64-state template `(up3 << 3) | (nnb << 2) | w2px`
          // measured 26,016 versus 25,863 for this 6-bit form: on bi-level bitmaps the two
          // west pixels are already carried by `H[1]=hh(no,b1)`, so spending the
          // extra w2 row slot only splits the table.
          m2 = (((((up3 << 2) | (nnb << 1) | wpx) << 1) | (c0 & 1))) & 63
        }
        wbase2 = ((m2 << 3) | bit) * N
        const w2l = w2 as Int32Array
        let d2x = w2l[wbase2 + N - 1] * 256
        for (let i = 0, end = N - 1; i < end; i++) d2x += w2l[wbase2 + i] * inputs[i]
        dot += d2x
      }
      if (dual) {
        // 双流：v13 用独立的第二套权重，同一批 inputs 再点积一次（只读访存）。
        const aw = this.altWeights
        let d2 = aw[wbase + N - 1] * 256
        for (let i = 0, end = N - 1; i < end; i++) d2 += aw[wbase + i] * inputs[i]
        let p2 = squash(Math.floor(d2 / 65536))
        p2 = p2 < 1 ? 1 : p2 > 4095 ? 4095 : p2
        this.altWbase = wbase
        this.altPr = p2
      }
      pr = squash(Math.floor(dot / 65536))
      // 记录"v13 语义"的上游概率：即 squash 输出经过钳位后的值。
      // 双流编码用它跑 v13 算术编码器、也用它做线性混合的误差项；
      // APM 校准拿的是钳位**之前**的原始值（与 P2 一致）。
      const upr = pr < 1 ? 1 : pr > 4095 ? 4095 : pr
      this.lastPr = upr
      this.rawPr = pr
      if (useApm) {
        // 二级校准：stretch(pr) → 32 段量化 → 线性插值查表 → 与 pr 混合。
        // 表项在 learn() 里按 (c0, 匹配状态) 分开学习，等于给"混合器输出"
        // 加一个随上下文变化的非线性修正。
        // 注意：校准拿的是 squash 的原始输出（0..4095），钳位在校准之后，
        // 顺序必须与 P2 完全一致，否则比特流会变。
        this.lastMs = ms2
        apmCtx = apmCtxOf(c0, ms2)
        const r = apmApply(pr, apmCtx, apmT)
        apmBase = r.base
        apmW = r.w
        pr = r.pr
        // 第二级：把 a1 的输出来喂 a2。上下文含上一个字节的高 3 位类别与匹配状态，
        // 让校准能区分"文本/二进制"和"是否有匹配置信"。
        if (apm2On) {
          const ctx2 = apm2CtxOf(this.prevByte, ms2, c0)
          const r2 = apmApply(pr, ctx2, apm2T, apm2Tuning.weight)
          apm2Base = r2.base
          apm2W = r2.w
          pr = r2.pr
        }
      } else pr = upr
    }
    if (this.binTenOn && this.emaErr > BIN_EMA_GATE) {
      // P25.1: same synchronized damping idea as `text-vertcol`, one step gentler
      // than the text gate. Measured on the incompressible P lane: -90 B.
      pr += (2048 - pr) >> 4
      if (pr < 1) pr = 1
      else if (pr > 4095) pr = 4095
    }
    if (this.vertTbl && (this.probeFreeze || vertTuning.damp) && this.emaErr > vertTuning.thr) {
      // High-entropy stream: the byte error EMA is computed with identical integer
      // math on both sides, so damping the final probability is bit-synchronized.
      pr += (2048 - pr) >> this.dampShift
      if (pr < 1) pr = 1
      else if (pr > 4095) pr = 4095
    }
    if (encode) {
      // 编码端：先把概率交回调用方做区间更新，再更新模型（顺序不影响结果）。
      this.c0 = c0; this.bit = bit; this.wbase = wbase; this.wbase2 = wbase2; this.mIdx = mIdx; this.mExpect = mExpect; this.pr = pr
      if (useApm) { this.apmBase = apmBase; this.apmW = apmW; this.apmCtx = apmCtx }
      if (apm2On) { this.apm2Base = apm2Base; this.apm2W = apm2W }
      return pr
    }
    // 解码端：先由调用方完成区间比较得到 y，再调用 update；这里只做写回。
    this.c0 = c0; this.bit = bit; this.wbase = wbase; this.wbase2 = wbase2; this.mIdx = mIdx; this.mExpect = mExpect; this.pr = pr
    if (useApm) { this.apmBase = apmBase; this.apmW = apmW; this.apmCtx = apmCtx }
    if (apm2On) { this.apm2Base = apm2Base; this.apm2W = apm2W }
    return y
  }

  /**
   * 与 update() 等价，但使用 step() 已写回的 wbase/mIdx/mExpect/pr，避免重复求解。
   *
   * @param prOverride 上游（v13）概率。双流编码时 `this.pr` 是校准后的 v15 概率，
   *   而线性混合权重的误差项必须用上游概率——两者不能混用，否则模型演化会分岔。
   */
  learn(y: number, prOverride?: number): void {
    const nctx = this.nctx, N = this.ninputs
    const inputs = this.inputs, idx = this.idx, weights = this.weights
    const tables = this.tables, limit = this.limit
    const err = ((y << 12) - (prOverride ?? this.pr)) * (this.symDna ? 2 : this.symProt ? (this.symAepN < 8192 ? 10 : 3) : 8)
    const wb = this.wbase
    for (let i = 0; i < N; i++) weights[wb + i] += (inputs[i] * err + (this.dmOn ? 0x4000 : 0x8000)) >> (this.dmOn ? 17 : 16)
    if (this.dmOn) {
      const w1l = this.w1!, w1b = this.w1base
      for (let i = 0; i < N; i++) w1l[w1b + i] += (inputs[i] * err + 0x4000) >> 17
      if (this.w2) {
        const w2l = this.w2, w2b = this.w2base
        for (let i = 0; i < N; i++) w2l[w2b + i] += (inputs[i] * err + 0x4000) >> 17
      }
      if (this.w3) {
        const w3l = this.w3, w3b = this.w3base
        for (let i = 0; i < N; i++) w3l[w3b + i] += (inputs[i] * err + 0x4000) >> 17
      }
      if (this.w4) {
        const w4l = this.w4, w4b = this.w4base
        for (let i = 0; i < N; i++) w4l[w4b + i] += (inputs[i] * err + 0x4000) >> 17
      }
    }
    if (this.dualPass) {
      // v13 的第二套权重：误差项用上游概率（不含辅混洗，保证 base 流不被污染）。
      const aw = this.altWeights, wb2 = this.altWbase
      const err2 = ((y << 12) - this.altPr) * 8
      for (let i = 0; i < N; i++) aw[wb2 + i] += (inputs[i] * err2 + 0x8000) >> 16
    }
    const w2 = this.weights2
    if (this.isV15 && w2) {
      // 辅权重用**校准后**的误差（与主权重一致），学习率减半。
      const err3 = ((y << 12) - (prOverride ?? this.pr)) * (this.isV20 ? 2 : mixer2Tuning.lr2)
      const wb3 = this.wbase2
      for (let i = 0; i < N; i++) w2[wb3 + i] += (inputs[i] * err3 + 0x8000) >> 16
    }
    if (this.symDna && this.bit === 1 && this.mIdx >= 0) this.symLastBitOk = this.mExpect === y ? 1 : 0
    const target = y ? 65535 : 0
    for (let i = this.contextPeer ? 8 : 0; i < nctx; i++) {
      const t = tables[i]
      const k = idx[i]
      const e = t[k]
      const p = e >>> 16
      const n = e & 255
      // 一次读、一次写：概率与计数打包在同一字里。
      t[k] = ((p + (((target - p) * DT[n]) / 65536 | 0)) << 16) | (n < limit ? n + 1 : n)
    }
    if (this.useApm) {
      // 插值表的标准 SGD：两端各按权重向目标移动，权重和恰好等于 1。
      const target = y ? 65535 : 0
      const base = this.apmBase, tw = this.apmT
      const a = tw[base]
      tw[base] = a + ((target - a) >> (apmTuning.rate + (this.symDna ? 2 : 0)))
      const b = tw[base + 1]
      tw[base + 1] = b + ((target - b) >> (apmTuning.rate + (this.symDna ? 2 : 0)))
      if (this.apm2On) {
        const t2 = this.apm2T, b2 = this.apm2Base
        const x2 = t2[b2]
        t2[b2] = x2 + ((target - x2) >> apm2Tuning.rate)
        const y2 = t2[b2 + 1]
        t2[b2 + 1] = y2 + ((target - y2) >> apm2Tuning.rate)
      }
    }
    if (this.binTenOn) {
      // P25.0: synchronized prediction-error accumulator for the high-entropy gate.
      this.byteErr += y ? (4096 - (prOverride ?? this.pr)) : (prOverride ?? this.pr)
    }
    if (this.vertTbl) {
      this.byteErr += y ? (4096 - (prOverride ?? this.pr)) : (prOverride ?? this.pr)
      const target = y ? 65535 : 0
      const lim = this.limit, t = this.vertTbl
      const vfrzLearn = this.tblFrozen
      const k1 = vfrzLearn ? -1 : this.vertIdx, k2 = vfrzLearn ? -1 : this.vertIdx2
      if (k1 >= 0) { const e = t[k1], p = e >>> 16, n = e & 255; t[k1] = ((p + (((target - p) * DT[n]) / 65536 | 0)) << 16) | (n < lim ? n + 1 : n) }
      if (k2 >= 0) { const e = t[k2], p = e >>> 16, n = e & 255; t[k2] = ((p + (((target - p) * DT[n]) / 65536 | 0)) << 16) | (n < lim ? n + 1 : n) }
      this.vertIdx = -1; this.vertIdx2 = -1
    }
    const mi = this.mIdx
    if (mi >= 0 && !this.contextPeer) {
      const ok = this.mExpect === y ? 65535 : 0
      if (this.matchStats) { this.matchStats.predictedBits++; if (ok) this.matchStats.correctBits++ }
      const q = this.msm[mi]
      this.msm[mi] = q + ((ok - q) >> 5)
    }
    this.c0 = (this.c0 << 1) | y
    this.bit++
    if (this.bit === (this.symBits < 8 ? this.symBits : 8)) {
      const byte = this.symBits < 8 ? this.symToByte![this.c0 & ((1 << this.symBits) - 1)] : (this.c0 & 255)
      this.buf[this.pos] = byte
      this.pos++
      this.c0 = 1
      this.bit = 0
      this.byteUpdate(byte)
    }
  }

  forcedZero(): boolean {
    if (!this.symProt || this.bit >= this.symBits) return false
    const b = this.symBits - 1 - this.bit
    const prefix = this.c0 & ((1 << this.bit) - 1)
    return ((prefix << (b + 1)) | (1 << b)) >= this.symAlphaK
  }

  skipZero(): void {
    this.c0 <<= 1
    this.bit++
    if (this.bit === this.symBits) {
      const byte = this.symToByte![this.c0 & ((1 << this.symBits) - 1)]
      this.buf[this.pos] = byte
      this.pos++
      this.c0 = 1
      this.bit = 0
      this.byteUpdate(byte)
    }
  }

  p(): number {
    const { nctx, inputs, idx, hashes, c0 } = this
    const cm = Math.imul(c0, 0x9e3779b1)
    for (let i = 0; i < nctx; i++) {
      let h = Math.imul(hashes[i] ^ cm, 0x85ebca6b)
      h ^= h >>> 15
      const k = h >>> this.shift
      idx[i] = k
      inputs[i] = STRETCH[(this.tables[i][k] >>> 16) >>> 4]
    }
    let ms = 0
    this.mIdx = -1
    if (this.useMatch && this.mlen > 0 && ((this.symBits < 8 ? (this.byteToSym![this.mbyte] | (1 << this.symBits)) : (this.mbyte | 256)) >> (this.symBits - this.bit)) === c0) {
      const eb = ((this.symBits < 8 ? (this.byteToSym![this.mbyte] | (1 << this.symBits)) : (this.mbyte | 256)) >> (this.symBits - 1 - this.bit)) & 1
      let reg = 0
      if (this.symExactOn && this.mlen >= (this.symProt ? 6 : 14)) {
        reg = this.symMMc === 0 && this.symExact >= this.symExactCut ? 2 : 1
      }
      const mi0 = (this.mlen > 31 ? 31 : this.mlen) + (this.matchDistOn || this.matchExperiment === 'dual-distance' ? this.matchDistance * 32 : 0)
      let mi = mi0
      if (this.symDna) {
        mi = ((mi0 * 4 + reg) * 2 + (this.symDir < 0 ? 1 : 0)) * 2 + (this.bit === 0 && this.symLastBitOk === 0 ? 1 : 0)
      } else if (this.symProt) {
        mi = (mi0 * 4 + reg) * 2 + (this.symP5Free && this.symMMc > 0 ? 1 : 0)
      }
      const st = STRETCH[this.msm[mi] >>> 4]
      inputs[nctx] = eb ? st : -st
      this.mIdx = mi
      this.mExpect = eb
      if ((this.symDna || this.symProt) && this.symMMc > this.symPred) inputs[nctx] = 0
      ms = this.symExactOn ? reg : this.mlen < 16 ? 1 : 2
    } else {
      inputs[nctx] = 0
    }
    inputs[nctx + 1] = 256
    const N = this.ninputs
    let wb = (this.bit * 3 + ms) * N
    if (this.symDna && this.symAepClean) wb = ((this.bit * 4 + ms) * 2 + (this.mIdx >= 0 && this.symMMc === 0 ? 1 : 0)) * N
    this.wbase = wb
    let dot = 0
    const w = this.weights
    for (let i = 0; i < N; i++) dot += w[wb + i] * inputs[i]
    let pr = squash(Math.floor(dot / 65536))
    if (pr < 1) pr = 1
    else if (pr > 4095) pr = 4095
    this.pr = pr
    return pr
  }

  update(y: number) {
    const { nctx, inputs, idx } = this
    const err = ((y << 12) - this.pr) * (this.symDna ? 2 : this.symProt ? (this.symAepN < 8192 ? 10 : 3) : 8)
    const N = this.ninputs
    const w = this.weights
    const wb = this.wbase
    for (let i = 0; i < N; i++) w[wb + i] += (inputs[i] * err + 0x8000) >> 16
    const target = y ? 65535 : 0
    for (let i = 0; i < nctx; i++) {
      const t = this.tables[i]
      const k = idx[i]
      const e = t[k]
      const p = e >>> 16
      const n = e & 255
      t[k] = ((p + (((target - p) * DT[n]) / 65536 | 0)) << 16) | (n < this.limit ? n + 1 : n)
    }
    if (this.mIdx >= 0) {
      const ok = this.mExpect === y ? 65535 : 0
      if (this.matchStats) { this.matchStats.predictedBits++; if (ok) this.matchStats.correctBits++ }
      const q = this.msm[this.mIdx]
      this.msm[this.mIdx] = q + ((ok - q) >> 5)
    }
    this.c0 = (this.c0 << 1) | y
    this.bit++
    if (this.bit === (this.symBits < 8 ? this.symBits : 8)) {
      const byte = this.symBits < 8 ? this.symToByte![this.c0 & ((1 << this.symBits) - 1)] : (this.c0 & 255)
      this.buf[this.pos] = byte
      this.pos++
      this.c0 = 1
      this.bit = 0
      this.byteUpdate(byte)
    }
  }

  /**
   * Advance the line/field column predictors with the byte that was just coded.
   * The predictors themselves are READ in `computeContexts` (which runs at the
   * end of `byteUpdate`), so the order here is: score against the previous
   * line's byte at this column, then store this byte for the next line.
   */
  private updateLineCol(byte: number) {
    const fPos = (this.fieldIdx << 6) | this.fieldCol
    const matchedLine = byte === this.lineColBytes[this.lineCol] ? 1 : 0
    const matchedField = byte === this.fieldColBytes[fPos] ? 1 : 0
    if (byte === 59) this.semiCount++
    this.lineColBytes[this.lineCol] = byte
    this.fieldColBytes[fPos] = byte
    if (byte === 10) {
      this.lineCol = 0; this.fieldIdx = 0; this.fieldCol = 0
      this.lineEqMask = 0xff; this.fieldEqMask = 0xff
    } else if (byte === 58 || byte === 9 || byte === 44 || (byte === 59 && this.semiCount * 8 >= this.pos + 1)) {
      this.lineCol = (this.lineCol + 1) & 0xff
      this.lineEqMask = ((this.lineEqMask << 1) | matchedLine) & 0xff
      this.fieldIdx = Math.min(7, this.fieldIdx + 1)
      this.fieldCol = 0
      this.fieldEqMask = 0xff
    } else {
      this.lineCol = (this.lineCol + 1) & 0xff
      this.lineEqMask = ((this.lineEqMask << 1) | matchedLine) & 0xff
      this.fieldCol = Math.min(63, this.fieldCol + 1)
      this.fieldEqMask = ((this.fieldEqMask << 1) | matchedField) & 0xff
    }
  }

  symBits = 8
  symAlphaK = 256
  symToByte: Uint8Array | null = null
  byteToSym: Uint8Array | null = null
  compByte: Uint8Array | null = null
  symKm9 = 0
  symKm10 = 0
  symDir = 1
  symTbl: Int32Array | null = null
  symSeedK = 14
  symProt = false
  symP5Soft = false
  symP5Free = false
  symP5Coarse = false
  symTblC: Int32Array | null = null
  symExact = 0
  symExactCut = 3
  symExactOn = false
  symMst = false
  symPrefix = false
  symLastBitOk = 0
  symMdir = false
  symSp4 = false
  symSeedK2 = 8
  symAlphabetK = 20
  symTblL4: Int32Array | null = null
  symTblL5: Int32Array | null = null
  symTblL6: Int32Array | null = null
  symSeedGate = 40
  symRc = false
  symDna = false
  symMM = 10
  symPred = 2
  symHyst = 2
  symMMc = 0
  symLocalFlag = false
  symTblS: Int32Array | null = null
  symTblG: Int32Array | null = null
  symTblL: Int32Array | null = null
  shadowDelta = 0
  shadowUntil = 0
  symK = new Int32Array(16)
  symLadder: number[] | null = null
  symAepN = 0
  symClean = false
  symAepPos = 0
  symAepDone = false
  symAepClean = false
  symAepCounts = new Int32Array(4)
  private byteUpdate(byte: number) {
    if (this.binTenOn) {
      // P25.0: encoder and decoder run the same integer math on the same (y, pr)
      // stream, so `emaErr` is bit-identical on both sides and the gate is safe.
      this.emaErr = this.emaErr - (this.emaErr >> 5) + (this.byteErr >> 5)
      this.byteErr = 0
    }
    if (this.vertTbl) {
      // Identical integer math on both sides, so the gate below is synchronized.
      this.emaErr = this.emaErr - (this.emaErr >> 5) + (this.byteErr >> 5)
      this.byteErr = 0
    }
    if (this.symBits < 8) {
      const r = this.byteToSym![byte]
      if (this.symDna && !this.symAepDone) {
        this.symAepCounts[r]++
        if (++this.symAepPos === 4096) {
          let h = 0
          for (let i = 0; i < 4; i++) {
            const q = this.symAepCounts[i] / 4096
            if (q > 0) h -= q * Math.log2(q)
          }
          const n = this.symAepN || 0
          const kstar = n > 0 && h > 0 ? Math.log2(n) / h : 0
          this.symAepClean = kstar >= 12.3
          if (kstar >= 12.3) this.symLadder = [2, 3, 4, 5, 7, 9, 12, 14, 0]
          this.symAepDone = true
        }
      }
      this.symKm9 = ((this.symKm9 << 2) | r) & 0x3ffff
      this.symKm10 = ((this.symKm10 << 2) | r) & 0xfffff
      for (let o = 1; o <= 15; o++) this.symK[o] = ((this.symK[o] << 2) | r) & (o === 15 ? 0x3fffffff : (1 << (2 * o)) - 1)
    }
    // P24.4: on a high-entropy run the row/word tracker is fed random bytes, which
    // only pollutes the real column statistics. `emaErr` is synchronized, so both
    // sides freeze on exactly the same byte.
    const frozen = this.vertTbl !== undefined && vertTuning.freeze && this.emaErr > vertTuning.thr
    if (this.context === 'text-linecol' || this.context === 'text-lexcol' || this.context === 'text-tabcol' || (this.context === 'text-vertcol' && !frozen)) this.updateLineCol(byte)
    // P37.8：严格档禁用一切"字母/词"概念。`text-*` 布局本身还是合法候选（它只是
    // 按位置取邻域），但词哈希 `curWord/prevWord/prev2Word/stem` 会把字节值折叠成
    // "是不是字母"的分类，置换后整张词表失效 —— 严格容器里必须关掉，只留原始滞后位。
    if (this.profile === 'text' && this.variant && !frozen && !this.strictPriors) {
      const lower = byte | 32
      const asciiLetter = lower >= 97 && lower <= 122
      if (this.context === 'wp-merge' && (asciiLetter || byte >= 128)) {
        this.curWord = (Math.imul(this.curWord, 16777619) ^ lower) >>> 0
      } else if (this.context !== 'wp-merge' && this.wordTokens && byte >= 128) {
        // P4：WORD-PRE 的词元字节（0x80..0xFF）在这里代表"一个完整词"。
        // 若按非字母处理，curWord 会被逐字节清零，H[6]/H[7] 两个词级上下文
        // 彻底失明（实测 xml 2 MiB 从 −12% 掉到 +85%）。
        // 每个词元独立推进 prevWord → curWord，让 bigram 变成"词元 bigram"。
        //
        // 注意：**不能** return —— 后面的词哈希与匹配表更新同样需要这个字节。
        if (this.context === 'wp-token3') this.prevPrevWord = this.prevWord
        this.prevWord = this.curWord
        this.curWord = Math.imul(byte + 1, 0x9e3779b1) >>> 0
      } else if (asciiLetter) {
        // P28.2: the avalanche `curWord` destroys prefix similarity after four
        // bytes ("walk"/"walking"/"walked"), so the prefix root is tracked
        // separately and stops absorbing bytes once four letters are in.
        if (this.stemLen === 0) this.curStem4 = lower
        else if (this.stemLen < 4) this.curStem4 = (Math.imul(this.curStem4, 2654435761) ^ lower) >>> 0
        this.stemLen++
        this.curWord = (Math.imul(this.curWord, 16777619) ^ lower) >>> 0
      } else if (this.curWord !== 0) {
        if (this.context === 'wp-token3') this.prevPrevWord = this.prevWord
        this.prev2Word = this.prevWord; this.prevWord = this.curWord; this.curWord = 0
        // P28.2: the token just ended, so its prefix root and its terminal tag
        // become causal state for the next token. Purely positional: no
        // character classes beyond "ASCII letter" and no suffix table.
        this.prevStem4 = this.curStem4
        this.prevSuffix = hh(this.g(2) | 0x20,
          this.stemLen >= 2 ? this.g(3) | 0x20 : 0,
          this.stemLen >= 3 ? this.g(4) | 0x20 : 0,
          Math.min(this.stemLen, 7))
        this.curStem4 = 0
        this.stemLen = 0
      }
    }
    if (this.profile === 'text') {
      const letter = (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || byte >= 128
      if (letter) this.wh = Math.imul(this.wh ^ byte, 0x01000193)
      else if (this.wh !== 0) {
        this.pwh = this.wh
        this.wh = 0
      }
    }
    if (this.contextPeer) {
      const p = this.contextPeer
      this.mlen=p.mlen;this.mptr=p.mptr;this.mbyte=p.mbyte;this.lastDist=p.lastDist;this.gapLeft=p.gapLeft
    } else if (this.useMatch) {
      const buf = this.buf
      const pos = this.pos
      // Legacy v15 retains its old experimental semantics. Only v20 BIN uses
      // the serialized recovery flag and corrected post-write distance.
      if (this.gapRecovery) {
        if (this.mlen > 0 && (this.symDir < 0 ? this.compByte![buf[this.mptr]] : buf[this.mptr]) !== byte) {
          this.lastDist = this.isV20 ? pos - 1 - this.mptr : pos - this.mptr
          this.gapLeft = match3Tuning.gapWait
        } else if (this.gapLeft > 0) this.gapLeft--
      }
      if (this.symDna || this.symProt) {
        const sd = this.symDir
        const exp = this.mlen > 0 ? (sd < 0 ? this.compByte![buf[this.mptr]] : buf[this.mptr]) : -1
        const softSib = this.symP5Soft && this.mlen > 0 && exp >= 0 && ((this.byteToSym![byte] >> 1) === (this.byteToSym![exp] >> 1))
        if (this.mlen > 0 && (exp === byte || softSib)) {
          this.mlen++
          if (exp === byte) this.symExact++
          else this.symExact = 0
          this.mptr += sd
          if (this.mlen >= 17) this.symLocalFlag = false
          if (this.symMMc > 0) this.symMMc = Math.max(0, this.symMMc - this.symHyst)
        } else if (this.mlen >= (this.symProt ? 8 : this.symLocalFlag ? 11 : 14) && this.symMMc < (this.symProt ? this.symMM : this.symLocalFlag ? Math.min(this.symMM, 2) : this.symMM)) {
          // P18.2: a mismatch may be an allele of another repeat copy. Switch to
          // the most recent 4-way bucket candidate whose next symbol is `byte`
          // and whose preceding k-mer verifies; otherwise tolerate the mismatch
          // and keep walking the current template (hysteresis).
          let switched = false
          if (this.symProt && this.mlen >= 8 && this.symMMc >= 2) {
            const ds = (this.symAepN > 2000000 || (this.symAepN > 262144 && this.symAepN <= 6000000 && this.symAlphaK <= 22 && this.symClean)) && this.mlen >= 12 ? [-8,-7,-6,-5,-4,-3,-2,-1,1,2,3,4,5,6,7,8] : [-3,-2,-1,1,2,3]
            for (const d of ds) {
              const q = this.mptr + d
              if (q >= 4 && q < pos) {
                const ok3 = buf[q - 1] === buf[pos - 1] && buf[q - 2] === buf[pos - 2] && buf[q - 3] === buf[pos - 3]
                let ok = ok3
                if (!ok && this.mlen >= 16 && q >= 4) {
                  if (this.symAepN > 262144 && this.symAepN <= 6000000 && this.symAlphaK <= 22 && this.symClean) {
                    let ex=0, co=0
                    for (let k=1;k<=4;k++) { const a=this.byteToSym![buf[q-k]], b=this.byteToSym![buf[pos-k]]; if (a===b) ex++; else if ((a>>2)===(b>>2)) co++ }
                    ok = ex === 4 || (ex >= 3 && co >= 1)
                  } else ok = buf[q-1]===buf[pos-1] && buf[q-2]===buf[pos-2] && buf[q-3]===buf[pos-3] && buf[q-4]===buf[pos-4]
                }
                if (!ok && this.mlen >= 12 && this.symMMc >= 3 && q >= 4) {
                  let ex=0, coarse=0
                  for (let k=1;k<=4;k++) { const a=this.byteToSym![buf[q-k]], b=this.byteToSym![buf[pos-k]]; if (a===b) ex++; else if ((a>>2)===(b>>2)) coarse++ }
                  ok = ex >= 3 && ex + coarse === 4
                }
                if (ok) { this.mptr = q; this.symMMc = 0; this.symExact = 0; switched = true; break }
              }
            }
          }
          if (!switched && this.symTbl && (this.symDna || this.symProt)) {
            const kk2 = this.symSeedK, b2s2 = this.byteToSym!
            let h2 = 0x811c9dc5
            for (let q = pos - kk2; q < pos; q++) h2 = Math.imul(h2 ^ (b2s2[buf[q]] + 1), 0x01000193)
            h2 = (h2 ^ (h2 >>> 15)) & 0x3fffff
            const b2 = h2 << 2, cands = this.symTbl
            for (let w = 0; w < 4; w++) {
              const cd = cands[b2 + w]
              if (cd >= kk2 && cd < pos && buf[cd] === byte) {
                let ok = true
                for (let d = 1; d <= kk2; d++) if (buf[cd - d] !== buf[pos - d]) { ok = false; break }
                if (ok) {
                  this.mptr = cd
                  this.mlen = Math.max(this.mlen, kk2)
                  this.symDir = 1
                  this.symMMc = 0
                  this.symExact = kk2
                  this.symLocalFlag = false
                  switched = true
                  break
                }
              }
            }
          }
          if (!switched && this.symSp4 && this.symTblS && pos >= 21) {
            const b2s3 = this.byteToSym!, ts3 = this.symTblS
            let hs = 0x811c9dc5
            for (let d = 0; d < 21; d++) {
              if (d % 3 === 2) continue
              hs = Math.imul(hs ^ (b2s3[buf[pos - 1 - d]] + 1), 0x01000193)
            }
            hs = (hs ^ (hs >>> 15)) & 0xfffff
            for (let w = 0; w < 4; w++) {
              const cd = ts3[(hs << 2) + w]
              if (cd >= 21 && cd < pos && buf[cd] === byte) {
                let m = 0, mm = 0
                for (let d = 0; d < 21; d++) {
                  if (buf[cd - 1 - d] === buf[pos - 1 - d]) m++
                  else if (++mm > 3) break
                }
                if (m >= 18) {
                  this.mptr = cd
                  this.mlen = Math.max(this.mlen, 21)
                  this.symDir = 1
                  this.symMMc = 0
                  this.symExact = 0
                  this.symLocalFlag = false
                  switched = true
                  break
                }
              }
            }
          }
          if (!switched) {
            this.symMMc++
            this.symExact = 0
            this.mptr += sd
          }
        } else {
          if (this.symProt && this.mlen >= 16) {
            this.shadowDelta = this.mptr - pos
            this.shadowUntil = pos + 512
          }
          this.mlen = 0
          this.symDir = 1
          this.symMMc = 0
          this.symExact = 0
          this.symLocalFlag = false
        }
      } else if (this.mlen > 0 && (this.symDir < 0 ? this.compByte![buf[this.mptr]] : buf[this.mptr]) === byte) {
        this.mlen++
        this.mptr += this.symDir
      } else { this.mlen = 0; this.symDir = 1 }
      if (pos >= 4) {
        let h = Math.imul(buf[pos - 1] + 1, 0x9e3779b1)
        h = Math.imul(h ^ (buf[pos - 2] + 1), 0x85ebca6b)
        h = Math.imul(h ^ (buf[pos - 3] + 1), 0xc2b2ae35)
        h = Math.imul(h ^ (buf[pos - 4] + 1), 0x27d4eb2f)
        h = (h ^ (h >>> 15)) >>> this.mhShift
        if (this.mlen === 0) {
          const cand = this.mht[h]
          if (cand > 0) {
            let l = 0
            while (l < 32 && cand - 1 - l >= 0 && buf[cand - 1 - l] === buf[pos - 1 - l]) l++
            if (this.matchStats) this.matchStats.candidatesChecked++
            if (l >= this.minLen && (!this.symProt || l >= 6)) { this.mlen = l; this.mptr = cand; this.symExact = l }
          }
          const olds = this.matchTabs
          for (let oi = 0; oi < olds.length; oi++) {
            const at = olds[oi]
            const older = at[h]
            if (older > 0) {
              let l = 0
              while (l < 32 && older - 1 - l >= 0 && buf[older - 1 - l] === buf[pos - 1 - l]) l++
              if (this.matchStats) this.matchStats.candidatesChecked++
              // Newer wins ties, so ordering is deterministic and no future data is used.
              if (l >= this.minLen && (!this.symProt || l >= 6) && l > this.mlen) {
                this.mlen = l; this.mptr = older; this.symExact = l
                if (this.matchStats) this.matchStats.olderWins++
              }
            }
          }
          if (this.mlen > 0 && (this.matchDistOn || this.matchExperiment === 'dual-distance' || this.matchStats)) {
            const distance = pos - this.mptr
            this.matchDistance = distance <= 16 ? 0 : distance <= 256 ? 1 : distance <= 4096 ? 2 : distance <= 65536 ? 3 : 4
            if (this.matchStats) { this.matchStats.matchesStarted++; this.matchStats.distanceStarts[this.matchDistance]++ }
          }
        }
        if (this.mhtO2 && this.mhtOlder) this.mhtO2[h] = this.mhtOlder[h]
        if (this.mhtOlder) this.mhtOlder[h] = this.mht[h]
        this.mht[h] = pos
      }
      if (this.symDna && pos >= this.symSeedK + 2) {
        const kk = this.symSeedK, b2s = this.byteToSym!, cp = this.compByte!
        const hashAt = (e: number, rev: boolean): number => {
          let h = 0x811c9dc5
          if (rev) { for (let q = e - 1; q >= e - kk; q--) h = Math.imul(h ^ (b2s[cp[buf[q]]] + 1), 0x01000193) }
          else { for (let q = e - kk; q < e; q++) h = Math.imul(h ^ (b2s[buf[q]] + 1), 0x01000193) }
          h ^= h >>> 15
          return h & 0x3fffff
        }
        if (!this.symTbl) this.symTbl = new Int32Array((1 << 22) * 4)
        const tf = this.symTbl
        const kf = hashAt(pos, false)
        let bestL = 0, bestP = 0, bestD = 0, bestLocal = false, bestE = 0
        if (this.mlen < this.symSeedGate) {
          for (let w = 0; w < 4; w++) {
            const ef = tf[(kf << 2) + w]
            if (ef >= kk && ef < pos) {
              let j = 0
              while (j < 96 && ef - kk + j >= 0 && buf[ef - kk + j] === buf[pos - kk + j]) j++
              if (j >= kk && j > bestL) { bestL = j; bestP = ef; bestD = 0; bestLocal = false; bestE = j }
            }
          }
        }
        if (this.mlen < this.symSeedGate) {
          const kr = hashAt(pos, true)
          for (let w = 0; w < 4; w++) {
            const er = tf[(kr << 2) + w]
            if (er >= kk && er - kk - 1 >= 0) {
              let j = 1
              while (j <= 128 && pos - j >= 0 && er - kk - 1 + j >= 0 && buf[pos - j] === cp[buf[er - kk - 1 + j]]) j++
              const l = j - 1
              if (l >= 16 && l > bestL) { bestL = l; bestP = er - kk - 1; bestD = 1; bestLocal = false; bestE = l }
            }
          }
        }
        // Codon-wobble spaced seed: 14 care bases over a 21 bp span, >=18/21
        // verified. This recovers paralogous repeats that a contiguous k-mer
        // misses because of synonymous third positions.
        if (pos >= 21 && this.mlen < 14) {
          if (!this.symTblS) this.symTblS = new Int32Array((1 << 20) * 4)
          const ts = this.symTblS
          let hf = 0x811c9dc5, hr = 0x811c9dc5
          for (let d = 0; d < 21; d++) {
            if (d % 3 === 2) continue
            hf = Math.imul(hf ^ (b2s[buf[pos - 1 - d]] + 1), 0x01000193)
            hr = Math.imul(hr ^ (b2s[cp[buf[pos - 1 - d]]] + 1), 0x01000193)
          }
          hf = (hf ^ (hf >>> 15)) & 0xfffff
          hr = (hr ^ (hr >>> 15)) & 0xfffff
          let bestM = 0, bestEP = 0, bestED = 0
          for (let w = 0; w < 4; w++) {
            const ep = ts[(hf << 2) + w]
            if (ep >= 21 && ep < pos) {
              let m = 0, mm = 0
              for (let d = 0; d < 21; d++) {
                if (buf[ep - 1 - d] === buf[pos - 1 - d]) m++
                else if (++mm > 3) break
              }
              if (m >= 18 && m > bestM) { bestM = m; bestEP = ep; bestED = 0 }
            }
          }
          for (let w = 0; w < 4; w++) {
            const er = ts[(hr << 2) + w]
            if (er >= 22) {
              let m = 0, mm = 0
              for (let d = 0; d < 21; d++) {
                if (buf[pos - 1 - d] === cp[buf[er - 21 + d]]) m++
                else if (++mm > 3) break
              }
              if (m >= 18 && m > bestM) { bestM = m; bestEP = er - 22; bestED = 1 }
            }
          }
          if (bestM > 0) {
            bestL = 21; bestP = bestEP; bestD = bestED; bestLocal = false
            let tr = 0
            while (tr < 21 && bestED === 0 && buf[bestEP - 1 - tr] === buf[pos - 1 - tr]) tr++
            while (tr < 21 && bestED === 1 && buf[pos - 1 - tr] === cp[buf[bestEP + 21 - tr]]) tr++
            bestE = tr
          }
          const b4s = hf << 2
          ts[b4s + 3] = ts[b4s + 2]; ts[b4s + 2] = ts[b4s + 1]; ts[b4s + 1] = ts[b4s]; ts[b4s] = pos
        }
        // Local distance-horizon seed: 11-mer table plus the significance gate
        // 2L - log2(dist) >= 22, i.e. 11 bp within 128, 13 bp within 4 KiB,
        // 15 bp within 64 KiB. Only consulted when no global match is active.
        if (pos >= 12 && this.mlen === 0) {
          if (!this.symTblL) this.symTblL = new Int32Array(1 << 21)
          const tl = this.symTblL
          let hf = 0x811c9dc5, hr = 0x811c9dc5
          for (let d = 1; d <= 11; d++) {
            hf = Math.imul(hf ^ (b2s[buf[pos - d]] + 1), 0x01000193)
            hr = Math.imul(hr ^ (b2s[cp[buf[pos - d]]] + 1), 0x01000193)
          }
          hf = (hf ^ (hf >>> 15)) & 0x1fffff
          hr = (hr ^ (hr >>> 15)) & 0x1fffff
          const cf = bestL < 64 ? tl[hf] : 0
          if (cf >= 11 && cf < pos) {
            let L = 0
            while (L < 64 && cf - 1 - L >= 0 && buf[cf - 1 - L] === buf[pos - 1 - L]) L++
            const dist = pos - cf
            if ((dist <= 128 && L >= 11) || (dist <= 4096 && L >= 13) || (dist <= 65536 && L >= 15)) {
              if (L > bestL) { bestL = L; bestP = cf; bestD = 0; bestLocal = true; bestE = L }
            }
          }
          const cr = bestL < 64 ? tl[hr] : 0
          if (cr >= 12) {
            let L = 0
            while (L < 64 && pos - 1 - L >= 0 && cr - 11 + L >= 0 && buf[pos - 1 - L] === cp[buf[cr - 11 + L]]) L++
            const dist = pos - cr
            if ((dist <= 128 && L >= 11) || (dist <= 4096 && L >= 13) || (dist <= 65536 && L >= 15)) {
              if (L > bestL) { bestL = L; bestP = cr - 12; bestD = 1; bestLocal = true; bestE = L }
            }
          }
          tl[hf] = pos
        }
        if (bestL > this.mlen) {
          this.mlen = bestL
          this.mptr = bestP
          this.symDir = bestD ? -1 : 1
          this.symLocalFlag = bestLocal
          this.symMMc = 0
          this.symExact = bestE
        }
        const b4 = kf << 2
        tf[b4 + 3] = tf[b4 + 2]
        tf[b4 + 2] = tf[b4 + 1]
        tf[b4 + 1] = tf[b4]
        tf[b4] = pos
      } else if (this.symProt && pos >= this.symSeedK + 1) {
        if (this.mlen === 0 && pos <= this.shadowUntil && pos >= 5) {
          let relock = -1
          const fastShadow = this.symAepN > 262144
          const maxD = fastShadow ? 48 : 16
          for (let ad = 0; ad <= maxD && relock < 0; ad++) {
            for (const sg of ad === 0 ? [0] : [-1, 1]) {
              const d = sg * ad, cand = pos + this.shadowDelta + d
              if (cand < 5 || cand >= pos) continue
              const need = fastShadow ? (ad === 0 ? 4 : ad > 16 ? 6 : 5) : 5
              let ok = true
              for (let k = 1; k <= need; k++) if (buf[cand-k] !== buf[pos-k]) { ok = false; break }
              if (ok) { relock = cand; break }
            }
          }
          if (relock >= 0) { this.mptr = relock; this.mlen = 8; this.symMMc = 0; this.symExact = 0; this.shadowUntil = 0 }
        }
        const kk = this.symSeedK, b2s = this.byteToSym!
        const hashAt = (e: number, k: number): number => {
          let h = 0x811c9dc5
          for (let q = e - k; q < e; q++) h = Math.imul(h ^ (b2s[buf[q]] + 1), 0x01000193)
          h ^= h >>> 15
          return h & 0x3fffff
        }
        if (!this.symTbl) this.symTbl = new Int32Array((1 << 22) * 4)
        const tf = this.symTbl
        const kf = hashAt(pos, kk)
        let bestL = 0, bestP = 0, bestE = 0, bestScore = -1
        if (this.mlen < this.symSeedGate) {
          for (let w = 0; w < 4; w++) {
            const ep = tf[(kf << 2) + w]
            if (ep >= kk && ep < pos) {
              let j = 0
              while (j < 64 && ep - kk + j >= 0 && buf[ep - kk + j] === buf[pos - kk + j]) j++
              if (j >= kk) {
                let sc = 0
                if (this.symAepN > 2000000) {
                  for (let k = 1; k <= 16 && ep - k >= 0 && pos - k >= 0; k++) {
                    const a = b2s[buf[ep - k]], b = b2s[buf[pos - k]]
                    if (a === b) sc += 2; else if ((a >> 2) === (b >> 2)) sc++
                  }
                }
                if (j > bestL || sc > bestScore) { bestL = j; bestP = ep; bestE = j; bestScore = sc }
              }
            }
          }
        }
        // P18.4: coarse equivalence seed. Ten consecutive sym>>2 symbols (30
        // bits), accepted only when >=14/16 residues share the same coarse class.
        if (this.symP5Coarse && this.mlen === 0 && pos >= 10) {
          if (!this.symTblC) this.symTblC = new Int32Array(1 << 21)
          const tc = this.symTblC
          let hc = 0x811c9dc5
          for (let q = pos - 10; q < pos; q++) hc = Math.imul(hc ^ ((b2s[buf[q]] >> 2) + 1), 0x01000193)
          hc = (hc ^ (hc >>> 15)) & 0x1fffff
          const ep = tc[hc]
          if (ep >= 10 && ep < pos) {
            let cm = 0, mm = 0
            for (let d = 0; d < 16 && ep - 1 - d >= 0 && pos - 1 - d >= 0; d++) {
              if ((b2s[buf[ep - 1 - d]] >> 2) === (b2s[buf[pos - 1 - d]] >> 2)) cm++
              else if (++mm > 2) break
            }
            if (cm >= 14) { bestL = 10; bestP = ep; bestE = 0 }
          }
          tc[hc] = pos
        }
        // Homologous protein spaced seed: 6 care residues over 9 (110110110), >=7/9.
        if (pos >= 9 && this.mlen < 10) {
          const sbits = this.symAepN > 10000000 ? 23 : this.symAepN > 2000000 ? 21 : this.symAepN > 262144 && this.symAlphaK <= 22 ? 21 : 19
          const s4 = this.symAepN > 262144 && this.symAlphaK <= 22 && this.symClean
          if (!this.symTblS) this.symTblS = new Int32Array((1 << sbits) * (s4 ? 4 : 1))
          const ts = this.symTblS
          let hs = 0x811c9dc5
          for (let d = 0; d < 9; d++) {
            if (d % 3 === 2) continue
            hs = Math.imul(hs ^ (b2s[buf[pos - 1 - d]] + 1), 0x01000193)
          }
          hs = (hs ^ (hs >>> 15)) & ((1 << sbits) - 1)
          const hb = s4 ? hs << 2 : hs
          const scanEp = (ep: number): number => {
            if (ep < 9 || ep >= pos) return -1
            let m = 0, mm = 0
            for (let d = 0; d < 9; d++) {
              if (buf[ep - 1 - d] === buf[pos - 1 - d]) m++
              else if (++mm > 2) break
            }
            if (m < 7) return -1
            let sc = 0
            for (let k = 1; k <= 16 && ep - k >= 0 && pos - k >= 0; k++) {
              const a = b2s[buf[ep - k]], b = b2s[buf[pos - k]]
              if (a === b) sc += 2; else if ((a >> 2) === (b >> 2)) sc++
            }
            return sc
          }
          let bestSc = -1, bestEp = -1
          const nw = s4 ? 4 : 1
          for (let w = 0; w < nw; w++) {
            const ep = ts[hb + w], sc = scanEp(ep)
            if (sc > bestSc) { bestSc = sc; bestEp = ep }
          }
          if (bestEp >= 0) {
            let tr = 0
            while (tr < 9 && buf[bestEp - 1 - tr] === buf[pos - 1 - tr]) tr++
            if (9 > bestL) { bestL = 9; bestP = bestEp; bestE = tr }
          }
          if (s4) {
            if (pos - ts[hb] > 4) { ts[hb+3]=ts[hb+2]; ts[hb+2]=ts[hb+1]; ts[hb+1]=ts[hb]; ts[hb]=pos }
          } else ts[hs] = pos
        }
        // Sibling-pair 10-mer homolog seed for gapped protein contexts.
        if (this.symProt && this.context === 'sym-5bit-gap' && this.symAepN > 2000000 && this.mlen === 0 && pos >= 10) {
          const gbits = this.symAepN > 10000000 ? 22 : 21
          if (!this.symTblG) this.symTblG = new Int32Array(1 << gbits)
          const tg = this.symTblG
          let hg = 0x811c9dc5
          for (let d = 0; d < 10; d++) hg = Math.imul(hg ^ ((b2s[buf[pos - 1 - d]] >> 1) + 1), 0x01000193)
          hg = (hg ^ (hg >>> 15)) & ((1 << gbits) - 1)
          const ep = tg[hg]
          let ok = ep >= 10 && ep < pos
          if (ok) {
            let ex = 0
            for (let d = 0; d < 10; d++) {
              const a = b2s[buf[ep - 1 - d]], b = b2s[buf[pos - 1 - d]]
              if ((a >> 1) !== (b >> 1)) { ok = false; break }
              if (a === b) ex++
            }
            if (ok && ex >= 7) { bestL = 10; bestP = ep; bestE = 10 }
          }
          tg[hg] = pos
        }
        // Local tandem-repeat horizon: 4-mer <=128, 5-mer <=4096, 6-mer <=65536.
        if (pos >= 6 && this.mlen === 0) {
          if (!this.symTblL4) { this.symTblL4 = new Int32Array(1 << 18); this.symTblL5 = new Int32Array(1 << 18); this.symTblL6 = new Int32Array(1 << 19) }
          const lts = [this.symTblL4, this.symTblL5, this.symTblL6], hor = [128, 4096, 65536]
          for (let li = 0; li < 3; li++) {
            const lk = 4 + li, ht = lts[li]!
            const lh = li === 2 ? (hashAt(pos, lk) & 0x7ffff) : (hashAt(pos, lk) >>> 4)
            const cand = ht[lh]
            if (cand >= lk && pos - cand <= hor[li]) {
              let j = 0
              while (j < 48 && cand - 1 - j >= 0 && buf[cand - 1 - j] === buf[pos - 1 - j]) j++
              if (j >= lk && j > bestL) { bestL = j; bestP = cand; bestE = j }
            }
            ht[lh] = pos
          }
        }
        const b4 = kf << 2
        tf[b4 + 3] = tf[b4 + 2]; tf[b4 + 2] = tf[b4 + 1]; tf[b4 + 1] = tf[b4]; tf[b4] = pos
        if (bestL > this.mlen) { this.mlen = bestL; this.mptr = bestP; this.symDir = 1; this.symExact = bestE; this.symMMc = 0 }
      } else if (this.symBits < 8 && pos >= this.symSeedK + 2) {
        const kk = this.symSeedK, b2s = this.byteToSym!, cp = this.compByte!
        const hashAt = (e: number, rev: boolean): number => {
          let h = 0x811c9dc5
          if (rev) { for (let q = e - 1; q >= e - kk; q--) h = Math.imul(h ^ (b2s[cp[buf[q]]] + 1), 0x01000193) }
          else { for (let q = e - kk; q < e; q++) h = Math.imul(h ^ (b2s[buf[q]] + 1), 0x01000193) }
          h ^= h >>> 15
          return h & 0x3fffff
        }
        if (!this.symTbl) this.symTbl = new Int32Array(1 << 22)
        const tf = this.symTbl
        const kf = hashAt(pos, false)
        let bestL = 0, bestP = 0, bestD = 0
        if (this.mlen < this.symSeedGate) {
          const ef = tf[kf]
          if (ef >= kk && ef < pos) {
            let j = 0
            while (j < 96 && ef - kk + j >= 0 && buf[ef - kk + j] === buf[pos - kk + j]) j++
            if (j >= kk) { bestL = j; bestP = ef; bestD = 0 }
          }
        }
        if (this.symRc && this.mlen < this.symSeedGate) {
          const kr = hashAt(pos, true)
          const er = tf[kr]
          if (er >= kk && er - kk - 1 >= 0) {
            let j = 1
            while (j <= 128 && pos - j >= 0 && er - kk - 1 + j >= 0 && buf[pos - j] === cp[buf[er - kk - 1 + j]]) j++
            const l = j - 1
            if (l >= 16 && l > bestL) { bestL = l; bestP = er - kk - 1; bestD = 1 }
          }
        }
        if (bestL > this.mlen) { this.mlen = bestL; this.mptr = bestP; this.symDir = bestD ? -1 : 1 }
        tf[kf] = pos
      }
      // Legacy v15 only queries below 6; v20 also checks lengths 6..31,
      // accepting a verified >=6-byte candidate only when it is longer.
      const m8 = this.mht8
      if (m8 && pos >= 8) {
        let h8 = Math.imul(buf[pos - 1] + 1, 0x9e3779b1)
        h8 = Math.imul(h8 ^ (buf[pos - 2] + 1), 0x85ebca6b)
        h8 = Math.imul(h8 ^ (buf[pos - 3] + 1), 0xc2b2ae35)
        h8 = Math.imul(h8 ^ (buf[pos - 4] + 1), 0x27d4eb2f)
        h8 = Math.imul(h8 ^ (buf[pos - 5] + 1), 0x165667b1)
        h8 = Math.imul(h8 ^ (buf[pos - 6] + 1), 0x9e3779b1)
        h8 = Math.imul(h8 ^ (buf[pos - 7] + 1), 0x85ebca6b)
        h8 = Math.imul(h8 ^ (buf[pos - 8] + 1), 0xc2b2ae35)
        h8 = (h8 ^ (h8 >>> 15)) >>> this.mh8Shift
        if (this.mlen < (this.isV20 ? 32 : 6)) {
          const cand8 = m8[h8]
          // 远距离候选才值得查（近处的 4 字节表已经覆盖）
          if (cand8 > 0 && pos - cand8 > 64) {
            let l = 0
            while (l < 64 && cand8 - 1 - l >= 0 && buf[cand8 - 1 - l] === buf[pos - 1 - l]) l++
            if (l >= 6 && l > this.mlen) { this.mlen = l; this.mptr = cand8 }
          }
        }
        m8[h8] = pos
      }
      // P6-3b：哈希都没命中时，若"原跨距"在刚过去的字节上重新对齐，就直接续上。
      // 32 位指令里操作码相同、中间只有 1 字节寄存器不同，正是这种情况。
      if (this.gapRecovery && this.mlen === 0 && this.gapLeft > 0 && this.lastDist > 0) {
        const cand = pos - this.lastDist
        if (cand >= 1 && buf[cand - 1] === buf[pos - 1]) { this.mptr = cand; this.mlen = 2; this.gapLeft = 0 }
      }
      this.mbyte = this.mlen > 0 ? (this.symDir < 0 ? this.compByte![buf[this.mptr]] : buf[this.mptr]) : 0
    }
    this.prevByte = byte
    this.computeContexts()
  }
}

function mid(x1: number, x2: number, p: number): number {
  const range = x2 - x1
  return x1 + Math.floor(range / 4096) * p + Math.floor(((range % 4096) * p) / 4096)
}

export interface CostBins { values: Float32Array; blockSize: number; ends?: Uint32Array; offset?: number }

export function encodeCM(
  data: Uint8Array,
  profile: Profile,
  s = 1,
  r = 1,
  costOut?: Float32Array,
  costOff = 0,
  blockCost?: CostBins,
  onProgress?: (done: number, total: number) => void,
  variant: CMVariant = false, geomStride = 0, wordTokens = false, options?: CMOptions,
): Uint8Array {
  if (isSymContext(options?.context)) {
    const ctx = options!.context as SymContext
    const baseMap = symAlphabetOf(data, ctx)
    let map = baseMap
    if (map.bits === 5) { map = symAlphabetFromList(symContextOrder(data, map), ctx); map.minCount = baseMap.minCount }
    const modelMap = canonicalModelMap(map)
    const body = encodeCMImpl(canonicalizeSymbols(data, map), profile, s, r, costOut, costOff, blockCost, onProgress, variant, geomStride, undefined, undefined, wordTokens, { ...options, symMap: modelMap })
    const out = new Uint8Array(1 + map.k + body.length)
    out[0] = map.k
    out.set(map.symToByte.subarray(0, map.k), 1)
    out.set(body, 1 + map.k)
    return markPayloadModel(out, payloadModelFlags(body))
  }
  return encodeCMImpl(data, profile, s, r, costOut, costOff, blockCost, onProgress, variant, geomStride, undefined, undefined, wordTokens, options)
}

function encodeCMImpl(data: Uint8Array, profile: Profile, s: number, r: number, costOut?: Float32Array, costOff = 0, blockCost?: CostBins, onProgress?: (done:number,total:number)=>void, variant: CMVariant = false, geomStride = 0, matchExperiment?: MatchExperiment, matchStats?: MatchStats, wordTokens = false, options?: CMOptions): Uint8Array {
  const n = data.length
  const m = new Model(n, profile, s, r, variant, geomStride, matchExperiment, matchStats, wordTokens, options)
  const out = new ByteWriter()
  let x1 = 0
  let x2 = 0xffffffff
  let costBin = 0
  for (let i = 0; i < n; i++) {
    const byte = data[i]
    let c = 0
    for (let b = m.symBits < 8 ? m.symBits - 1 : 7; b >= 0; b--) {
      const y = m.symBits < 8 ? (m.byteToSym![byte] >> b) & 1 : (byte >> b) & 1
      if (m.forcedZero()) { m.skipZero(); continue }
      const p = m.step(y, true)
      const xm = mid(x1, x2, p)
      if (y) x2 = xm
      else x1 = xm + 1
      if (costOut || blockCost) c += COST[y ? p : 4096 - p]
      m.learn(y)
      while (((x1 ^ x2) & 0xff000000) === 0) {
        out.push(x2 >>> 24)
        x1 = (x1 << 8) >>> 0
        x2 = ((x2 << 8) | 255) >>> 0
      }
    }
    if (costOut) costOut[costOff + i] = c
    // P8 诊断：只读归因（bits 就是该字节的 -log2 P(y) 累加，与算术编码器同源）。
    if (attribHook) attribHook(m as unknown as AttribModelView, i, c)
    if (blockCost) {
      if (blockCost.ends) { while (i >= blockCost.ends[costBin]) costBin++ }
      else costBin = Math.floor(i / blockCost.blockSize)
      blockCost.values[costBin + (blockCost.offset ?? 0)] += c
    }
    if (onProgress && (i & 0x3ffff) === 0) onProgress(i, n)
  }
  onProgress?.(n, n)
  // 最短收尾:找出 [x1,x2] 内尾部全 0 的最短数值,解码端对缺失字节补 0
  for (let k = 0; k <= 4; k++) {
    const unit = Math.pow(2, 32 - 8 * k)
    const v = Math.ceil(x1 / unit) * unit
    if (v <= x2 && v < 4294967296) {
      for (let j = 0; j < k; j++) out.push(Math.floor(v / Math.pow(2, 24 - 8 * j)) & 255)
      break
    }
  }
  return markPayloadModel(out.finish(), n ? m.requiredFlags : 0)
}

/** Two independent arithmetic streams; shared H0..H7 and match state only.
 * Restricted to contexts whose first eight tables are identical. */
export function encodeCMContextDual(data:Uint8Array, context:'bin-stride4'|'wp-token3'|'text-sparse5') {
  if(context!=='bin-stride4'&&context!=='wp-token3'&&context!=='text-sparse5')throw Error('only H8-compatible contexts may share')
  const n=data.length
  const profile=context==='bin-stride4'?'bin':'text',wordTokens=context==='wp-token3'
  const base=new Model(n,profile,1,1,'v20',0,undefined,undefined,wordTokens)
  const alt=new Model(n,profile,1,1,'v20',0,undefined,undefined,wordTokens,{context},base)
  for(let k=0;k<8;k++)if(base.tables[k]!==alt.tables[k])throw Error('tables not actually shared')
  if(base.mht!==alt.mht||base.mht8!==alt.mht8||base.msm!==alt.msm||base.buf!==alt.buf)throw Error('match/input not shared')
  if(base.apm2On!==alt.apm2On||base.weights===alt.weights||(base.weights2&&base.weights2===alt.weights2)||base.apmT===alt.apmT||(base.apm2T&&base.apm2T===alt.apm2T))throw Error('stream-specific learning must be independent')
  const bOut=new ByteWriter(),aOut=new ByteWriter()
  let b1=0,b2=0xffffffff,a1=0,a2=0xffffffff
  for(let i=0;i<n;i++)for(let bit=7;bit>=0;bit--){
    const y=(data[i]>>>bit)&1
    // Both predictions MUST see the same pre-update shared tables/MSM.
    const bp=base.step(y,true),ap=alt.step(y,true)
    let x=mid(b1,b2,bp);if(y)b2=x;else b1=x+1
    x=mid(a1,a2,ap);if(y)a2=x;else a1=x+1
    // Base writes shared tables/MSM/match state ONCE. Alt learns its H8,
    // weights, secondary weights, a1/a2 only; at byte boundaries it copies
    // the newly updated match pointers without inserting again into mht.
    base.learn(y);alt.learn(y)
    while(((b1^b2)&0xff000000)===0){bOut.push(b2>>>24);b1=(b1<<8)>>>0;b2=((b2<<8)|255)>>>0}
    while(((a1^a2)&0xff000000)===0){aOut.push(a2>>>24);a1=(a1<<8)>>>0;a2=((a2<<8)|255)>>>0}
  }
  const flush=(x1:number,x2:number,out:ByteWriter)=>{
    for(let k=0;k<=4;k++){
      const unit=2**(32-8*k),v=Math.ceil(x1/unit)*unit
      if(v<=x2&&v<4294967296){for(let j=0;j<k;j++)out.push(Math.floor(v/2**(24-8*j))&255);break}
    }return out.finish()
  }
  return {base:markPayloadModel(flush(b1,b2,bOut),n?base.requiredFlags:0),alt:markPayloadModel(flush(a1,a2,aOut),n?alt.requiredFlags:0)}
}

/**
 * Diagnostic dual stream for one selected APM kernel (v15 or v20).
 * Only `alt` is byte-identical to an independent encodeCM with that kernel.
 * `base` uses separate uncalibrated weights, but shares the selected kernel's
 * contexts/match tables (including mht8 and, for v20, new buckets/recovery).
 * It is NOT a legacy-v13 payload and must never be serialized as one. Production
 * retains an independently encoded real base for strict candidate comparisons.
 */
export function encodeCMDual(
  data: Uint8Array,
  profile: Profile,
  s = 1,
  r = 1,
  variant: 'v13' | 'v15' | 'v20' = 'v13',
  geomStride = 0,
): { base: Uint8Array; alt: Uint8Array } {
  if (!isAPMKernel(variant)) throw new Error('encodeCMDual 只支持 v15/v20 对照')
  const n = data.length
  const m = new Model(n, profile, s, r, variant, geomStride)
  m.dualPass = true
  // 编码端缓冲：仅供诊断的 uncalibrated base，以及选定内核的可解码 alt。
  const out13 = new ByteWriter(), out15 = new ByteWriter()
  let a1 = 0, a2 = 0xffffffff  // v13 区间
  let b1 = 0, b2 = 0xffffffff  // v15 区间
  const apmT = m.apmT
  const apm2On = m.apm2On
  const apm2T = m.apm2T!
  for (let i = 0; i < n; i++) {
    const byte = data[i]
    for (let b = 7; b >= 0; b--) {
      const y = (byte >> b) & 1
      // 一次上游遍历：返回钳位后的 v13 概率，并写好 apmBase/apmW/apmCtx。
      m.step(y, true)
      const pr = m.altPr
      let xm = mid(a1, a2, pr)
      if (y) a2 = xm
      else a1 = xm + 1
      // 同一份上游状态直接算出 v15 概率（纯查表，无随机写）。
      // P4：必须与 step() 内的校准链**逐级一致** —— a1（c0×匹配状态）之后再接
      // a2（上一字节类别×匹配状态）。漏掉 a2 会让双流算出的 v15 流与单独跑
      // v15 的单流结果不同，容器解码立刻失败。
      const cal = apmApply(m.rawPr, apmCtxOf(m.c0 & 255, m.lastMs), apmT)
      let vp = cal.pr
      if (apm2On) vp = apmApply(vp, apm2CtxOf(m.prevByte, m.lastMs, m.c0 & 255), apm2T, apm2Tuning.weight).pr
      const pv = vp < 1 ? 1 : vp > 4095 ? 4095 : vp
      xm = mid(b1, b2, pv)
      if (y) b2 = xm
      else b1 = xm + 1
      // learn() 会按 this.pr / this.apmBase / this.apmW 更新，两者都已被 step()
      // 按 v15 语义准备好，因此这一遍的模型演化与单独跑 v15 完全相同。
      m.learn(y)
      while (((a1 ^ a2) & 0xff000000) === 0) {
        out13.push(a2 >>> 24)
        a1 = (a1 << 8) >>> 0
        a2 = ((a2 << 8) | 255) >>> 0
      }
      while (((b1 ^ b2) & 0xff000000) === 0) {
        out15.push(b2 >>> 24)
        b1 = (b1 << 8) >>> 0
        b2 = ((b2 << 8) | 255) >>> 0
      }
    }
  }
  // 最短收尾：在 [x1,x2] 里找尾部全 0 的最短数值（解码端对缺失字节补 0）。
  const flush = (x1i: number, x2i: number, out: ByteWriter) => {
    for (let k = 0; k <= 4; k++) {
      const unit = Math.pow(2, 32 - 8 * k)
      const v = Math.ceil(x1i / unit) * unit
      if (v <= x2i && v < 4294967296) {
        for (let j = 0; j < k; j++) out.push(Math.floor(v / Math.pow(2, 24 - 8 * j)) & 255)
        return out.finish()
      }
    }
    return out.finish()
  }
  return { base: flush(a1, a2, out13), alt: markPayloadModel(flush(b1, b2, out15), n ? m.requiredFlags : 0) }
}

export function decodeCM(payload: Uint8Array, n: number, profile: Profile, s = 1, r = 1, onProgress?: (done: number, total: number) => void, variant: CMVariant = false, geomStride = 0, wordTokens = false, options?: CMOptions): Uint8Array {
  if (isSymContext(options?.context)) {
    const ctx = options!.context as SymContext
    if (payload.length < 1) throw Error('低基数符号头缺失')
    const k = payload[0]
    if (k < 1 || k > (ctx === 'sym-2bit' ? 4 : 32) || payload.length < 1 + k) throw Error('低基数符号头非法')
    const map = symAlphabetFromList(payload.subarray(1, 1 + k), ctx)
    const out = decodeCMImpl(payload.subarray(1 + k), n, profile, s, r, onProgress, variant, geomStride, undefined, wordTokens, { ...options, symMap: canonicalModelMap(map) })
    for (let i = 0; i < n; i++) out[i] = map.symToByte[out[i] - CANON_SYM_BASE]
    return out
  }
  return decodeCMImpl(payload,n,profile,s,r,onProgress,variant,geomStride,undefined,wordTokens,options)
}

function decodeCMImpl(payload: Uint8Array, n:number, profile:Profile, s:number, r:number, onProgress?: (done:number,total:number)=>void, variant:CMVariant=false, geomStride=0, matchExperiment?:MatchExperiment, wordTokens=false, options?:CMOptions):Uint8Array {
  const m = new Model(n, profile, s, r, variant, geomStride, matchExperiment, undefined, wordTokens, options)
  let ip = 0
  const next = () => (ip < payload.length ? payload[ip++] : 0)
  let x = 0
  for (let i = 0; i < 4; i++) x = ((x << 8) | next()) >>> 0
  let x1 = 0
  let x2 = 0xffffffff
  let t = 0
  while (m.pos < n) {
    if (onProgress && (t & 0x1fffff) === 0) onProgress(t / 8, n)
    if (m.forcedZero()) { m.skipZero(); t++; continue }
    const p = m.step(1, true)
    const xm = mid(x1, x2, p)
    let y: number
    if (x <= xm) {
      y = 1
      x2 = xm
    } else {
      y = 0
      x1 = xm + 1
    }
    m.learn(y)
    while (((x1 ^ x2) & 0xff000000) === 0) {
      x1 = (x1 << 8) >>> 0
      x2 = ((x2 << 8) | 255) >>> 0
      x = ((x << 8) | next()) >>> 0
    }
    t++
  }
  onProgress?.(n, n)
  return m.buf.subarray(0, n)
}

// Standalone research interface: no UCZ encoder/decoder selects these variants.
// Use the same profile, model version and match mode at both ends.
export function encodeMatchExperiment(data:Uint8Array, profile:'text'|'bin', mode:MatchExperiment, costOut?:Float32Array, blockCost?:CostBins):{payload:Uint8Array;stats:MatchStats} {
  if (!['single','dual','dual-distance'].includes(mode) || (profile!=='text' && profile!=='bin')) throw Error('无效匹配实验参数')
  if (costOut && costOut.length < data.length) throw Error('代价缓冲区过短')
  const stats:MatchStats={candidatesChecked:0,matchesStarted:0,olderWins:0,predictedBits:0,correctBits:0,distanceStarts:[0,0,0,0,0],matchTableBytes:0}
  const payload=encodeCMImpl(data,profile,1,1,costOut,0,blockCost,undefined,'v13',0,mode,stats)
  return {payload,stats}
}
export function decodeMatchExperiment(payload:Uint8Array, n:number, profile:'text'|'bin', mode:MatchExperiment):Uint8Array {
  if (!['single','dual','dual-distance'].includes(mode) || (profile!=='text' && profile!=='bin') || !Number.isSafeInteger(n) || n<0) throw Error('无效匹配实验参数')
  return decodeCMImpl(payload,n,profile,1,1,undefined,'v13',0,mode)
}
