import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { compressAdaptive, decompress, ID } from '../src/lib/codec'
import { encodeCM, decodeCM } from '../src/lib/coder'
import { fastDeepEqual } from './fast-equal'

// P29.3: blind manifold universality suite.
//
// Every stream below is generated from a fixed xorshift32 seed, so the test is
// deterministic and self-contained. Nothing in `src/lib` knows about these
// streams: periods, raster widths and channel counts are all unseen values, and
// the only thing asserted is that the general detector finds them (i.e. the
// container is far smaller than the raw stream) and that the roundtrip is exact.

function xorshift32(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s >>> 0
  }
}

function h0(d: Uint8Array): number {
  const f = new Uint32Array(256)
  for (const b of d) f[b]++
  let h = 0
  for (const c of f) if (c) { const p = c / d.length; h -= p * Math.log2(p) }
  return h
}

/** Quasi-periodic stream: a random template of `period` bytes, repeated row by
 *  row with a few sparse innovations plus a slow linear drift. Order-0 entropy
 *  stays near 8 bpb; the only exploitable structure is the period itself. */
function quasiPeriodic(period: number, rows: number, seed: number): Uint8Array {
  const rnd = xorshift32(seed)
  const template = Uint8Array.from({ length: period }, () => rnd() & 0xff)
  const out = new Uint8Array(period * rows)
  for (let r = 0; r < rows; r++) {
    const drift = (r % 7) - 3
    for (let k = 0; k < period; k++) {
      let v = template[k]
      // sparse innovation: ~3% of the cells change per row
      if ((rnd() & 0x1f) === 0) v = (v + 1 + (rnd() & 0x3f)) & 0xff
      out[r * period + k] = (v + drift) & 0xff
    }
  }
  return out
}

/** 2-D bi-level raster of prime width `width` bytes per scanline. Each scanline
 *  copies the previous one and toggles a couple of short strokes, so the stream
 *  is dominated by 0x00/0xFF bytes and repeats at exactly `width`. */
function raster2d(width: number, rows: number, seed: number): Uint8Array {
  const rnd = xorshift32(seed)
  const out = new Uint8Array(width * rows)
  let prev = new Uint8Array(width)
  for (let i = 0; i < width; i++) prev[i] = 0
  for (let r = 0; r < rows; r++) {
    const row = Uint8Array.from(prev)
    // 1-2 strokes per row, each 2-6 bytes long, always on the same lattice
    const strokes = 1 + (rnd() & 1)
    for (let s = 0; s < strokes; s++) {
      const at = rnd() % width
      const len = 2 + (rnd() % 5)
      const v = (rnd() & 1) === 0 ? 0x00 : 0xff
      for (let k = 0; k < len; k++) row[(at + k) % width] = v
    }
    out.set(row, r * width)
    prev = row
  }
  return out
}

/** Interleaved multi-channel sensor stream: channel `c` is a smooth random walk
 *  with its own offset, so neighbouring bytes (different channels) jump wildly
 *  while stride-`s` de-interleaving collapses the residual. */
function multiChannel(channels: number, frames: number, seed: number): Uint8Array {
  const rnd = xorshift32(seed)
  const level = new Int32Array(channels)
  const offset = new Int32Array(channels)
  for (let c = 0; c < channels; c++) { level[c] = 96 + ((c * 37) % 64); offset[c] = c * 11 }
  const out = new Uint8Array(channels * frames)
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const step = ((rnd() % 5) - 2)
      level[c] = Math.max(0, Math.min(255, level[c] + step))
      out[f * channels + c] = (level[c] + offset[c]) & 0xff
    }
  }
  return out
}

const NAME = new Map<number, string>([
  [ID.STORE, 'STORE'], [ID.FILL, 'FILL'], [ID.RLE, 'RLE'], [ID.O0, 'O0'], [ID.TEXT, 'TEXT'],
  [ID.BIN, 'BIN'], [ID.DELTA, 'DELTA'], [ID.GRAD, 'GRAD'], [ID.D16, 'D16'], [ID.TRANSPOSE, 'TRANSPOSE'],
  [ID.TRANSPOSE_GROUP, 'TRANSPOSE-G'], [ID.MICRO, 'MICRO'], [ID.PEEL, 'PEEL'], [ID.SUB_TRANSPOSE, 'SUB-TRANSPOSE'],
  [ID.TEXT_V3, 'TEXT3'], [ID.BIN_V3, 'BIN3'], [ID.GRAD_V3, 'GRAD3'], [ID.DELTA_V3, 'DELTA3'],
  [ID.SUB_TRANSPOSE_V3, 'SUB-TRANSPOSE3'], [ID.TRANSPOSE_GROUP_V3, 'TRANSPOSE-G3'], [ID.WIDE_GRAD, 'WIDE-GRAD'],
])

function describe(enc: any): string {
  const segs = enc?.segs ?? enc?.plan?.segs ?? []
  const parts: string[] = []
  for (const s of segs) {
    const id = s?.spec?.id as number | undefined
    if (id === undefined) continue
    const nm = NAME.get(id) ?? `id${id}`
    const span = s.spec.s > 1 ? ` s=${s.spec.s}` : ''
    const lag = s.spec.r > 1 ? ` r=${s.spec.r}` : ''
    parts.push(`${nm}${span}${lag}`)
  }
  return parts.length ? parts.join(' + ') : '(single group)'
}

