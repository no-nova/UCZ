// WORD-PRE：面向结构化文本的词元预坍缩（P3-2）。
//
// 动机：CM 的字节窗口只有 b1..b8。对 XML/HTML 这类重复标记密集的流，
// 先把高频多字节词元坍缩成单字节 Token，可以显著缩短待编码字节数，
// 让 CM 的窗口从"8 个字母"扩展到"前几个完整词元"。
//
// 实测边界（scripts/diag/probe-wordpre2.ts）：
//   xml   −11.9%（坍缩率 0.513）
//   nci    −1.5%（坍缩率 0.406）
//   webster +5.0% / dickens +8.1% / reymont +1.0% / ooffice +3.0% —— 自然语言与
//   二进制一律退化，因为 CM 本来就能把字母级上下文用到极致，替换反而毁了它。
// 所以这一层**只作为分组级可选预变换**，由调用方严格 A/B 择优。
//
// 格式：词典头 = varint(词条数) + 每条 varint(len) + 原始字节；正文用
// 0x80..0x80+K-1 表示词元，0x7F 作为转义前缀保护原始 >=0x7F 的字节。
// 完全确定性，解码只依赖词典，不依赖任何自适应状态。

export const MAX_TOKENS = 120
/** 词元的判定字符集：字母/数字与常见标记符号。 */
function isWordChar(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) ||
    c === 32 || c === 0x2e || c === 0x2c || c === 0x3c || c === 0x3e || c === 0x2f || c === 0x5f
}

/** 扫描 3..12 字节的高频子串，返回按净收益排序的候选。 */
function countTokens(buf: Uint8Array): Map<string, number> {
  const counts = new Map<string, number>()
  const n = buf.length
  for (let i = 0; i < n; i++) {
    if (!isWordChar(buf[i])) continue
    for (let len = 3; len <= 12 && i + len <= n; len++) {
      if (!isWordChar(buf[i + len - 1])) break
      const key = String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + len)))
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return counts
}

/** P12.0: at most 240 positive raw candidates, then price actual greedy hits.
 * The wire dictionary is still v1 (<=120 one-byte tokens, lengths 3..24).
 * Counting and hit simulation are bounded to 256 KiB, even for direct callers. */
const DICT_SAMPLE_MAX = 256 * 1024
const RAW_POOL_MAX = 240
function dictionarySample(buf: Uint8Array, budget: number): Uint8Array {
  const total = Math.max(1, Math.min(DICT_SAMPLE_MAX, Math.floor(budget)))
  if (buf.length <= total) return buf
  const win = Math.min(32 * 1024, total), count = Math.max(1, Math.floor(total / win))
  const out = new Uint8Array(win * count)
  for (let i = 0; i < count; i++) {
    const off = Math.floor((buf.length - win) * i / Math.max(1, count - 1))
    out.set(buf.subarray(off, off + win), i * win)
  }
  return out
}
function tokenChar(c: number, extended: boolean): boolean {
  return isWordChar(c) || (extended && (c === 61 || c === 34 || c === 58 || c === 45 || c === 10 || c === 9))
}
export function buildTokenDict(buf: Uint8Array, k = MAX_TOKENS, extended = false): string[] {
  const sample = dictionarySample(buf, DICT_SAMPLE_MAX), counts = new Map<string, number>()
  // Incremental strings avoid an allocation of a byte array at every length.
  for (let i = 0; i < sample.length; i++) {
    let word = ''
    for (let len = 1; len <= 24 && i + len <= sample.length; len++) {
      const c = sample[i + len - 1]
      if (!tokenChar(c, extended)) break
      word += String.fromCharCode(c)
      if (len >= 3) counts.set(word, (counts.get(word) ?? 0) + 1)
    }
  }
  const ranked: { word: string; gain: number }[] = []
  for (const [word, count] of counts) {
    const gain = count * (word.length - 1) - (word.length + 1)
    if (gain > 0) ranked.push({ word, gain })
  }
  ranked.sort((a, b) => b.gain - a.gain || (a.word < b.word ? -1 : 1))
  const pool = ranked.slice(0, RAW_POOL_MAX).map(x => x.word)
  const buckets = new Map<number, number[]>()
  pool.forEach((w, i) => {
    const c = w.charCodeAt(0), list = buckets.get(c) ?? []
    list.push(i); buckets.set(c, list)
  })
  for (const list of buckets.values()) list.sort((a, b) => pool[b].length - pool[a].length || a - b)
  const hits = new Uint32Array(pool.length)
  for (let i = 0; i < sample.length;) {
    let hit = -1
    for (const d of buckets.get(sample[i]) ?? []) {
      const w = pool[d]
      if (i + w.length > sample.length) continue
      let j = 1
      while (j < w.length && sample[i + j] === w.charCodeAt(j)) j++
      if (j === w.length) { hit = d; break }
    }
    if (hit < 0) i++
    else { hits[hit]++; i += pool[hit].length }
  }
  return pool.map((word, i) => ({ word, gain: hits[i] * (word.length - 1) - (word.length + 1) }))
    .filter(x => x.gain > 0)
    .sort((a, b) => b.gain - a.gain || (a.word < b.word ? -1 : 1))
    .slice(0, Math.max(0, Math.min(MAX_TOKENS, Math.floor(k)))).map(x => x.word)
}

