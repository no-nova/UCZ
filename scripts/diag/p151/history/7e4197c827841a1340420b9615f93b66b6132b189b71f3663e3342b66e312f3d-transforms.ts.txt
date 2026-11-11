// 可逆变换:把“结构”转成更容易建模的残差

export function deltaFwd(d: Uint8Array, s: number): Uint8Array {
  const o = new Uint8Array(d.length)
  for (let i = 0; i < d.length; i++) o[i] = (d[i] - (i >= s ? d[i - s] : 0)) & 255
  return o
}
export function deltaInv(r: Uint8Array, s: number): Uint8Array {
  const o = new Uint8Array(r.length)
  for (let i = 0; i < r.length; i++) o[i] = (r[i] + (i >= s ? o[i - s] : 0)) & 255
  return o
}

function med(a: number, b: number, c: number): number {
  const mx = a > b ? a : b
  const mn = a < b ? a : b
  if (c >= mx) return mn
  if (c <= mn) return mx
  return a + b - c
}

// 二维梯度预测 (LOCO-I MED):s = 像素字节跨度, r = 行跨度
export function medFwd(d: Uint8Array, s: number, r: number): Uint8Array {
  const o = new Uint8Array(d.length)
  for (let i = 0; i < d.length; i++) {
    const a = i >= s ? d[i - s] : 0
    const b = i >= r ? d[i - r] : 0
    const c = i >= r + s ? d[i - r - s] : 0
    o[i] = (d[i] - med(a, b, c)) & 255
  }
  return o
}
export function medInv(res: Uint8Array, s: number, r: number): Uint8Array {
  const d = new Uint8Array(res.length)
  for (let i = 0; i < res.length; i++) {
    const a = i >= s ? d[i - s] : 0
    const b = i >= r ? d[i - r] : 0
    const c = i >= r + s ? d[i - r - s] : 0
    d[i] = (res[i] + med(a, b, c)) & 255
  }
  return d
}

// 16 位小端采样线性预测:ch = 声道数, order = 1(差分)/2(二阶)
export function d16Fwd(d: Uint8Array, ch: number, order: number): Uint8Array {
  const o = new Uint8Array(d.length)
  const m = d.length >> 1
  const sample = (j: number) => d[2 * j] | (d[2 * j + 1] << 8)
  for (let j = 0; j < m; j++) {
    const a = j >= ch ? sample(j - ch) : 0
    const b = j >= 2 * ch ? sample(j - 2 * ch) : 0
    const pred = order === 2 ? 2 * a - b : a
    const res = (sample(j) - pred) & 0xffff
    o[2 * j] = res & 255
    o[2 * j + 1] = res >> 8
  }
  if (d.length & 1) o[d.length - 1] = d[d.length - 1]
  return o
}
export function d16Inv(r: Uint8Array, ch: number, order: number): Uint8Array {
  const d = new Uint8Array(r.length)
  const m = r.length >> 1
  const sample = (j: number) => d[2 * j] | (d[2 * j + 1] << 8)
  for (let j = 0; j < m; j++) {
    const a = j >= ch ? sample(j - ch) : 0
    const b = j >= 2 * ch ? sample(j - 2 * ch) : 0
    const pred = order === 2 ? 2 * a - b : a
    const res = r[2 * j] | (r[2 * j + 1] << 8)
    const v = (res + pred) & 0xffff
    d[2 * j] = v & 255
    d[2 * j + 1] = v >> 8
  }
  if (r.length & 1) d[r.length - 1] = r[r.length - 1]
  return d
}

// Reversible x86 E8/E9 rel32 normalization. All positions are modulo 2^32.
// It is deliberately not an instruction disassembler or standard XZ BCJ stream.
function bcjTransform(data: Uint8Array, base: number, inverse: boolean): Uint8Array {
  // Uint8Array.slice copies, but Node Buffer.slice aliases the input.
  const out = new Uint8Array(data)
  for (let i = 0; i + 4 < out.length; i++) {
    if (out[i] !== 0xe8 && out[i] !== 0xe9) continue
    const rel = (out[i + 1] | (out[i + 2] << 8) | (out[i + 3] << 16) | (out[i + 4] << 24)) >>> 0
    const pc = (base + i + 5) >>> 0
    const value = (inverse ? rel - pc : rel + pc) >>> 0
    out[i + 1] = value & 255; out[i + 2] = (value >>> 8) & 255
    out[i + 3] = (value >>> 16) & 255; out[i + 4] = value >>> 24
    i += 4
  }
  return out
}
export function bcjFwd(data: Uint8Array, base = 0): Uint8Array { return bcjTransform(data, base, false) }
export function bcjInv(data: Uint8Array, base = 0): Uint8Array { return bcjTransform(data, base, true) }

