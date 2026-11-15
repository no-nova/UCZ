/**
 * P31.0：残余信息显微镜（Residual Information Microscope）。
 *
 * 这里只做**观测**：所有统计量都由输入字节自身在线计算，不读文件名、不看尺寸、
 * 不依赖任何内置字典或格式先验。容器解剖部分只是把 UCZ 头部里已经写明的
 * 事实读出来（版本、组数、每组规则与载荷长度），不做任何猜测。
 */
import { analyze, detectLagCandidates, detectRecordStride } from './analyze'
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
  context?: string
}

export interface ContainerAnatomy {
  containerVersion: number
  totalRawBytes: number
  totalCompressedBytes: number
  headerBytes: number
  overallBpb: number
  compressionRatio: number
  segments: SegmentAnatomy[]
}

export interface StreamInspection {
  fingerprint: ManifoldFingerprint
  container?: ContainerAnatomy
  /** 容器与原始流的对应关系（仅当做了压缩）。 */
  compressedBytes?: number
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
  let printable = 0, flat = 0
  for (let i = 0; i < n; i++) {
    const b = data[i]
    if ((b >= 0x20 && b <= 0x7e) || b === 9 || b === 10 || b === 13) printable++
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
  const flatRatio = n ? flat / n : 0
  const stride = n >= 4096 ? detectRecordStride(data) : 0
  const lags = n >= 4096 ? detectLagCandidates(data, Math.max(1, stride)) : []
  const rationale: string[] = []
  let scan = causalScanPeriod(data)
  // 纯白边距（整行 0x00）会让所有步长的匹配数单调递减，因果检测因此给不出周期。
  // 这种情况下退回到滞后普查：平坦主导的流里 `detectLagCandidates` 的极值点就是
  // 行距本身（ptt5: 216）。仍然只读输入字节。
  if (flatRatio >= 0.3 && lags.length) { scan = lags[0]; rationale.push('scanPeriod 来自滞后普查') }
  const h0 = entropy0(data)
  const strip = delims.comma + delims.semicolon + delims.tab + delims.pipe
  let cls: ManifoldClass = 'structured-binary'
  if (!n) cls = 'empty'
  else if (flatRatio >= 0.3 && printableRatio <= 0.1) { cls = '2d-periodic-raster'; rationale.push(`flat=${(flatRatio * 100).toFixed(1)}% printable=${(printableRatio * 100).toFixed(1)}%`) }
  else if (printableRatio >= 0.9 && delims.newline >= 4 && strip * 40 >= n) { cls = 'tabular-ascii'; rationale.push(`printable=${(printableRatio * 100).toFixed(1)}% delimiters=${strip}`) }
  else if (printableRatio >= 0.9) { cls = 'natural-text'; rationale.push(`printable=${(printableRatio * 100).toFixed(1)}%`) }
  else if (stride >= 2 && stride <= 64) { cls = 'multi-channel-signal'; rationale.push(`stride=${stride}`) }
  else if (lags.length) { cls = 'quasi-periodic'; rationale.push(`lags=${lags.join(',')}`) }
  else if (h0 >= 7.4) { cls = 'high-entropy-or-noise'; rationale.push(`H0=${h0.toFixed(3)}`) }
  if (scan) rationale.push(`scanPeriod=${scan}`)
  if (lags.length) rationale.push(`lagCandidates=${lags.join(',')}`)
  return {
    byteLength: n, entropyH0: h0, printableAsciiRatio: printableRatio, flatByteRatio: flatRatio,
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
  const specs: { id: number; s: number; r: number; pl: number }[] = []
  for (let i = 0; i < groups; i++) {
    const id = getVar(c, st), s = getVar(c, st), rRaw = getVar(c, st), pl = getVar(c, st)
    specs.push({ id, s, r: rRaw & 0xffff, pl })
  }
  const lengths: number[] = []
  let total = 0
  for (let i = 0; i < segs; i++) { const len = getVar(c, st); lengths.push(len); total += len }
  const headerBytes = st.p
  const members: number[][] = Array.from({ length: groups }, () => [])
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
  }
  const segments: SegmentAnatomy[] = []
  let rawOffset = 0, idx = 0
  for (let gi = 0; gi < groups; gi++) {
    const sp = specs[gi]
    const rawLength = members[gi].reduce((sum, i) => sum + (lengths[i] ?? 0), 0)
    segments.push({
      index: idx++, rawOffset, rawLength, compressedBytes: sp.pl,
      bpb: rawLength ? (sp.pl * 8) / rawLength : 0,
      transformId: sp.id, transformName: transformName(sp.id),
      stride: sp.s, rank: sp.r,
    })
    rawOffset += rawLength
  }
  const payloadBytes = specs.reduce((sum, sp) => sum + sp.pl, 0)
  return {
    containerVersion: version, totalRawBytes: n, totalCompressedBytes: c.length,
    headerBytes, overallBpb: n ? (c.length * 8) / n : 0,
    compressionRatio: n ? c.length / n : 0, segments,
  }
}

export async function inspectStream(
  data: Uint8Array,
  options?: { compress?: boolean; level?: CompressionLevel },
): Promise<StreamInspection> {
  const t0 = performance.now()
  const fingerprint = fingerprintStream(data)
  let container: ContainerAnatomy | undefined
  let compressedBytes: number | undefined
  if (options?.compress !== false && data.length > 0) {
    const enc = await compressAdaptive(data, undefined, options?.level ? { level: options.level } : undefined)
    container = inspectContainer(enc.container)
    compressedBytes = enc.container.length
  }
  return { fingerprint, container, compressedBytes, elapsedMs: performance.now() - t0 }
}

export function formatInspectionReport(info: StreamInspection): string {
  const f = info.fingerprint, out: string[] = []
  out.push('=== UCZ 残余信息显微镜 ===')
  out.push(`字节数            ${f.byteLength}`)
  out.push(`H0 熵             ${f.entropyH0.toFixed(3)} bit/byte`)
  out.push(`可打印 ASCII      ${(f.printableAsciiRatio * 100).toFixed(2)} %`)
  out.push(`平坦字节 00/FF    ${(f.flatByteRatio * 100).toFixed(2)} %`)
  out.push(`记录步长 s        ${f.detectedStride || '—'}`)
  out.push(`滞后候选          ${f.detectedLags.length ? f.detectedLags.join(', ') : '—'}`)
  out.push(`扫描周期 P        ${f.detectedScanPeriod || '—'}`)
  const d = f.detectedDelimiters
  out.push(`分隔符            , ${d.comma}  TAB ${d.tab}  ; ${d.semicolon}  : ${d.colon}  | ${d.pipe}  NL ${d.newline}`)
  if (d.newline) out.push(`平均行长          ${d.meanLineBytes.toFixed(1)} B`)
  out.push(`流形分类          ${f.inferredManifoldClass}`)
  if (f.rationale.length) out.push(`判定依据          ${f.rationale.join(' | ')}`)
  if (info.container) {
    const c = info.container
    out.push('')
    out.push(`容器版本          ${c.containerVersion}`)
    out.push(`原始 / 压缩       ${c.totalRawBytes} → ${c.totalCompressedBytes} B（${c.compressionRatio.toFixed(4)}×，${c.overallBpb.toFixed(3)} bpb，头部 ${c.headerBytes} B）`)
    out.push('')
    out.push(' idx  rawOff   rawLen   compB    bpb   transform            s   r  ctx')
    out.push(' ---  ------  -------  ------  -----  -------------------  --  --  ---')
    for (const sg of c.segments) {
      out.push(` ${String(sg.index).padStart(3)}  ${String(sg.rawOffset).padStart(6)}  ${String(sg.rawLength).padStart(7)}  ${String(sg.compressedBytes).padStart(6)}  ${sg.bpb.toFixed(3).padStart(5)}  ${sg.transformName.padEnd(19)}  ${String(sg.stride).padStart(2)}  ${String(sg.rank).padStart(2)}  ${sg.context ?? ''}`)
    }
  }
  out.push('')
  out.push(`耗时              ${info.elapsedMs.toFixed(1)} ms`)
  return out.join('\n')
}