function putVar(out: number[], v: number): void {
  while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v >>>= 7 }
  out.push(v)
}

function getVar(buf: Uint8Array, st: { p: number }): number {
  let v = 0, shift = 0
  for (;;) {
    if (st.p >= buf.length) throw new Error('词元词典被截断')
    const b = buf[st.p++]
    v |= (b & 0x7f) << shift
    if (b < 0x80) return v
    shift += 7
    if (shift > 28) throw new Error('词元词典长度非法')
  }
}

/** 词典头的字节表示（不含主体）。 */
export function dictHeader(dict: string[]): Uint8Array {
  const out: number[] = []
  putVar(out, dict.length)
  for (const w of dict) {
    putVar(out, w.length)
    for (let i = 0; i < w.length; i++) out.push(w.charCodeAt(i) & 255)
  }
  return Uint8Array.from(out)
}

export interface WordPreResult { dict: string[]; header: Uint8Array; body: Uint8Array }

/** 正向：统计 → 选词 → 坍缩。 */
export function wordPreFwd(buf: Uint8Array, k = MAX_TOKENS): WordPreResult | null {
  return wordPreFwdSampled(buf, DICT_SAMPLE_MAX, k)
}

/** 逆向：读词典头 → 还原。 */
export function wordPreInv(header: Uint8Array, body: Uint8Array, outLen: number): Uint8Array {
  const st = { p: 0 }
  const count = getVar(header, st)
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_TOKENS) throw new Error('词元数量非法')
  const dict: string[] = []
  const lens: number[] = []
  for (let i = 0; i < count; i++) {
    const len = getVar(header, st)
    if (!Number.isSafeInteger(len) || len < 1 || len > 255 || st.p + len > header.length) throw new Error('词元长度非法')
    let w = ''
    for (let j = 0; j < len; j++) w += String.fromCharCode(header[st.p++])
    dict.push(w); lens.push(len)
  }
  if (st.p !== header.length) throw new Error('词元词典含多余数据')
  const out = new Uint8Array(outLen)
  let w = 0, i = 0
  while (i < body.length) {
    const b = body[i++]
    if (b === 0x7f) {
      if (i >= body.length) throw new Error('词元流转义被截断')
      if (w >= outLen) throw new Error('词元流溢出')
      out[w++] = body[i++]
    } else if (b >= 0x80) {
      const d = b - 0x80
      if (d >= dict.length) throw new Error('词元索引越界')
      const tok = dict[d]
      if (w + tok.length > outLen) throw new Error('词元流溢出')
      for (let j = 0; j < tok.length; j++) out[w++] = tok.charCodeAt(j)
    } else {
      if (w >= outLen) throw new Error('词元流溢出')
      out[w++] = b
    }
  }
  if (w !== outLen) throw new Error('词元流长度校验失败')
  return out
}


