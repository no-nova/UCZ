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
/**
 * 词典统计：滚动哈希 + 开地址计数表。
 *
 * 原实现对每个起点做 len=1..24 的**增量字符串拼接**再插入 `Map<string,number>`，
 * 低基数流（DNA 的 4 个符号）每个位置都要生成 22 个新字符串，是纯分配开销。
 * 这里用 32 位滚动哈希定位槽位，命中后按字节精确比较，因此统计结果与旧实现
 * **完全一致**（不是近似），只是不再分配字符串。
 *
 * 容量必须按**插入次数**（n × 22）取 2 的幂：按 2n 定容会让表填满、
 * 线性探测退化成 O(n)。
 */
function buildTokenDictHash(sample: Uint8Array, k: number, extended: boolean): string[] {
  const n = sample.length
  const MAXLEN = 24
  let cap = 16
  while (cap < Math.max(16, n * (MAXLEN - 2)) * 1.35 && cap < (1 << 23)) cap <<= 1
  const mask = cap - 1
  const keys = new Int32Array(cap)   // 0 = 空槽
  const first = new Int32Array(cap)  // (pos << 5) | len，用于按字节复验
  const counts = new Uint32Array(cap)
  let used = 0
  const probe = (h: number, pos: number, len: number): number => {
    let slot = h & mask
    for (;;) {
      const key = keys[slot]
      if (key === 0) {
        if (used * 4 > cap * 3) return -1 // 表已满：调用方退回 Map 路径
        keys[slot] = h | 1 // 保证非零
        first[slot] = (pos << 5) | len
        counts[slot] = 1
        used++
        return -1
      }
      if (key === (h | 1)) {
        const at = first[slot]
        if (((at & 31) === len) && (at >>> 5) === pos) { counts[slot]++; return -1 }
        let same = true
        const p0 = at >>> 5, l0 = at & 31
        if (l0 === len) {
          for (let j = 0; j < len; j++) if (sample[p0 + j] !== sample[pos + j]) { same = false; break }
        } else same = false
        if (same) { counts[slot]++; return -1 }
      }
      slot = (slot + 1) & mask
      if (slot === (h & mask)) return -1 // 走了一整圈
    }
  }
  for (let i = 0; i < n; i++) {
    let h = 0x811c9dc5
    for (let len = 1; len <= MAXLEN && i + len <= n; len++) {
      const c = sample[i + len - 1]
      if (!tokenChar(c, extended)) break
      h = Math.imul(h ^ c, 0x01000193)
      if (len >= 3) probe(h >>> 0, i, len)
    }
  }
  const ranked: { word: string; gain: number }[] = []
  for (let slot = 0; slot < cap; slot++) {
    const key = keys[slot]
    if (!key) continue
    const at = first[slot], pos = at >>> 5, len = at & 31, count = counts[slot]
    const gain = count * (len - 1) - (len + 1)
    if (gain <= 0) continue
    let word = ''
    for (let j = 0; j < len; j++) word += String.fromCharCode(sample[pos + j])
    ranked.push({ word, gain })
  }
  return finishDict(ranked, sample, k)
}

/** 与旧实现相同的排序、命中模拟与截断（字节级一致的最后一步）。 */
function finishDict(ranked: { word: string; gain: number }[], sample: Uint8Array, k: number): string[] {
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

export function buildTokenDict(buf: Uint8Array, k = MAX_TOKENS, extended = false): string[] {
  const sample = dictionarySample(buf, DICT_SAMPLE_MAX)
  if (sample.length === 0) return []
  return buildTokenDictHash(sample, k, extended)
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
