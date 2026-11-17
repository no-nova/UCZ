import assert from 'node:assert'
import { fastDeepEqual } from './fast-equal'
import {
  ID, encodeTerrainGroup, decodeTerrainGroup, planHeader, decompress, compressAdaptive,
  coalesceContiguousPlanSegments, candidatesFor, contextSpecAllowed, specLabel,
} from '../src/lib/codec'
import type { PlanGroup, SegResult, Spec } from '../src/lib/codec'
import { withContainerModel } from '../src/lib/coder'
import { payloadModelFlags } from '../src/lib/payload-model'
import { contextCodeOf, contextFromGroupBits, GROUP_CONTEXT_EXT_BIT } from '../src/lib/context-policy'

const eq = (a: Uint8Array, b: Uint8Array) => fastDeepEqual(Buffer.from(a), Buffer.from(b))

function versionOf(flags: number): number {
  return flags & 0x8000 ? 26 : flags & 0x4000 ? 21 : flags & 0x2800 ? 20 : flags > 255 ? 19 : flags ? 18 : 17
}
const inContainer = <T>(flags: number, fn: () => T): T => flags ? withContainerModel(versionOf(flags), flags, fn) : fn()

function container(data: Uint8Array, spec: Spec, payload: Uint8Array, meta: Partial<PlanGroup> = {}): Uint8Array {
  const groups: PlanGroup[] = [{ spec, members: [0], payload, v15: true, ...meta }]
  const segs = [{ start: 0, end: data.length, cls: 'text', spec, label: specLabel(spec), rawLen: data.length, compLen: payload.length, trials: [] }] as SegResult[]
  const hdr = planHeader(data.length, segs, groups)
  const out = new Uint8Array(hdr.length + payload.length)
  out.set(hdr); out.set(payload, hdr.length)
  return out
}

/** Two interleaved columns: a biased 6-bit ramp and an incompressible byte. */
function structuredPairs(pairs: number): Uint8Array {
  const out = new Uint8Array(pairs * 2)
  let x = 0x1234567
  for (let i = 0; i < pairs; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0
    out[2 * i] = i & 0x3f
    out[2 * i + 1] = x & 0xff
  }
  return out
}

/** Colon/field separated records whose columns repeat line to line. */
function tabularText(n: number): Uint8Array {
  const rows: string[] = []
  const titles = ['alpha_record_notes', 'beta_field_values', 'gamma_column_dump', 'delta_row_index']
  let off = 0, size = 0
  for (let i = 0; size < n; i++) {
    const row = `${off}:${100000 + i}:${titles[i % titles.length]}_${(i % 89).toString(36)}\n`
    rows.push(row); size += row.length; off += 40 + (i % 7)
  }
  return new TextEncoder().encode(rows.join(''))
}

/** Incompressible bytes with one smooth 512 B ramp buried inside. */
function pocketStream(total: number, offset: number, len: number): Uint8Array {
  const data = new Uint8Array(total)
  let x = 987654321
  for (let i = 0; i < total; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; data[i] = x & 0xff }
  for (let i = 0; i < len; i++) data[offset + i] = (i * 3 + 7) & 0xff
  return data
}

const structured = structuredPairs(32768)
const text = tabularText(131072)

/** P17.7 direction 1: transpose groups must keep the inner kernel's model bits
 *  so `planHeader` can set the r-bit and `legacyUpgrades` can price a v20 win. */
export function testP177TransposeFlags() {
  for (const id of [ID.TRANSPOSE, ID.TRANSPOSE_GROUP] as const) {
    const spec: Spec = { id, s: 2, r: 1 }
    const v20 = encodeTerrainGroup([structured], spec, undefined, undefined, undefined, [0], 'v20')
    assert.ok(payloadModelFlags(v20) & 0x1000, `id ${id}: v20 payload must keep V20_FLAG_CM through the group writer`)
    const segs = [{ start: 0, end: structured.length, cls: 'binary', spec, label: specLabel(spec), rawLen: structured.length, compLen: v20.length, trials: [] }] as SegResult[]
    const hdr = planHeader(structured.length, segs, [{ spec, members: [0], payload: v20, v15: true }])
    assert.ok(hdr.length > 20, `id ${id}: header must serialize`)
    const out = new Uint8Array(hdr.length + v20.length)
    out.set(hdr); out.set(v20, hdr.length)
    eq(decompress(out), structured)
    const v13 = encodeTerrainGroup([structured], spec, undefined, undefined, undefined, [0])
    assert.ok(v20.length !== v13.length, `id ${id}: v20 must price differently from the base kernel`)
  }
  console.log('P17.7 transpose-group model-bit propagation + header kernel PASS')
}

/** P17.7 direction 1b + 2: the planner must reach the kernel search for id 10 and
 *  must coalesce the header of contiguous identical-spec segments. */
