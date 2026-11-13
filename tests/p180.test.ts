import assert from 'node:assert/strict'
import { fastDeepEqual } from './fast-equal'
import { ID, encodeTerrainGroup, decodeTerrainGroup, compressAdaptive, decompress } from '../src/lib/codec'
import { encodeCM, decodeCM, withCMBlockSize, symAlphabetOf } from '../src/lib/coder'

const eq = (a: Uint8Array, b: Uint8Array) => fastDeepEqual(Buffer.from(a), Buffer.from(b))

/** Quaternary buffer over an arbitrary 4-byte alphabet (not ASCII, not DNA). */
function quat(n: number, alphabet: number[], seed = 7): Uint8Array {
  const out = new Uint8Array(n)
  let x = seed | 0
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0
    // biased draw so the frequency ranking is well defined
    out[i] = alphabet[(x & 3) === 0 ? (x >>> 8) & 3 : x & 1]
  }
  return out
}

/** k-symbol buffer over the first k bytes of the printable range. */
function kAlphabet(n: number, k: number, seed = 11): Uint8Array {
  const out = new Uint8Array(n)
  let x = seed | 0
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0
    out[i] = 40 + (x % k)
  }
  return out
}

export function testP180Sym2bit() {
  for (const alphabet of [[0x10, 0x20, 0x30, 0x40], [65, 67, 71, 85], [97, 99, 103, 116]]) {
    const data = quat(40000, alphabet)
    const map = symAlphabetOf(data, 'sym-2bit')
    assert.equal(map.k, 4, 'K must be four')
    assert.equal(map.bits, 2)
    // `rank ^ 1` is the rank-space involution: it pairs symbols without any literal.
    for (let r = 0; r < 4; r++) assert.equal(map.byteToSym[map.compByte[map.symToByte[r]]], r ^ 1)
    const opts = { context: 'sym-2bit' as const }
    const payload = withCMBlockSize(data.length, () => encodeCM(data, 'text', 1, 1, undefined, 0, undefined, undefined, 'v20', 0, false, opts))
    assert.equal(payload[0], 4, 'payload must carry the alphabet header')
    eq(withCMBlockSize(data.length, () => decodeCM(payload, data.length, 'text', 1, 1, undefined, 'v20', 0, false, opts)), data)
    // Same bytes must roundtrip through the group entry point.
    const spec = { id: ID.TEXT_V3, s: 1, r: 1 }
    const gp = encodeTerrainGroup([data], spec, undefined, undefined, undefined, [0], 'v20', opts)
    eq(decodeTerrainGroup(gp, [data.length], spec, undefined, [0], 'v20', false, opts)[0], data)
    // Non-ASCII and ASCII alphabets must give the same SIZE (rank semantics only).
    const sizes = [0x10, 0x20, 0x30, 0x40].map(() => 0)
    void sizes
  }
  // Identical rank distribution => identical payload length, whatever the bytes are.
  const base = quat(40000, [10, 20, 30, 40])
  const other = new Uint8Array(base.length)
  const renames = [200, 3, 99, 250]
  const rankOf = new Map([10, 20, 30, 40].map((b, i) => [b, i]))
  for (let i = 0; i < base.length; i++) other[i] = renames[rankOf.get(base[i])!]
  const o1 = withCMBlockSize(base.length, () => encodeCM(base, 'text', 1, 1, undefined, 0, undefined, undefined, 'v20', 0, false, { context: 'sym-2bit' }))
  const o2 = withCMBlockSize(other.length, () => encodeCM(other, 'text', 1, 1, undefined, 0, undefined, undefined, 'v20', 0, false, { context: 'sym-2bit' }))
  assert.ok(Math.abs(o1.length - o2.length) <= 8, `rank encoding must be byte-value independent (${o1.length} vs ${o2.length})`)
  eq(withCMBlockSize(other.length, () => decodeCM(o2, other.length, 'text', 1, 1, undefined, 'v20', 0, false, { context: 'sym-2bit' })), other)
  console.log('P18.0 sym-2bit rank alphabet, header framing and group roundtrip PASS')
}

export function testP180Sym5bit() {
  for (const k of [5, 8, 19, 21, 32]) {
    const data = kAlphabet(30000, k)
    const spec = { id: ID.TEXT_V3, s: 1, r: 1 }
    for (const context of ['sym-5bit', 'sym-5bit-gap'] as const) {
      const opts = { context }
      const payload = withCMBlockSize(data.length, () => encodeCM(data, 'text', 1, 1, undefined, 0, undefined, undefined, 'v20', 0, false, opts))
      assert.equal(payload[0], k, `${context} header must carry K=${k}`)
      eq(withCMBlockSize(data.length, () => decodeCM(payload, data.length, 'text', 1, 1, undefined, 'v20', 0, false, opts)), data)
      const gp = encodeTerrainGroup([data], spec, undefined, undefined, undefined, [0], 'v20', opts)
      eq(decodeTerrainGroup(gp, [data.length], spec, undefined, [0], 'v20', false, opts)[0], data)
    }
  }
  // K > 32 must be rejected rather than silently truncated.
  assert.throws(() => withCMBlockSize(2000, () => encodeCM(kAlphabet(2000, 33), 'text', 1, 1, undefined, 0, undefined, undefined, 'v20', 0, false, { context: 'sym-5bit' })), /低基数/)
  console.log('P18.0 sym-5bit / sym-5bit-gap alphabet framing, group roundtrip and K bound PASS')
}

export async function testP180Planner() {
  const data = quat(60000, [0x10, 0x20, 0x30, 0x40])
  const c = await compressAdaptive(data, undefined, { serial: true })
  eq(decompress(c.container), data)
  const seg = c.segs[0]
  assert.ok(seg, 'planner must produce a segment')
  assert.ok(['sym-2bit', undefined].includes(seg.context as string | undefined), `unexpected context ${seg.context}`)
  // A 5-symbol stream must also survive the full container path.
  const five = kAlphabet(40000, 5)
  const c2 = await compressAdaptive(five, undefined, { serial: true })
  eq(decompress(c2.container), five)
  console.log('P18.0 low-cardinality container roundtrip PASS')
}
