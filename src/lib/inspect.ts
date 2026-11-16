/**
 * P31.0：残余信息显微镜（Residual Information Microscope）。
 *
 * 这里只做**观测**：所有统计量都由输入字节自身在线计算，不读文件名、不看尺寸、
 * 不依赖任何内置字典或格式先验。容器解剖部分只是把 UCZ 头部里已经写明的
 * 事实读出来（版本、组数、每组规则与载荷长度），不做任何猜测。
 */
import { detectLagCandidates, detectRecordStride } from './analyze'
import { encodeCM } from './coder'
import { contextFromGroupBits, GROUP_MATCH_DIST_BIT } from './context-policy'
import { compressAdaptive } from './codec'
import type { CompressionLevel } from './codec'

export type ManifoldClass =
  | 'empty'
  | 'tabular-ascii'
  | 'natural-text'
  | '2d-periodic-raster'
  | 'multi-channel-signal'
  | 'quasi-periodic'
  | 'high-entropy-or-noise'
  | 'structured-binary'

export interface DelimiterCensus {
  comma: number
  tab: number
  semicolon: number
  colon: number
  pipe: number
  newline: number
  /** 仅在出现换行时给出（字节 / 行数）。 */
  meanLineBytes: number
}

export interface ManifoldFingerprint {
  byteLength: number
  entropyH0: number
  printableAsciiRatio: number
  /** 合法 UTF-8 多字节序列覆盖的字节比例（CJK 文本 > 0）。 */
  utf8MultiByteRatio: number
  flatByteRatio: number
  detectedStride: number
  detectedLags: number[]
  detectedScanPeriod: number
  detectedDelimiters: DelimiterCensus
  inferredManifoldClass: ManifoldClass
  /** 判定依据（人读用，便于复核结论）。 */
  rationale: string[]
}

export interface SegmentAnatomy {
  index: number
  rawOffset: number
  rawLength: number
  compressedBytes: number
  bpb: number
  transformId: number
  transformName: string
  stride: number
  rank: number
  /** Group context from the three-bit field (+ extended namespace bit). */
  context?: string
  /** `true` when the group word carries the v15 legacy kernel bit (`0x8000`). */
  v15: boolean
  /** `true` when the group word carries the WORD-PRE bit (`0x4000`). */
  wordPre: boolean
  /** `true` when the group word carries the v22 distance-split match bit (`0x100000`). */
  matchDist: boolean
  /** Compact one-line flag suffix for the report, e.g. `md wp v15`. */
  flags: string
}

export interface ContainerAnatomy {
  containerVersion: number
  /** Container flag word (only written for `ver >= 19`; `0` otherwise). */
  flags: number
  totalRawBytes: number
  totalCompressedBytes: number
  headerBytes: number
  overallBpb: number
  compressionRatio: number
  segments: SegmentAnatomy[]
}

export interface ResidualAnomaly {
  offset: number
  length: number
  bpb: number
  kind: 'cold-start' | 'entropy-spike' | 'regime-shift'
}

export interface ResidualProfile {
  /** Bytes per profile bin (exactly one CM block cost bin). */
  blockSize: number
  /** Local conditional bits per byte, one entry per bin. */
  binsBpb: number[]
  minBpb: number
  maxBpb: number
  meanBpb: number
  /** Unicode sparkline (one glyph per display column). */
  sparkline: string
  /** Bins whose bpb is a statistical outlier, in stream order. */
  anomalies: ResidualAnomaly[]
}

export interface StreamInspection {
  fingerprint: ManifoldFingerprint
  container?: ContainerAnatomy
  /** 容器与原始流的对应关系（仅当做了压缩）。 */
  compressedBytes?: number
  /** Local conditional-complexity profile (see `profileResidual`). */
  residual?: ResidualProfile
  elapsedMs: number
}