export async function testP177Coalesce() {
  const seg = (start: number, end: number, spec: Spec): SegResult => ({
    start, end, cls: 'text', spec, label: specLabel(spec), rawLen: end - start, compLen: end - start, trials: [],
  })
  const viewer = seg(0, 4096, { id: ID.TEXT_V3, s: 1, r: 1 })
  const parts = [seg(0, 4096, viewer.spec), seg(4096, 8192, viewer.spec), seg(8192, 12288, viewer.spec), seg(12288, 16384, viewer.spec)]
  const payload = encodeTerrainGroup([new Uint8Array(16384)], viewer.spec, undefined, undefined, undefined, [0], 'v20')
  const groups: PlanGroup[] = [{ spec: { ...viewer.spec }, members: [0, 1, 2, 3], payload, v15: true }]
  const merged = coalesceContiguousPlanSegments(16384, parts, groups)
  assert.equal(merged.segs.length, 1, 'four contiguous TEXT_V3 segments must coalesce into one')
  assert.equal(merged.segs[0].rawLen, 16384)
  assert.equal(merged.segs[0].compLen, 16384)
  fastDeepEqual(merged.groups[0].members, [0])
  assert.ok(merged.adopted)
  // A seam inside a non-concatenation-invariant rule is not free.
  const transpose = [{ start: 0, end: 2048, cls: 'binary', spec: { id: ID.TRANSPOSE, s: 2, r: 1 }, label: 't', rawLen: 2048, compLen: 2048, trials: [] },
    { start: 2048, end: 4096, cls: 'binary', spec: { id: ID.TRANSPOSE, s: 2, r: 1 }, label: 't', rawLen: 2048, compLen: 2048, trials: [] }] as SegResult[]
  const transposed = coalesceContiguousPlanSegments(4096, transpose, [{ spec: { id: ID.TRANSPOSE, s: 2, r: 1 }, members: [0, 1], payload: new Uint8Array(16), v15: false }])
  assert.equal(transposed.segs.length, 2, 'transposed columns keep their member split')
  assert.ok(!transposed.adopted)
  // End-to-end: an id-10 stream must round-trip and stay in the transpose family.
  const r = await compressAdaptive(structured, undefined, { serial: true })
  eq(decompress(r.container), structured)
  assert.ok([ID.TRANSPOSE, ID.TRANSPOSE_GROUP, ID.TRANSPOSE_2D, ID.TRANSPOSE_GROUP_V3].includes(r.segs[0].spec.id))
  console.log('P17.7 contiguous plan coalescing + id-10 planner reach PASS')
}

/** P17.7 direction 3: `text-linecol` must be a legal, wired, and winning context. */
export function testP177LineCol() {
  fastDeepEqual(contextCodeOf('text-linecol'), { code: 1, ext: true })
  assert.equal(contextFromGroupBits(GROUP_CONTEXT_EXT_BIT | (1 << 17)), 'text-linecol')
  assert.equal(contextFromGroupBits(5 << 17), 'text-sparse5')
  assert.equal(contextSpecAllowed('text-linecol', { id: ID.TEXT_V3, s: 1, r: 1 }, false), true)
  assert.equal(contextSpecAllowed('text-linecol', { id: ID.TEXT_V2, s: 1, r: 1 }, false), true)
  assert.equal(contextSpecAllowed('text-linecol', { id: ID.BIN, s: 1, r: 1 }, false), false)
  assert.equal(contextSpecAllowed('text-linecol', { id: ID.TEXT_V3, s: 1, r: 1 }, true), false)
  assert.throws(() => encodeTerrainGroup([text], { id: ID.BIN, s: 1, r: 1 }, undefined, undefined, undefined, [0], 'v20', { context: 'text-linecol' }), /上下文/)
  const spec: Spec = { id: ID.TEXT_V3, s: 1, r: 1 }
  const sparse = encodeTerrainGroup([text], spec, undefined, undefined, undefined, [0], 'v20', { context: 'text-sparse5' })
  const line = encodeTerrainGroup([text], spec, undefined, undefined, undefined, [0], 'v20', { context: 'text-linecol' })
  assert.ok(line.length < sparse.length, `line/field columns must beat sparse words on tabular text (${line.length} vs ${sparse.length})`)
  const flags = payloadModelFlags(line)
  eq(inContainer(flags, () => decodeTerrainGroup(line, [text.length], spec, undefined, [0], 'v20', false, { context: 'text-linecol' }))[0], text)
  eq(decompress(container(text, spec, line, { context: 'text-linecol' })), text)
  // A plain container (no matchDist) stays on version 21 and must still decode.
  assert.equal(container(text, spec, line, { context: 'text-linecol' })[3], 21)
  console.log('P17.7 text-linecol wire legality, roundtrip and tabular win PASS')
}

/** P17.7 direction 4: delta strata on 'noise' pools and the guarded pocket carve. */
export async function testP177Pockets() {
  const ramp = new Uint8Array(65536)
  for (let i = 0; i < ramp.length; i++) ramp[i] = (i * 3) & 0xff
  const specs = candidatesFor(ramp, 'noise', 2, ramp)
  assert.ok(specs.some(sp => sp.id === ID.DELTA && sp.s === 1), 'a smooth small-stride stream must offer DELTA at its best delta stride')
  const flat = new Uint8Array(65536)
  let y = 42
  for (let i = 0; i < flat.length; i++) { y ^= y << 13; y >>>= 0; y ^= y >>> 17; y ^= y << 5; y >>>= 0; flat[i] = y & 0xff }
  const white = candidatesFor(flat, 'noise', 1, flat)
  assert.ok(!white.some(sp => sp.id === ID.DELTA), 'white noise must not gain a delta candidate')
  const data = pocketStream(131072, 40960, 512)
  const r = await compressAdaptive(data, undefined, { serial: true })
  eq(decompress(r.container), data)
  const pc = r.pocketComparison
  assert.ok(pc, 'the carve stage must report its decision')
  assert.ok(pc.scannedBytes >= 131072 - 512, 'the coarse segment must be scanned')
  assert.ok(pc.pockets.length >= 1, 'the embedded ramp must be carved')
  assert.ok(pc.accepted, 'the refined container must be strictly smaller')
  assert.ok(r.container.length < data.length, 'container must shrink')
  for (const p of pc.pockets) assert.ok(p.payloadBytes + 24 < p.end - p.start)
  console.log('P17.7 delta noise strata + guarded pocket carve PASS')
}