interface Row { name: string; raw: number; h0: number; uz: number; rt: boolean; path: string }

async function measure(name: string, buf: Uint8Array, limit: number): Promise<Row> {
  const enc = await compressAdaptive(buf)
  const back = decompress(enc.container)
  const rt = back.length === buf.length && createHash('sha256').update(back).digest('hex') === createHash('sha256').update(buf).digest('hex')
  const row = { name, raw: buf.length, h0: +h0(buf).toFixed(3), uz: enc.container.length, rt, path: describe(enc as any) }
  assert.equal(rt, true, `${name}: 往返必须逐字节一致`)
  assert.ok(row.uz <= limit, `${name}: 通用检测器必须找到结构（uz=${row.uz} > ${limit}，H0=${row.h0}）`)
  return row
}

export async function testManifoldUniversality() {
  const rows: Row[] = []
  // 1.3 outer: prime periods, no power-of-two anywhere in the pipeline
  for (const P of [73, 197, 389]) rows.push(await measure(`quasi-periodic P=${P}`, quasiPeriodic(P, Math.ceil(24576 / P), 0x9e3779b9 ^ P), 24576 * 0.85))
  // 1.3 inner: prime-width 2-D rasters
  for (const W of [113, 193]) rows.push(await measure(`raster 2-D W=${W}`, raster2d(W, Math.ceil(24576 / W), 0x85ebca6b ^ W), 24576 * 0.85))
  // 1.2: odd / multi-channel interleave, including the strides that used to break.
  // P29.4b 之前 s=2/3 会在这里红：编码端逐分片 `deltaFwd`（每个分片重置差分链），
  // 而 `coalesceCompressedPlan` 会把相邻同组的分片合并成一个，解码端于是对合并后
  // 的整段求一次逆 —— 首个分片边界之后全错（3 通道 49,152 B 在 3584 = 7*512 处）。
  // 现在两端都在整组粒度上作用残差变换，因此任意 s 与任意分片长度都对称。
  for (const S of [4, 5, 7]) rows.push(await measure(`interleave s=${S}`, multiChannel(S, Math.ceil(24576 / S), 0xc2b2ae35 ^ S), 24576 * 0.85))
  rows.push(await measure('interleave s=2 (multi-seg)', multiChannel(2, 24576, 0x9e3779b9), 24576 * 0.85))
  rows.push(await measure('interleave s=3 (12288 B)', multiChannel(3, 4096, 0x85ebca6b), 12288 * 0.85))
  rows.push(await measure('interleave s=3 (16383 B)', multiChannel(3, 5461, 0xc2b2ae35), 16383 * 0.85))
  rows.push(await measure('interleave s=3 (49152 B)', multiChannel(3, 16384, 0x27d4eb2f), 49152 * 0.85))
  rows.push(await measure('interleave s=6', multiChannel(6, 4096, 0x165667b1), 24576 * 0.85))
  rows.push(await measure('interleave s=8', multiChannel(8, 4096, 0x2545f491), 32768 * 0.85))
  rows.push(await measure('interleave s=12', multiChannel(12, 4096, 0x7feb352d), 49152 * 0.85))
  // 素数宽度栅格的**直接内核**往返：`compressAdaptive` 可能把这类流判成 text，
  // 于是 `detectScanPeriod()`（只在 profile==='bin' 里跑）根本没被执行到。
  // 这里绕过规划器直接走 bin 内核，确认任意素数宽度在 CM 层都是可逆的。
  for (const W of [113, 193]) {
    const buf = raster2d(W, Math.ceil(24576 / W), 0x27d4eb2f ^ W)
    const coded = encodeCM(buf, 'bin', 1, 1)
    const back = decodeCM(coded, buf.length, 'bin', 1, 1)
    let same = back.length === buf.length
    for (let i = 0; same && i < buf.length; i++) if (back[i] !== buf[i]) same = false
    console.log(`[manifold] bin-kernel W=${W} raw=${buf.length} uz=${coded.length} rt=${same}`)
    if (!same) throw new Error(`bin kernel roundtrip failed at W=${W}`)
  }
  // P30.0：三档规划器都必须解回原文，且默认（无 options）必须与 `'max'` 逐字节相同。
  {
    const buf = quasiPeriodic(197, 128, 0x51ed270b)
    const plain = await compressAdaptive(buf)
    const maxed = await compressAdaptive(buf, undefined, { level: 'max' })
    assert.equal(plain.container.length, maxed.container.length, "默认档位必须等同 'max'")
    for (const level of ['fast', 'balanced', 'max'] as const) {
      const enc = await compressAdaptive(buf, undefined, { level })
      fastDeepEqual(decompress(enc.container), buf, `level=${level}`)
      console.log(`[level] ${level} raw=${buf.length} uz=${enc.container.length} ver=${enc.container[3]}`)
    }
  }
  for (const r of rows) console.log(`[manifold] ${r.name} raw=${r.raw} H0=${r.h0} uz=${r.uz} rt=${r.rt} path=${r.path}`)
  console.log('P29.3 manifold universality PASS')
}