const ID_NAMES: Record<number, string> = {
  0: 'STORE', 1: 'FILL', 2: 'RLE', 3: 'O0', 4: 'TEXT', 5: 'BIN', 6: 'DELTA', 7: 'GRAD',
  8: 'D16', 9: 'TRANSPOSE', 10: 'TRANSPOSE_GROUP', 11: 'BCJ', 12: 'ANCHOR', 13: 'ANCHOR_FOLD',
  14: 'PEEL', 15: 'SUB_TRANSPOSE', 16: 'SUB_ANCHOR', 17: 'MICRO', 18: 'TEXT_V2', 19: 'BIN_V2',
  20: 'BCJ_V2', 21: 'GRAD_V2', 22: 'TRANSPOSE_2D', 23: 'TEXT_V3', 24: 'BIN_V3', 25: 'BCJ_V3',
  26: 'GRAD_V3', 27: 'DELTA_V3', 28: 'SUB_TRANSPOSE_V3', 29: 'SUB_ANCHOR_V3',
  30: 'TRANSPOSE_GROUP_V3', 31: 'WIDE_GRAD', 32: 'REC2', 33: 'BITPLANE',
}

export function transformName(id: number): string { return ID_NAMES[id] ?? `ID_${id}` }

function entropy0(d: Uint8Array): number {
  if (!d.length) return 0
  const h = new Float64Array(256)
  for (let i = 0; i < d.length; i++) h[d[i]]++
  let e = 0
  for (let i = 0; i < 256; i++) if (h[i]) { const p = h[i] / d.length; e -= p * Math.log2(p) }
  return e
}

/**
 * 与 `Model.detectScanPeriod` 同一条因果判定：只看当前前缀，绝不用未来数据。
 * `Model` 会在每个 2 的幂位置重试，这里也一样按 1024/2048/4096/8192 逐级放大窗口，
 * 取第一个被接受的周期。
 */
function causalScanPeriod(d: Uint8Array): number {
  const n = d.length
  const probes: [number, number, number][] = [[1024, 512, 256], [2048, 1024, 256], [4096, 2048, 512], [8192, 2048, 512]]
  for (const [pos, winCap, maxPCap] of probes) {
    if (n < pos) break
    const win = Math.min(winCap, pos)
    const maxP = Math.min(maxPCap, win - 1)
    if (win < 64 || maxP < 32) continue
    const start = pos - win
    // 二值光栅的判据：窗口被 0x00/0xFF 主导（≥30%），且存在某个步长 p 让
    // 超过 1/3 的字节与 p 步之前完全相同。随机数据下这个比例约 1/256，
    // 所以 1/3 的门槛同时排除了"平坦但与行宽无关"的流。
    let flat = 0
    for (let j = start; j < pos; j++) { const b = d[j]; if (b === 0 || b === 255) flat++ }
    if (flat * 10 < win * 3) continue
    let bestP = 0, bestN = 0
    for (let p = 32; p <= maxP; p++) {
      let cnt = 0
      for (let j = start + p; j < pos; j++) if (d[j] === d[j - p]) cnt++
      if (cnt > bestN) { bestN = cnt; bestP = p }
    }
    if (bestN >= 24 && bestN * 3 >= win) return bestP
  }
  return 0
}