// Self-delimiting column fold: the last complete row ends at the same offset
// after transposition; the unterminated suffix is left unchanged.
export function anchorFoldFwd(buf: Uint8Array, s: number, r: number): Uint8Array {
  const aR=s&255, rawR=r&127, grid=rawR>=32 || rawR===9, aC=grid?rawR:-1
  const K=grid?12:Math.max(2,Math.min(24,rawR))
  if (grid && aR===aC) return new Uint8Array(buf)
  let last=buf.length-1
  while (last>=0 && buf[last]!==aR) last--
  if (last<=0) return new Uint8Array(buf)
  const counts=new Int32Array(K), offsets=new Int32Array(K)
  let col=0
  for (let i=0;i<=last;i++) {
    const b=buf[i]; counts[col]++
    if (b===aR) col=0
    else if (col<K-1 && (!grid || b===aC)) col++
  }
  let p=0
  for (let i=0;i<K;i++) { offsets[i]=p; p+=counts[i] }
  const out=new Uint8Array(buf.length); col=0
  for (let i=0;i<=last;i++) {
    const b=buf[i]; out[offsets[col]++]=b
    if (b===aR) col=0
    else if (col<K-1 && (!grid || b===aC)) col++
  }
  out.set(buf.subarray(last+1),last+1)
  return out
}
export function anchorFoldInv(buf: Uint8Array, s: number, r: number): Uint8Array {
  const aR=s&255, rawR=r&127, grid=rawR>=32 || rawR===9, aC=grid?rawR:-1
  const K=grid?12:Math.max(2,Math.min(24,rawR))
  if (grid && aR===aC) return new Uint8Array(buf)
  let last=buf.length-1
  while (last>=0 && buf[last]!==aR) last--
  if (last<=0) return new Uint8Array(buf)
  let rows=0
  for (let i=0;i<=last;i++) if(buf[i]===aR) rows++
  const starts=new Int32Array(K); let p=0, needed=rows
  for (let k=0;k<K-1;k++) {
    starts[k]=p; let next=0
    if (grid) {
      while (needed>0 && p<=last) { const b=buf[p++]; if(b===aR) needed--; else if(b===aC) {needed--; next++} }
    } else {
      const end=Math.min(last+1,p+needed)
      while (p<end) if(buf[p++]!==aR) next++
    }
    needed=next
  }
  starts[K-1]=p
  const out=new Uint8Array(buf.length); let col=0
  for (let i=0;i<=last;i++) {
    const b=buf[starts[col]++]; out[i]=b
    if(b===aR) col=0
    else if(col<K-1 && (!grid || b===aC)) col++
  }
  out.set(buf.subarray(last+1),last+1)
  return out
}