/** 用固定词表坍缩整段（首字节分桶，避免逐位置扫全部词条）。 */
export function collapseWithDict(buf: Uint8Array, dict: string[]): Uint8Array | null {
  if (!dict.length) return null
  const buckets = new Map<number, number[]>()
  for (let d = 0; d < dict.length; d++) {
    const c = dict[d].charCodeAt(0)
    const arr = buckets.get(c)
    if (arr) arr.push(d); else buckets.set(c, [d])
  }
  // 长词优先，保证"最长匹配"，与解码端的确定性无关但能让坍缩率更高。
  for (const arr of buckets.values()) arr.sort((a, b) => dict[b].length - dict[a].length)
  const out: number[] = []
  const n = buf.length
  let i = 0
  while (i < n) {
    const arr = buckets.get(buf[i])
    let hit = -1
    if (arr) {
      for (const d of arr) {
        const w = dict[d]
        if (w.length > n - i) continue
        let ok = true
        for (let j = 1; j < w.length; j++) if (buf[i + j] !== w.charCodeAt(j)) { ok = false; break }
        if (ok) { hit = d; break }
      }
    }
    if (hit >= 0) { out.push(0x80 + hit); i += dict[hit].length }
    else {
      const b = buf[i++]
      if (b >= 0x7f) { out.push(0x7f); out.push(b) }
      else out.push(b)
    }
  }
  return Uint8Array.from(out)
}

/**
 * P4：采样建表 + 整段坍缩。
 *
 * 全量统计是 O(n·10) 的字符串构造，几十 MB 的分组根本跑不动；而词表只需要
 * "该区域里高频的结构化片段"，用均匀分布的若干窗口统计即可。采样位置**固定**，
 * 因此编码完全确定；解码只依赖词典头，不依赖采样。
 */
export function wordPreFwdSampled(buf: Uint8Array, sampleTotal = DICT_SAMPLE_MAX, k = MAX_TOKENS): WordPreResult | null {
  const sample = dictionarySample(buf, sampleTotal)
  let best: WordPreResult | null = null
  for (const extended of [false, true]) {
    const dict = buildTokenDict(sample, k, extended)
    // Retokenize AFTER pruning; do not truncate/remap a pooled token stream.
    const body = collapseWithDict(buf, dict)
    if (!body) continue
    const header = dictHeader(dict)
    if (!best || header.length + body.length < best.header.length + best.body.length) best = { dict, header, body }
  }
  return best
}

/** 自定界的词典头长度（从 payload 起始处解析），失败返回 -1。 */
export function dictHeaderLen(buf: Uint8Array): number {
  const st = { p: 0 }
  let count: number
  try { count = getVar(buf, st) } catch { return -1 }
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_TOKENS) return -1
  for (let i = 0; i < count; i++) {
    let len: number
    try { len = getVar(buf, st) } catch { return -1 }
    if (!Number.isSafeInteger(len) || len < 1 || len > 255) return -1
    st.p += len
    if (st.p > buf.length) return -1
  }
  return st.p
}

// ===== P4：分块自适应 WORD-PRE（实测劣于整段采样，保留作对照）=====
// 大文件不同段落的高频标记不同（xml 上 512 KB 块省 12%，2 MiB 整块只省 2.7%）。
// 解法：按固定子块独立统计微型词表，每个窗口都能吃到满额收益。
//
// 封装格式（作为 TEXT_V3 分组载荷的前缀）：
//   varint(块大小) varint(块数) 然后每块: varint(headerLen) header body
// 解码只需顺序读，完全确定性。

export const WORD_PRE_CHUNK = 256 * 1024

export interface WordPreChunked { chunks: number; raw: Uint8Array }

function putVarArr(out: number[], v: number): void { putVar(out, v) }