export function fingerprintStream(data: Uint8Array): ManifoldFingerprint {
  const n = data.length
  const delims: DelimiterCensus = { comma: 0, tab: 0, semicolon: 0, colon: 0, pipe: 0, newline: 0, meanLineBytes: 0 }
  let printable = 0, flat = 0, utf8 = 0
  for (let i = 0; i < n; i++) {
    const b = data[i]
    if ((b >= 0x20 && b <= 0x7e) || b === 9 || b === 10 || b === 13) printable++
    // 合法 UTF-8 多字节码点（CJK 文本、引号等）同样是自然语言的证据。
    // 只看结构：首字节 0xC2..0xF4，后随 1..3 个 0x80..0xBF 续字节。
    else if (b >= 0xc2 && b <= 0xf4) {
      const need = b < 0xe0 ? 1 : b < 0xf0 ? 2 : 3
      let ok = i + need < n
      for (let k = 1; ok && k <= need; k++) if ((data[i + k] & 0xc0) !== 0x80) ok = false
      if (ok) { utf8 += 1 + need; i += need }
    }
    if (b === 0 || b === 255) flat++
    if (b === 44) delims.comma++
    else if (b === 9) delims.tab++
    else if (b === 59) delims.semicolon++
    else if (b === 58) delims.colon++
    else if (b === 124) delims.pipe++
    else if (b === 10) delims.newline++
  }
  if (delims.newline) delims.meanLineBytes = n / delims.newline
  const printableRatio = n ? printable / n : 0
  const utf8Ratio = n ? utf8 / n : 0
  // 文本证据 = 7-bit 可打印 + 合法 UTF-8 多字节；纯 ASCII 文本时二者相同。
  const textRatio = Math.min(1, printableRatio + utf8Ratio)
  const flatRatio = n ? flat / n : 0
  const stride = n >= 4096 ? detectRecordStride(data) : 0
  const lags = n >= 4096 ? detectLagCandidates(data, Math.max(1, stride)) : []
  const rationale: string[] = []
  let scan = causalScanPeriod(data)
  // 纯白边距（整行 0x00）会让所有步长的匹配数单调递减，因果检测因此给不出周期。
  // 这种情况下退回到滞后普查：平坦主导的流里 `detectLagCandidates` 的极值点就是
  // 行距本身（ptt5: 216）。仍然只读输入字节。
  if (flatRatio >= 0.3 && lags.length) { scan = lags[0]; rationale.push('scanPeriod confirmed by lag census') }
  const h0 = entropy0(data)
  const strip = delims.comma + delims.semicolon + delims.tab + delims.pipe
  let cls: ManifoldClass = 'structured-binary'
  if (!n) cls = 'empty'
  else if (flatRatio >= 0.3 && printableRatio <= 0.1) { cls = '2d-periodic-raster'; rationale.push(`flat=${(flatRatio * 100).toFixed(1)}% printable=${(printableRatio * 100).toFixed(1)}%`) }
  else if (textRatio >= 0.9 && delims.newline >= 4 && strip * 40 >= n) { cls = 'tabular-ascii'; rationale.push(`text=${(textRatio * 100).toFixed(1)}% delimiters=${strip}`) }
  else if (textRatio >= 0.9) { cls = 'natural-text'; rationale.push(`text=${(textRatio * 100).toFixed(1)}%${utf8 ? ` utf8=${(utf8Ratio * 100).toFixed(1)}%` : ''}`) }
  else if (stride >= 2 && stride <= 64) { cls = 'multi-channel-signal'; rationale.push(`stride=${stride}`) }
  else if (lags.length) { cls = 'quasi-periodic'; rationale.push(`lags=${lags.join(',')}`) }
  else if (h0 >= 7.4) { cls = 'high-entropy-or-noise'; rationale.push(`H0=${h0.toFixed(3)}`) }
  if (scan) rationale.push(`scanPeriod=${scan}`)
  if (lags.length) rationale.push(`lagCandidates=${lags.join(',')}`)
  return {
    byteLength: n, entropyH0: h0, printableAsciiRatio: printableRatio, utf8MultiByteRatio: utf8Ratio, flatByteRatio: flatRatio,
    detectedStride: stride, detectedLags: lags, detectedScanPeriod: scan,
    detectedDelimiters: delims, inferredManifoldClass: cls, rationale,
  }
}

function getVar(c: Uint8Array, st: { p: number }): number {
  let shift = 0, value = 0
  for (;;) {
    if (st.p >= c.length) throw new Error('容器被截断')
    const b = c[st.p++]
    value += (b & 127) * 2 ** shift
    if (!(b & 128)) return value
    shift += 7
    if (shift > 53) throw new Error('变长整数溢出')
  }
}

