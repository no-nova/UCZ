// P16.2: bit-level context model for bit planes.
//
// The existing bitplane path packs a plane into ceil(n/8) bytes and calls the
// byte-oriented BIN CM. That can only see a k-bit history as a fractional
// byte prefix, so an order-16..20 bit structure (AITDCC/L planes 0..3 report
// 16..20-order structure with causalH20 0.54..0.97) is invisible to it: the
// packed stream's own models are orders of *bytes*.
//
// Here the model works directly on bits with an explicit history of k bits and
// a logistic mixture of several orders. No sample-based screen is used to
// decide adoption: a plane is only stored compressed when the real coder beat
// the raw plane, so a random plane can never be adopted by mistake.
import {ByteWriter} from './byte-writer'

const PBITS = 12
const PSCALE = 1 << PBITS
const PINIT = PSCALE >> 1
const STRETCH_MAX = 2047

// stretch(p) = ln(p/(1-p)) * 256, clamped; squash is its inverse.
const stretchTable = new Int16Array(PSCALE)
for (let p = 0; p < PSCALE; p++) {
  const x = Math.max(1 / PSCALE, Math.min(1 - 1 / PSCALE, (p + 0.5) / PSCALE))
  stretchTable[p] = Math.max(-STRETCH_MAX, Math.min(STRETCH_MAX, Math.round(Math.log(x / (1 - x)) * 256)))
}
const squashTable = new Int16Array(2 * STRETCH_MAX + 1)
for (let i = 0; i <= 2 * STRETCH_MAX; i++) {
  const x = (i - STRETCH_MAX) / 256
  squashTable[i] = Math.max(1, Math.min(PSCALE - 1, Math.round(PSCALE / (1 + Math.exp(-x)))))
}
// mixed is fractional; the table index must be an integer or the lookup
// silently yields undefined (NaN probabilities, a 5-byte "encoder").
/** Two plain Uint16 counters per context beat one packed Uint32: no shifts, no
 * masking, and exponentiation by 2 makes the halving exact. */
const MAX_COUNT = 1000

export interface BitCMModel {
  orders: number[]
  masks: number[]
  zeros: Uint16Array[]
  ones: Uint16Array[]
  weights: Float64Array
  stretch: Int32Array
}

export function createBitCMModel(orders: readonly number[]): BitCMModel {
  if (!orders.length || orders.some(o => !Number.isInteger(o) || o < 1 || o > 24)) throw Error('无效位历史阶数')
  return {
    orders: [...orders],
    masks: orders.map(o => (1 << o) - 1),
    zeros: orders.map(o => new Uint16Array(1 << o)),
    ones: orders.map(o => new Uint16Array(1 << o)),
    weights: initialWeights(orders.length),
    stretch: new Int32Array(orders.length),
  }
}

/** Unnormalised, clamped mixture weights; a constant input lets the mixer express
 * "no information" (p=0.5) without depending on the model weights. */
const BIAS_STRETCH = 256
const INIT_WEIGHT = 0.35
const LR = 0.0025
const WEIGHT_SCALE = LR / (PSCALE * STRETCH_MAX)

function initialWeights(n: number): Float64Array {
  const w = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) w[i] = INIT_WEIGHT
  return w
}

/** One shared model step for encode and decode: identical order and updates.
 * Inlined hot path; `mixed` is rounded once because the squash table is indexed
 * by an integer (a fractional index silently yields undefined). */
function predict(m: BitCMModel, history: number): number {
  let mixed = 0
  const st = m.stretch, w = m.weights, z = m.zeros, o = m.ones, masks = m.masks
  for (let i = 0; i < masks.length; i++) {
    const index = history & masks[i]
    const n0 = z[i][index], n1 = o[i][index]
    const prob = Math.max(1, Math.min(PSCALE - 1, (((2048 * n1 + 1) * PSCALE) / (2048 * (n0 + n1) + 2)) | 0))
    const value = stretchTable[prob]
    st[i] = value
    mixed += w[i] * value
  }
  mixed += w[masks.length] * BIAS_STRETCH
  const index = Math.max(-STRETCH_MAX, Math.min(STRETCH_MAX, Math.round(mixed))) + STRETCH_MAX
  return squashTable[index]
}