/** 分块编码：每块独立选词表，输出可直接喂给 CM。 */
export function wordPreChunkedFwd(buf: Uint8Array, chunkSize = WORD_PRE_CHUNK, k = MAX_TOKENS): WordPreChunked | null {
  const out: number[] = []
  const parts: { header: Uint8Array; body: Uint8Array; size: number }[] = []
  let totalDict = 0
  for (let off = 0; off < buf.length; off += chunkSize) {
    const chunk = buf.subarray(off, Math.min(buf.length, off + chunkSize))
    const pre = wordPreFwd(chunk, k)
    if (!pre) return null
    totalDict += pre.header.length
    parts.push({ header: pre.header, body: pre.body, size: chunk.length })
  }
  if (!parts.length) return null
  // 词表总开销必须远小于收益，否则不值得
  putVarArr(out, chunkSize)
  putVarArr(out, parts.length)
  for (const p of parts) {
    putVarArr(out, p.header.length)
    for (const b of p.header) out.push(b)
    for (const b of p.body) out.push(b)
  }
  return { chunks: parts.length, raw: Uint8Array.from(out) }
}

/** 分块解码。outLen 是原始总长度，用于校验。 */
export function wordPreChunkedInv(payload: Uint8Array, outLen: number): Uint8Array {
  const st = { p: 0 }
  const chunkSize = getVar(payload, st)
  const count = getVar(payload, st)
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1024 || chunkSize > 16 * 1024 * 1024) throw new Error('词元块大小非法')
  if (!Number.isSafeInteger(count) || count < 1 || count > (outLen / 1024 | 0) + 2) throw new Error('词元块数非法')
  const out = new Uint8Array(outLen)
  let w = 0
  for (let i = 0; i < count; i++) {
    const hl = getVar(payload, st)
    if (!Number.isSafeInteger(hl) || hl < 0 || st.p + hl > payload.length) throw new Error('词元词典被截断')
    const header = payload.subarray(st.p, st.p + hl); st.p += hl
    const size = Math.min(chunkSize, outLen - w)
    if (size <= 0) throw new Error('词元块溢出')
    // 本块正文长度 = 解码这一块所需的字节数，只能边解边算：
    // 必须传 size（本块原始字节数）而不是剩余量，否则非末块会越过块边界。
    const { body, used } = peekBody(payload, st.p, header, size)
    st.p += used
    out.set(wordPreInv(header, body, size), w)
    w += size
  }
  if (w !== outLen) throw new Error('词元流长度校验失败')
  return out
}

/** 从 payload[pos..] 里解出正好能产出 outLen 字节的正文长度。 */
function peekBody(payload: Uint8Array, pos: number, header: Uint8Array, outLen: number): { body: Uint8Array; used: number } {
  const st = { p: 0 }
  const count = getVar(header, st)
  const lens: number[] = []
  for (let i = 0; i < count; i++) {
    const len = getVar(header, st)
    lens.push(len)
    st.p += len
  }
  // 模拟解码到凑满 outLen
  const size = Math.min(outLen, Number.MAX_SAFE_INTEGER)
  let w = 0, i = pos
  while (i < payload.length && w < size) {
    const b = payload[i]
    if (b === 0x7f) { i += 2; w += 1 }
    else if (b >= 0x80) { const d = b - 0x80; if (d >= lens.length) throw new Error('词元索引越界'); i += 1; w += lens[d] }
    else { i += 1; w += 1 }
  }
  if (w !== size) throw new Error('词元块被截断')
  return { body: payload.subarray(pos, i), used: i - pos }
}