export function isContainer(c: Uint8Array): boolean {
  return c.length >= 4 && c[0] === 0x55 && c[1] === 0x43 && c[2] === 0x5a && c[3] >= 1 && c[3] <= 23
}

/** 解析 UCZ 头部：组规则与载荷长度。只读头部已写明的字段。 */
export function inspectContainer(c: Uint8Array): ContainerAnatomy {
  if (!isContainer(c)) throw new Error('不是 UCZ 容器')
  const version = c[3]
  const st = { p: 4 }
  let flags = 0
  if (version >= 19) { flags = c[st.p] | (c[st.p + 1] << 8); st.p += 2 }
  const n = getVar(c, st)
  const segs = getVar(c, st)
  const groups = getVar(c, st)
  const specs: { id: number; s: number; rRaw: number; pl: number }[] = []
  for (let i = 0; i < groups; i++) {
    const id = getVar(c, st), s = getVar(c, st), rRaw = getVar(c, st), pl = getVar(c, st)
    specs.push({ id, s, rRaw, pl })
  }
  const lengths: number[] = []
  let total = 0
  for (let i = 0; i < segs; i++) { const len = getVar(c, st); lengths.push(len); total += len }
  const members: number[][] = Array.from({ length: groups }, () => [])
  let headerBytes = st.p
  if (groups) {
    let pending = lengths.map((_, i) => i), bit = 0
    for (let gi = 0; gi + 1 < groups; gi++) {
      const next: number[] = []
      for (const i of pending) {
        const pos = st.p + Math.floor(bit / 8)
        if (pos < c.length && ((c[pos] >>> (bit % 8)) & 1)) members[gi].push(i)
        else next.push(i)
        bit++
      }
      pending = next
    }
    members[groups - 1] = pending
    // 组归属位图紧跟在分段长度之后：从 `groups > 1` 开始，每项 1 bit。
    if (groups > 1) { st.p += Math.ceil(bit / 8); headerBytes = st.p }
  }
  const segments: SegmentAnatomy[] = []
  let rawOffset = 0, idx = 0
  for (let gi = 0; gi < groups; gi++) {
    const sp = specs[gi]
    const rawLength = members[gi].reduce((sum, i) => sum + (lengths[i] ?? 0), 0)
    // 上下文/标志位都在组字 `r` 里：低 16 位是 rank（+v15/wordPre），
    // 17..19 位是上下文码，第 20 位是 matchDist，第 21 位是扩展命名空间。
    const context = (() => {
      try { return contextFromGroupBits(sp.rRaw) } catch { return undefined }
    })()
    const v15 = (sp.rRaw & 0x8000) !== 0
    const wordPre = (sp.rRaw & 0x4000) !== 0
    const matchDist = (sp.rRaw & GROUP_MATCH_DIST_BIT) !== 0
    const bcj = sp.id === 25 // ID.BCJ_V3: the only group kind that runs the x86-shaped model.
    const flags = [bcj ? 'bcj' : '', matchDist ? 'md' : '', wordPre ? 'wp' : '', v15 ? 'v15' : ''].filter(Boolean).join(' ')
    segments.push({
      index: idx++, rawOffset, rawLength, compressedBytes: sp.pl,
      bpb: rawLength ? (sp.pl * 8) / rawLength : 0,
      transformId: sp.id, transformName: transformName(sp.id),
      stride: sp.s, rank: sp.rRaw & 0x3fff,
      context, v15, wordPre, matchDist, flags,
    })
    rawOffset += rawLength
  }
  return {
    containerVersion: version, flags, totalRawBytes: n, totalCompressedBytes: c.length,
    headerBytes, overallBpb: n ? (c.length * 8) / n : 0,
    compressionRatio: n ? c.length / n : 0, segments,
  }
}

const SPARK = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588']