function update(m: BitCMModel, prob: number, bit: number, history: number): void {
  const err = bit * PSCALE - prob, st = m.stretch, w = m.weights, masks = m.masks
  for (let i = 0; i < masks.length; i++) {
    const next = w[i] + err * st[i] * WEIGHT_SCALE
    w[i] = next < 0 ? 0 : next > 4 ? 4 : next
    const index = history & masks[i]
    const z = m.zeros[i], o = m.ones[i]
    if (bit) {
      const value = o[index] + 1
      if (value + z[index] > MAX_COUNT) { o[index] = (value + 1) >> 1; z[index] = (z[index] + 1) >> 1 }
      else o[index] = value
    } else {
      const value = z[index] + 1
      if (value + o[index] > MAX_COUNT) { z[index] = (value + 1) >> 1; o[index] = (o[index] + 1) >> 1 }
      else z[index] = value
    }
  }
  const bias = w[masks.length] + err * BIAS_STRETCH * WEIGHT_SCALE
  w[masks.length] = bias < -4 ? -4 : bias > 4 ? 4 : bias
}

class RangeEncoder {
  // LZMA-style carry handling: `low` must keep its byte 3..4 bits so that the
  // carry test (low >= 2^32) still fires. Never mask low before shiftLow.
  private low = 0
  private range = 0xffffffff
  private cache = 0
  private cacheSize = 1
  private readonly out = new ByteWriter()

  /** `prob` is P(bit=1), matching the model. The lower sub-range is the 1 branch. */
  bit(prob: number, bit: number): void {
    const bound = (this.range >>> PBITS) * prob
    if (bit) this.range = bound
    else { this.low += bound; this.range -= bound }
    while (this.range < 0x01000000) { this.range = (this.range << 8) >>> 0; this.shiftLow() }
  }
  private shiftLow(): void {
    if (this.low < 0xff000000 || this.low >= 0x100000000) {
      const carry = this.low >= 0x100000000 ? 1 : 0
      let temp = this.cache
      do {
        this.out.push((temp + carry) & 0xff)
        temp = 0xff
      } while (--this.cacheSize !== 0)
      this.cache = (this.low >>> 24) & 0xff
    }
    this.cacheSize++
    this.low = (this.low & 0xffffff) * 256
  }
  finish(): Uint8Array {
    for (let i = 0; i < 5; i++) this.shiftLow()
    return this.out.finish()
  }
}

class RangeDecoder {
  private range = 0xffffffff
  private code = 0
  private pos = 0
  constructor(private readonly input: Uint8Array) {
    for (let i = 0; i < 5; i++) this.code = ((this.code << 8) | this.byte()) >>> 0
  }
  private byte(): number { return this.pos < this.input.length ? this.input[this.pos++] : 0 }
  bit(prob: number): number {
    const bound = (this.range >>> PBITS) * prob
    let bit: number
    if (this.code < bound) { this.range = bound; bit = 1 }
    else { this.code = (this.code - bound) >>> 0; this.range -= bound; bit = 0 }
    while (this.range < 0x01000000) { this.range = (this.range << 8) >>> 0; this.code = ((this.code << 8) | this.byte()) >>> 0 }
    return bit
  }
}

export function bitCMBitCount(bytes: number): number { return Math.floor(bytes) * 8 }




/** Encode `bits` bits read LSB-first from packed `plane`. */
export function encodePlaneBitCM(plane: Uint8Array, bits: number, model: BitCMModel): Uint8Array {
  const encoder = new RangeEncoder(), mask = model.masks[model.orders.length - 1]
  let history = 0
  for (let i = 0; i < bits; i++) {
    const bit = (plane[i >>> 3] >>> (i & 7)) & 1
    const prob = predict(model, history)
    encoder.bit(prob, bit)
    update(model, prob, bit, history)
    history = ((history << 1) | bit) & mask
  }
  return encoder.finish()
}

/** Decode `bits` bits into a new packed plane. Symmetric with the encoder. */
export function decodePlaneBitCM(payload: Uint8Array, bits: number, model: BitCMModel): Uint8Array {
  const decoder = new RangeDecoder(payload), plane = new Uint8Array((bits + 7) >>> 3), mask = model.masks[model.orders.length - 1]
  let history = 0
  for (let i = 0; i < bits; i++) {
    const prob = predict(model, history)
    const bit = decoder.bit(prob)
    if (bit) plane[i >>> 3] |= 1 << (i & 7)
    update(model, prob, bit, history)
    history = ((history << 1) | bit) & mask
  }
  return plane
}

export { PINIT }