// ===== P5-2：WORD-PRE v2（尾随空格吞并 + 1/2 字节双层词表）=====
//
// v1 只在 xml / nci 上有效，自然语言（dickens / webster / reymont）一律退化。
// 两个原因：
//   1. 词表只有 120 条、且每个词元都要吃掉 1 个字节码位，覆盖率太低；
//   2. 词元之间仍夹着 ' '（0x20）—— 既浪费字节，又让相邻单词在 b1..b8 里
//      永远无法直接相邻。
// v2 的做法：
//   * **尾随空格吞并**：词元直接吃掉紧跟其后的那一个空格（"the "、"of "），
//     正文里的空格就凭空消失了，相邻词元在字节流里紧挨；
//   * **双层码位**：Top-K1 用 1 字节码（0x80..0xBF，K1 ≤ 64），次高频用
//     2 字节码（lead 0xC0..0xC7 × idx，K2 ≤ 2048），容量提升一个数量级；
//   * 每个词条的入选判据都是**净收益为正**：count·(len-cost) > len+1。
//
// 码位布局（与 v1 不兼容，因此用载荷长度前缀的最高位区分，见 codec.ts）：
//   0x00..0x7E  原样字节
//   0x7F        转义：下一个字节是原样字节（用于 ≥0x7F 的原始字节）
//   0x80..0xBF  1 字节词元（索引 0..63）
//   0xC0..0xC7  2 字节词元的 lead，紧随 1 个索引字节
export const WP2_MAX_ONE = 127
export const WP2_MAX_TWO = 256
const WP2_ESC = 0x7f
const WP2_ONE_BASE = 0x80
/** 2 字节词元的唯一 lead：0xFF（后面跟 1 个索引字节）。 */
const WP2_LEAD = 0xff

export interface WordPreDict2 { one: string[]; two: string[] }
export interface WordPreResult2 { dict: WordPreDict2; header: Uint8Array; body: Uint8Array }

/** 词元可用的字符集：字母/数字/下划线/撇号（不吞标点，避免和空格混淆）。 */
function isWordChar2(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 0x5f || c === 0x27
}

/** 统计候选：整词，以及"整词 + 紧跟的单个空格"。 */
function countCandidates2(buf: Uint8Array): Map<string, number> {
  const counts = new Map<string, number>()
  const n = buf.length
  let i = 0
  while (i < n) {
    if (!isWordChar2(buf[i])) { i++; continue }
    let j = i
    while (j < n && isWordChar2(buf[j])) j++
    const len = j - i
    if (len >= 2 && len <= 32) {
      const word = String.fromCharCode.apply(null, Array.from(buf.subarray(i, j)))
      counts.set(word, (counts.get(word) ?? 0) + 1)
      // 尾随空格：只有当它是"一个空格且不是连续空白的开头"时才吞并，
      // 这样同一词元的每次出现形态一致（连续空白交给原样字节处理）。
      if (j < n && buf[j] === 0x20 && (j + 1 >= n || buf[j + 1] !== 0x20)) {
        const glued = word + ' '
        counts.set(glued, (counts.get(glued) ?? 0) + 1)
      }
    }
    i = j
  }
  return counts
}

/**
 * 选词表：先按"1 字节码能省多少"挑 K1，再按"2 字节码能省多少"挑 K2。
 * 同一条目不会同时占两档；净收益为负的一律不入表。
 */