/**
 * 局部条件复杂度 H(x_i | x_<i>) 剖面。
 *
 * 用 `encodeCM` 的 `blockCost`（每 512 B 一小格的精确 bit 代价）在**只看前缀**的
 * 前提下测量——每个字节的代价只依赖它之前的字节，因此这是真正的因果残差，而不是
 * 事后统计。为了保持 `inspect` 快，最多读前 256 KiB。
 */
export function profileResidual(data: Uint8Array, options?: { profile?: 'text' | 'bin'; maxBytes?: number }): ResidualProfile {
  const cap = options?.maxBytes ?? 262144
  const view = data.length > cap ? data.subarray(0, cap) : data
  const blockSize = 512
  const bins = Math.max(1, Math.ceil(view.length / blockSize))
  const values = new Float32Array(bins)
  const profile = options?.profile ?? (fingerprintStream(view).printableAsciiRatio >= 0.85 ? 'text' : 'bin')
  const cmOptions = profile === 'text' ? { context: 'text-vertcol' as const, matchDist: true } : { matchDist: true }
  encodeCM(view, profile, 1, 1, undefined, 0, { values, blockSize }, undefined, 'v20', 0, false, cmOptions)
  const binsBpb: number[] = []
  for (let i = 0; i < bins; i++) {
    const len = Math.min(blockSize, view.length - i * blockSize)
    binsBpb.push(len > 0 ? values[i] / len : 0)
  }
  let sum = 0, minBpb = Infinity, maxBpb = 0
  for (const v of binsBpb) { sum += v; if (v < minBpb) minBpb = v; if (v > maxBpb) maxBpb = v }
  const meanBpb = binsBpb.length ? sum / binsBpb.length : 0
  let variance = 0
  for (const v of binsBpb) variance += (v - meanBpb) ** 2
  const sd = binsBpb.length ? Math.sqrt(variance / binsBpb.length) : 0

  // 展示用抽样：不超过 32 列，每列取该区间内的**最大值**（峰值不会被平均掉）。
  const columns = Math.min(32, binsBpb.length)
  const sparkline = Array.from({ length: columns }, (_, c) => {
    const from = Math.floor((c * binsBpb.length) / columns), to = Math.max(from + 1, Math.floor(((c + 1) * binsBpb.length) / columns))
    let peak = 0
    for (let i = from; i < to; i++) peak = Math.max(peak, binsBpb[i])
    const idx = Math.min(7, Math.max(0, Math.round((peak / 8) * 7)))
    return SPARK[idx]
  }).join('')

  const anomalies: ResidualAnomaly[] = []
  for (let i = 0; i < binsBpb.length; i++) {
    const bpb = binsBpb[i]
    const offset = i * blockSize
    const length = Math.min(blockSize, view.length - offset)
    // 冷启动：模型刚开始时的代价天然高，单独标注，不与异常混为一谈。
    if (i < 2 && bpb > meanBpb) { anomalies.push({ offset, length, bpb, kind: 'cold-start' }); continue }
    if (sd > 0 && bpb > meanBpb + 1.5 * sd && bpb > meanBpb + 1.0) {
      const kind = bpb > meanBpb + 3 * sd ? 'entropy-spike' : 'regime-shift'
      anomalies.push({ offset, length, bpb, kind })
    }
  }
  return {
    blockSize, binsBpb, sparkline, anomalies,
    minBpb: Number.isFinite(minBpb) ? minBpb : 0, maxBpb, meanBpb,
  }
}

export async function inspectStream(
  data: Uint8Array,
  options?: { compress?: boolean; level?: CompressionLevel },
): Promise<StreamInspection> {
  const t0 = performance.now()
  const fingerprint = fingerprintStream(data)
  const residual = data.length ? profileResidual(data) : undefined
  let container: ContainerAnatomy | undefined
  let compressedBytes: number | undefined
  if (options?.compress !== false && data.length > 0) {
    const enc = await compressAdaptive(data, undefined, options?.level ? { level: options.level } : undefined)
    container = inspectContainer(enc.container)
    compressedBytes = enc.container.length
  }
  return { fingerprint, container, compressedBytes, residual, elapsedMs: performance.now() - t0 }
}

