// P5-4：LZ-PRE —— 长距离精确重复块的预坍缩（实验版本）。
//
// 动机：mozilla / samba 里有大量 ≥16 字节的跨区域精确重复。`mht8` 能定位到它们，
// 但 CM 仍要逐比特把"匹配预测"与另外 9 个局部上下文混合投票，长块上的收益被
// 摊薄。先把这些块换成"长度 + 距离"的 5 字节描述，CM 只需要编码一个可预测的
// 指令流。
//
// 格式（严格可逆，与 WORD-PRE 类似但面向二进制）：
//   esc            选输入中出现次数最少的字节
//   [esc, 0]       原始的 esc 字节
//   [esc, len-15]  长度 1 字节 → 16..270（更长的匹配由编码端切成多段）
//   [d0, d1, d2]   距离，小端 24 位（1..16777215）
// 其余字节原样输出。
//
// 注意：短匹配（< MIN_LEN）**一律不碰**，留给 CM 内部的匹配模型处理；
// 这正是它与"通用 LZ"的区别——它只负责"CM 用不上或吃不透"的长块。
export const LZ_MIN_LEN = 16
export const LZ_MAX_DIST = 0xffffff

export interface LzPreResult { esc: number; body: Uint8Array; matches: number; covered: number }

/** 选转义字节：出现次数最少的字节（并列时取数值最小的，保证确定性）。 */
export function pickEscape(data: Uint8Array): number {
  const count = new Uint32Array(256)
  for (let i = 0; i < data.length; i++) count[data[i]]++
  let best = 0
  for (let b = 1; b < 256; b++) if (count[b] < count[best]) best = b
  return best
}

export function lzPreFwd(data: Uint8Array, minLen = LZ_MIN_LEN): LzPreResult {
  const n = data.length
  const esc = pickEscape(data)
  const bits = Math.min(21, Math.max(12, Math.ceil(Math.log2(Math.max(n, 2)))))
  const table = new Int32Array(1 << bits).fill(-1)
  const mask = (1 << bits) - 1
  const shift = 32 - bits
  const out = new Uint8Array(n + (n >> 3) + 64)
  let w = 0
  let matches = 0, covered = 0
  let i = 0
  const emitRaw = (b: number) => {
    if (b === esc) { out[w++] = esc; out[w++] = 0 }
    else out[w++] = b
  }
  while (i < n) {
    let bestLen = 0, bestDist = 0
    if (i + 8 <= n) {
      let h = 2166136261
      for (let k = 0; k < 8; k++) h = Math.imul(h ^ data[i + k], 16777619)
      const slot = (h ^ (h >>> 15)) & mask
      const cand = table[slot]
      table[slot] = i
      if (cand >= 0) {
        const dist = i - cand
        if (dist >= 1 && dist <= LZ_MAX_DIST) {
          let l = 0
          while (i + l < n && cand + l < i && data[cand + l] === data[i + l]) l++
          if (l >= minLen) { bestLen = l; bestDist = dist }
        }
      }
    } else {
      void shift
    }
    if (bestLen >= minLen) {
      let left = bestLen
      while (left >= minLen) {
        const take = Math.min(270, left)
        if (take < minLen) break
        out[w++] = esc
        out[w++] = take - 15
        out[w++] = bestDist & 255
        out[w++] = (bestDist >>> 8) & 255
        out[w++] = (bestDist >>> 16) & 255
        matches++; covered += take; left -= take
        i += take
      }
      while (left > 0) { emitRaw(data[i++]); left-- }
    } else {
      emitRaw(data[i++])
    }
  }
  return { esc, body: out.subarray(0, w), matches, covered }
}

/** 逆向。 */
export function lzPreInv(body: Uint8Array, n: number, esc: number): Uint8Array {
  const out = new Uint8Array(n)
  let w = 0, i = 0
  while (i < body.length) {
    const b = body[i++]
    if (b === esc) {
      const len = body[i++]
      if (len === 0) {
        if (w >= n) throw new Error('LZ 预变换溢出')
        out[w++] = esc
        continue
      }
      const dist = body[i] | (body[i + 1] << 8) | (body[i + 2] << 16)
      i += 3
      const take = len + 15
      const src = w - dist
      if (src < 0 || dist <= 0) throw new Error('LZ 预变换距离非法')
      if (w + take > n) throw new Error('LZ 预变换溢出')
      for (let k = 0; k < take; k++) out[w + k] = out[src + k]
      w += take
    } else {
      if (w >= n) throw new Error('LZ 预变换溢出')
      out[w++] = b
    }
  }
  if (w !== n) throw new Error('LZ 预变换长度校验失败')
  return out
}