export function buildDict2(buf: Uint8Array, k1 = WP2_MAX_ONE, k2 = WP2_MAX_TWO): WordPreDict2 {
  // 候选来自两路：
  //   1. v1 的宽字符集子串统计（能把 "</"、"=\"" 这类结构化标记抓出来，
  //      xml / nci 靠的就是它们）；
  //   2. 整词 + 尾随空格（自然语言靠它，顺带消灭正文里的空格字节）。
  // 两路合流后统一按"净收益"排序，谁赚得多谁进表。
  const counts = countTokens(buf)
  for (const [w, c] of countCandidates2(buf)) counts.set(w, (counts.get(w) ?? 0) + c)
  const scored = [...counts.entries()]
    .filter(([w]) => w.length >= 2 && w.length <= 32)
    .map(([w, c]) => ({ w, c, g1: c * (w.length - 1) - (w.length + 1), g2: c * (w.length - 2) - (w.length + 1) }))
  const byOne = scored.filter(x => x.g1 > 0).sort((a, b) => b.g1 - a.g1 || (a.w < b.w ? -1 : 1)).slice(0, k1)
  const taken = new Set(byOne.map(x => x.w))
  const byTwo = scored.filter(x => !taken.has(x.w) && x.g2 > 0)
    .sort((a, b) => b.g2 - a.g2 || (a.w < b.w ? -1 : 1))
    .slice(0, k2)
  // **编号顺序 = 频次顺序**：高频词元拿到低位索引，2 字节词元的索引字节分布
  // 因此呈 Zipf 形状，低阶上下文（b1/b2）才压得动。之前按长度编号会让索引
  // 字节接近随机，实测自然语言上多损失 2~5%。
  // （匹配仍按"最长优先"，那是 collapseWithDict2 内部的事，与编号无关。）
  const one = byOne.map(x => x.w)
  const two = byTwo.map(x => x.w)
  return { one, two }
}

export function dictHeader2(d: WordPreDict2): Uint8Array {
  const out: number[] = []
  putVar(out, d.one.length)
  putVar(out, d.two.length)
  for (const list of [d.one, d.two]) {
    for (const w of list) {
      putVar(out, w.length)
      for (let i = 0; i < w.length; i++) out.push(w.charCodeAt(i) & 255)
    }
  }
  return Uint8Array.from(out)
}

/** 读 v2 词典头（返回词典与头长度）。 */
export function dictHeaderLen2(buf: Uint8Array): number {
  const st = { p: 0 }
  let n1: number, n2: number
  try { n1 = getVar(buf, st); n2 = getVar(buf, st) } catch { return -1 }
  if (!Number.isSafeInteger(n1) || n1 < 0 || n1 > WP2_MAX_ONE) return -1
  if (!Number.isSafeInteger(n2) || n2 < 0 || n2 > 256) return -1
  for (let i = 0; i < n1 + n2; i++) {
    let len: number
    try { len = getVar(buf, st) } catch { return -1 }
    if (!Number.isSafeInteger(len) || len < 1 || len > 255) return -1
    st.p += len
    if (st.p > buf.length) return -1
  }
  return st.p
}

/** 用固定 v2 词表坍缩整段（首字节分桶 + 最长匹配）。 */
export function collapseWithDict2(buf: Uint8Array, d: WordPreDict2): Uint8Array | null {
  const one = d.one, two = d.two
  if (!one.length && !two.length) return null
  type Ent = { idx: number; two: boolean; w: string }
  const buckets = new Map<number, Ent[]>()
  const push = (w: string, idx: number, isTwo: boolean) => {
    const c = w.charCodeAt(0)
    const arr = buckets.get(c)
    const e = { idx, two: isTwo, w }
    if (arr) arr.push(e); else buckets.set(c, [e])
  }
  one.forEach((w, i) => push(w, i, false))
  two.forEach((w, i) => push(w, i, true))
  for (const arr of buckets.values()) arr.sort((a, b) => b.w.length - a.w.length || a.idx - b.idx)
  const out: number[] = []
  const n = buf.length
  let i = 0
  while (i < n) {
    const arr = buckets.get(buf[i])
    let hit: Ent | null = null
    if (arr) {
      for (const e of arr) {
        const w = e.w
        if (w.length > n - i) continue
        let ok = true
        for (let j = 1; j < w.length; j++) if (buf[i + j] !== w.charCodeAt(j)) { ok = false; break }
        if (ok) { hit = e; break }
      }
    }
    if (hit) {
      if (hit.two) { out.push(WP2_LEAD); out.push(hit.idx & 255) }
      else out.push(WP2_ONE_BASE + hit.idx)
      i += hit.w.length
    } else {
      const b = buf[i++]
      if (b >= WP2_ESC) { out.push(WP2_ESC); out.push(b) }
      else out.push(b)
    }
  }
  return Uint8Array.from(out)
}