export function formatInspectionReport(info: StreamInspection): string {
  const f = info.fingerprint, out: string[] = []
  out.push('=== UCZ Residual Information Microscope ===')
  out.push(`bytes                 ${f.byteLength}`)
  out.push(`H0 entropy            ${f.entropyH0.toFixed(3)} bit/byte`)
  out.push(`printable ASCII       ${(f.printableAsciiRatio * 100).toFixed(2)} %`)
  out.push(`flat bytes 00/FF      ${(f.flatByteRatio * 100).toFixed(2)} %`)
  out.push(`record stride s       ${f.detectedStride || '-'}`)
  out.push(`lag candidates        ${f.detectedLags.length ? f.detectedLags.join(', ') : '-'}`)
  out.push(`scanline period P     ${f.detectedScanPeriod || '-'}`)
  const d = f.detectedDelimiters
  out.push(`delimiters            , ${d.comma}  TAB ${d.tab}  ; ${d.semicolon}  : ${d.colon}  | ${d.pipe}  NL ${d.newline}`)
  if (d.newline) out.push(`mean line length      ${d.meanLineBytes.toFixed(1)} B`)
  out.push(`manifold class        ${f.inferredManifoldClass}`)
  if (f.rationale.length) out.push(`evidence              ${f.rationale.join(' | ')}`)
  if (info.residual) {
    const r = info.residual
    out.push('')
    out.push(`residual H(x|x<)     min ${r.minBpb.toFixed(3)} / mean ${r.meanBpb.toFixed(3)} / max ${r.maxBpb.toFixed(3)} bpb  (block ${r.blockSize} B)`)
    out.push(`sparkline             ${r.sparkline}   (0 bpb${' '.repeat(1)}\u2581 -> 8 bpb \u2588)`)
    if (r.anomalies.length) {
      out.push(`anomalies             ${r.anomalies.length} bin(s)`)
      for (const a of r.anomalies.slice(0, 8)) {
        out.push(`  @${String(a.offset).padStart(9)}  len ${String(a.length).padStart(4)}  ${a.bpb.toFixed(3)} bpb  ${a.kind}`)
      }
      if (r.anomalies.length > 8) out.push(`  ... ${r.anomalies.length - 8} more`)
    } else out.push('anomalies             none')
  }
  if (info.container) {
    const c = info.container
    out.push('')
    out.push(`container version     ${c.containerVersion}${c.flags ? ` (flags 0x${c.flags.toString(16).padStart(4, '0')})` : ''}`)
    out.push(`raw / compressed      ${c.totalRawBytes} -> ${c.totalCompressedBytes} B (${c.compressionRatio.toFixed(4)}x, ${c.overallBpb.toFixed(3)} bpb, header ${c.headerBytes} B)`)
    out.push('')
    out.push(' idx   rawOff    rawLen   compB     bpb  transform            s   r  context        flags')
    out.push(' ---  -------  --------  ------  ------  -------------------  --  --  -------------  -----')
    for (const sg of c.segments) {
      out.push(` ${String(sg.index).padStart(3)}  ${String(sg.rawOffset).padStart(7)}  ${String(sg.rawLength).padStart(8)}  ${String(sg.compressedBytes).padStart(6)}  ${sg.bpb.toFixed(3).padStart(6)}  ${sg.transformName.padEnd(19)}  ${String(sg.stride).padStart(2)}  ${String(sg.rank).padStart(2)}  ${(sg.context ?? '-').padEnd(13)}  ${sg.flags}`)
    }
  }
  out.push('')
  out.push(`elapsed               ${info.elapsedMs.toFixed(1)} ms`)
  return out.join('\n')
}