// P12.1: unsigned LE16 image samples; residuals wrap modulo 2^16.
// Modes 3/4/5: MED/grad332/average, interleaved residual. Modes 6/7/8:
// grad332/average/MED signed residual -> ZigZag -> high plane then low plane.
function wide16Transform(input: Uint8Array, rowBytes: number, mode: number, inverse: boolean): Uint8Array {
  if (input.length % 2 || !Number.isInteger(rowBytes) || rowBytes < 2 || rowBytes % 2
    || !Number.isInteger(mode) || mode < 3 || mode > 8) throw Error('无效 LE16 预测参数')
  const out = new Uint8Array(input.length), count = input.length / 2, row = rowBytes / 2
  const pixels = inverse ? out : input, split = mode >= 6
  const predictor = mode === 6 ? 4 : mode === 7 ? 5 : mode === 8 ? 3 : mode
  const get = (j: number) => pixels[j * 2] | pixels[j * 2 + 1] << 8
  for (let j = 0; j < count; j++) {
    const col = j % row, a = col ? get(j - 1) : 0, b = j >= row ? get(j - row) : 0
    const c = col && j >= row ? get(j - row - 1) : 0
    const p = j < row ? a : !col ? b : predictor === 3 ? med(a, b, c)
      : predictor === 4 ? Math.max(0, Math.min(65535, (3 * a + 3 * b - 2 * c + 2) >> 2)) : (a + b) >> 1
    if (inverse) {
      const z = split ? input[j] << 8 | input[count + j] : input[j * 2] | input[j * 2 + 1] << 8
      const residual = split ? (z >>> 1) ^ -(z & 1) : z
      const value = (p + residual) & 65535
      out[j * 2] = value & 255; out[j * 2 + 1] = value >>> 8
    } else {
      const residual = (get(j) - p) & 65535
      if (split) {
        const signed = (residual << 16) >> 16, z = ((signed << 1) ^ (signed >> 15)) & 65535
        out[j] = z >>> 8; out[count + j] = z & 255
      } else { out[j * 2] = residual & 255; out[j * 2 + 1] = residual >>> 8 }
    }
  }
  return out
}
export const wide16Fwd = (d: Uint8Array, rowBytes: number, mode: number) => wide16Transform(d, rowBytes, mode, false)
export const wide16Inv = (d: Uint8Array, rowBytes: number, mode: number) => wide16Transform(d, rowBytes, mode, true)
export const med16Fwd = (d: Uint8Array, rowBytes: number) => wide16Fwd(d, rowBytes, 3)
export const med16Inv = (d: Uint8Array, rowBytes: number) => wide16Inv(d, rowBytes, 3)
export const grad332Fwd = (d: Uint8Array, rowBytes: number) => wide16Fwd(d, rowBytes, 4)
export const grad332Inv = (d: Uint8Array, rowBytes: number) => wide16Inv(d, rowBytes, 4)
export const avg16Fwd = (d: Uint8Array, rowBytes: number) => wide16Fwd(d, rowBytes, 5)
export const avg16Inv = (d: Uint8Array, rowBytes: number) => wide16Inv(d, rowBytes, 5)

function bcjMsbTransform(data: Uint8Array, base: number, inverse: boolean): Uint8Array {
  const out = new Uint8Array(data)
  for (let i = 0; i + 4 < out.length; i++) {
    if (out[i] !== 0xe8 && out[i] !== 0xe9) continue
    if (out[i + 4] === 0 || out[i + 4] === 255) {
      const rel = out[i + 1] | out[i + 2] << 8 | out[i + 3] << 16 | out[i + 4] << 24
      const pc = (base + i + 5) >>> 0
      const value = ((inverse ? rel - pc : rel + pc) & 0x1ffffff) << 7 >> 7
      out[i + 1] = value & 255; out[i + 2] = value >>> 8 & 255
      out[i + 3] = value >>> 16 & 255; out[i + 4] = value >>> 24
    }
    // Consume each scanned rel32 field, including a filter rejection. Otherwise
    // a nested E8 can mutate an earlier rejected operand's MSB and make the
    // inverse take a different branch (particularly at nonzero/wrapped bases).
    i += 4
  }
  return out
}
export const bcjMsbFwd = (d: Uint8Array, base = 0) => bcjMsbTransform(d, base, false)
export const bcjMsbInv = (d: Uint8Array, base = 0) => bcjMsbTransform(d, base, true)

/** Carry/borrow-preserving LE uint32/uint64 row differences. Bytes are in the
 * gatherer's orientation; reverse residuals back to that orientation for BIN.
 * Whole-word history resets per segment. A partial final word is copied. */
export function wordRowDelta(input: Uint8Array, lengths: readonly number[], span: number, inverse: boolean, reverse = false): Uint8Array {
  if ((span !== 4 && span !== 8) || lengths.some(n => !Number.isSafeInteger(n) || n < 0)
    || lengths.reduce((a,b)=>a+b,0) !== input.length) throw Error('无效多字节行差分')
  const out = new Uint8Array(input.length), source = inverse ? out : input
  let pos = 0
  for (const len of lengths) {
    const full = len - len % span
    for (let i = 0; i < full; i += span) {
      let carry = 0
      for (let j = 0; j < span; j++) {
        const k = pos + i + (reverse ? span - 1 - j : j)
        const previous = i >= span ? source[k - span] : 0
        const value = inverse ? input[k] + previous + carry : input[k] - previous - carry
        out[k] = value & 255; carry = inverse ? value >>> 8 : value < 0 ? 1 : 0
      }
    }
    out.set(input.subarray(pos + full, pos + len), pos + full); pos += len
  }
  return out
}