/** 逆向：v2 词典头 → 还原。 */
export function wordPreInv2(header: Uint8Array, body: Uint8Array, outLen: number): Uint8Array {
  const st = { p: 0 }
  const n1 = getVar(header, st)
  const n2 = getVar(header, st)
  if (!Number.isSafeInteger(n1) || n1 < 0 || n1 > WP2_MAX_ONE) throw new Error('词元数量非法')
  if (!Number.isSafeInteger(n2) || n2 < 0 || n2 > 256) throw new Error('词元数量非法')
  const read = (count: number): string[] => {
    const list: string[] = []
    for (let i = 0; i < count; i++) {
      const len = getVar(header, st)
      if (!Number.isSafeInteger(len) || len < 1 || len > 255 || st.p + len > header.length) throw new Error('词元长度非法')
      let w = ''
      for (let j = 0; j < len; j++) w += String.fromCharCode(header[st.p++])
      list.push(w)
    }
    return list
  }
  const one = read(n1)
  const two = read(n2)
  if (st.p !== header.length) throw new Error('词元词典含多余数据')
  const out = new Uint8Array(outLen)
  let w = 0, i = 0
  while (i < body.length) {
    const b = body[i++]
    let tok: string
    if (b === WP2_ESC) {
      if (i >= body.length) throw new Error('词元流转义被截断')
      if (w >= outLen) throw new Error('词元流溢出')
      out[w++] = body[i++]
      continue
    } else if (b === WP2_LEAD) {
      if (i >= body.length) throw new Error('词元流被截断')
      const idx = body[i++]
      if (idx >= two.length) throw new Error('词元索引越界')
      tok = two[idx]
    } else if (b >= WP2_ONE_BASE) {
      const idx = b - WP2_ONE_BASE
      if (idx >= one.length) throw new Error('词元索引越界')
      tok = one[idx]
    } else {
      if (w >= outLen) throw new Error('词元流溢出')
      out[w++] = b
      continue
    }
    if (w + tok.length > outLen) throw new Error('词元流溢出')
    for (let j = 0; j < tok.length; j++) out[w++] = tok.charCodeAt(j)
  }
  if (w !== outLen) throw new Error('词元流长度校验失败')
  return out
}

/** v2 正向：采样建表 + 整段坍缩。 */
export function wordPreFwd2Sampled(buf: Uint8Array, sampleTotal = 256 * 1024, k1 = WP2_MAX_ONE, k2 = WP2_MAX_TWO): WordPreResult2 | null {
  const sample = sampleWindows(buf, sampleTotal)
  const dict = buildDict2(sample, k1, k2)
  if (!dict.one.length && !dict.two.length) return null
  const body = collapseWithDict2(buf, dict)
  if (!body) return null
  return { dict, header: dictHeader2(dict), body }
}

/** v2 采样窗口（与 v1 相同的固定采样，保证确定性）。 */
export function sampleWindows(buf: Uint8Array, sampleTotal = 256 * 1024): Uint8Array {
  if (buf.length <= sampleTotal) return buf
  const win = 32 * 1024
  const cnt = Math.max(1, Math.min(32, Math.floor(sampleTotal / win)))
  const sample = new Uint8Array(win * cnt)
  for (let i = 0; i < cnt; i++) {
    const off = Math.floor((buf.length - win) * i / Math.max(1, cnt - 1))
    sample.set(buf.subarray(off, off + win), i * win)
  }
  return sample
}

/** 模式无关的解码入口：mode=1 走 v1 词表，mode=2 走 v2。 */
export function wordPreInvMode(mode: number, header: Uint8Array, body: Uint8Array, outLen: number): Uint8Array {
  return mode === 2 ? wordPreInv2(header, body, outLen) : wordPreInv(header, body, outLen)
}

/** 模式无关的词典头长度解析。 */
export function dictHeaderLenMode(buf: Uint8Array, mode: number): number {
  return mode === 2 ? dictHeaderLen2(buf) : dictHeaderLen(buf)
}
