// P2-2 探针：mozilla（Tru64/Alpha .tar）里 Alpha 32 位指令的特征统计。
// 目标：确认 BSR/BR 的 PC 相对位移是否值得做 BCJ 式重定位。
import { readFile } from 'node:fs/promises'
const raw = await readFile('/tmp/corpus/mozilla')

// 4 字节对齐扫描：统计 opcode 分布与 BSR(0x34) 的位移分布
const w = new Uint32Array(raw.buffer, raw.byteOffset, raw.length >> 2)
const op = new Uint32Array(64)
for (let i = 0; i < w.length; i++) op[(w[i] >>> 26) & 63]++
const top = [...op.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  .map(([k, v]) => ({ opcode: '0x' + k.toString(16), count: v, pct: +(v / w.length * 100).toFixed(2) }))

// BSR：低 21 位是有符号 PC 相对字偏移
let bsr = 0, bsrSmall = 0, bsrForward = 0
const dispHist = new Uint32Array(16)
for (let i = 0; i < w.length; i++) {
  const x = w[i]
  if (((x >>> 26) & 63) !== 0x34) continue
  bsr++
  let d = x & 0x1fffff
  if (d & 0x100000) d -= 0x200000
  if (d > 0) bsrForward++
  if (Math.abs(d) < 1 << 16) bsrSmall++
  const a = Math.abs(d)
  dispHist[a < 16 ? a : a < 256 ? 8 : a < 4096 ? 12 : 15]++
}

// 相邻重复块：找 len>=16 的长重复（粗粒度，验证跨区域 LZ 的潜在收益）
// 用固定大小哈希表代替 Map（51 MB 输入会超过 Map 的条目上限）：
// 每个槽位存"上一次出现的 16 字节块起点"，冲突直接覆盖（只是少算，不会多算）。
const TAB = 1 << 22
const seen = new Int32Array(TAB).fill(-1)
let longRep = 0, repBytes = 0
const W = 16
for (let i = 0; i + W <= raw.length; i += 1) {
  let h = 0
  for (let k = 0; k < W; k++) h = (Math.imul(h, 31) + raw[i + k]) | 0
  const slot = (h >>> 0) & (TAB - 1)
  const prev = seen[slot]
  if (prev !== undefined && i - prev > 4096) {
    // 确认真的相同（防哈希碰撞）
    let ok = true
    for (let k = 0; k < W; k++) if (raw[prev + k] !== raw[i + k]) { ok = false; break }
    if (ok) { longRep++; repBytes += W }
  }
  if (prev < 0) seen[slot] = i
}
console.log(JSON.stringify({
  size: raw.length, words: w.length,
  topOpcodes: top,
  bsr: { count: bsr, pct: +(bsr / w.length * 100).toFixed(2), forward: bsrForward, small: bsrSmall, hist: [...dispHist] },
  longRepeat16B: { count: longRep, bytesCoveredLowerBound: repBytes, pct: +(repBytes / raw.length * 100).toFixed(2) },
}, null, 1))
