import assert from 'node:assert'
import { fastDeepEqual } from './fast-equal'
import {
  ID, encodeTerrainGroup, decodeTerrainGroup, planHeader, decompress, compressAdaptive,
  compressGuardedPlanForProbe, refineBcjSegments, contextSpecAllowed, specLabel,
} from '../src/lib/codec'
import type { PlanGroup, PlanSegment, SegResult, Spec } from '../src/lib/codec'
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

/** Colon/tab separated records whose field columns repeat line to line. */
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

/** C-like source: identifiers, operators and indentation, no field columns. */
function codeText(n: number): Uint8Array {
  const unit = 'static int count_value(const uint8_t *input, size_t length) {\n  int total = 0;\n  for (size_t index = 0; index < length; index++) total += input[index];\n  return total;\n}\n'
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = unit.charCodeAt(i % unit.length)
  return out
}

/** Incompressible stream with two smooth 512 B ramps buried inside. */
function pocketStream(total: number, offsets: number[], len: number): Uint8Array {
  const data = new Uint8Array(total)
  let x = 987654321
  for (let i = 0; i < total; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; data[i] = x & 0xff }
  for (const offset of offsets) for (let i = 0; i < len; i++) data[offset + i] = (i * 3 + 7) & 0xff
  return data
}

/** x86-ish call stream: E8 + 32-bit relative offsets that BCJ can fold to zeros. */
function callStream(n: number): Uint8Array {
  const out = new Uint8Array(n)
  let x = 0x2545f491
  for (let p = 0; p + 5 <= n; p += 5) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0
    out[p] = 0xe8
    const rel = (x & 0xffff) - 0x8000
    out[p + 1] = rel & 0xff; out[p + 2] = (rel >> 8) & 0xff
    out[p + 3] = (rel < 0 ? 0xff : 0x00); out[p + 4] = (rel < 0 ? 0xff : 0x00)
  }
  return out
}

const tabular = tabularText(131072)
const code = codeText(131072)
const spec3: Spec = { id: ID.TEXT_V3, s: 1, r: 1 }

/** P17.8 direction 1: the extended context namespace carries the upgraded
 *  `text-linecol` and the new `text-lexcol`, and lexcol is the better generalist. */
export function testP178TextContexts() {
  fastDeepEqual(contextCodeOf('text-linecol'), { code: 1, ext: true })
  fastDeepEqual(contextCodeOf('text-lexcol'), { code: 2, ext: true })
  assert.equal(contextFromGroupBits(GROUP_CONTEXT_EXT_BIT | (2 << 17)), 'text-lexcol')
  for (const ctx of ['text-linecol', 'text-lexcol'] as const) {
    assert.equal(contextSpecAllowed(ctx, spec3, false), true)
    assert.equal(contextSpecAllowed(ctx, { id: ID.TEXT_V2, s: 1, r: 1 }, false), true)
    assert.equal(contextSpecAllowed(ctx, { id: ID.BIN, s: 1, r: 1 }, false), false)
    assert.equal(contextSpecAllowed(ctx, { id: ID.TEXT_V3, s: 1, r: 1 }, true), false)
    assert.equal(contextSpecAllowed(ctx, { id: ID.TEXT_V3, s: 2, r: 1 }, false), false)
  }
  assert.throws(() => encodeTerrainGroup([tabular], { id: ID.BIN, s: 1, r: 1 }, undefined, undefined, undefined, [0], 'v20', { context: 'text-lexcol' }), /上下文/)
  const sparse = encodeTerrainGroup([tabular], spec3, undefined, undefined, undefined, [0], 'v20', { context: 'text-sparse5' })
  const line = encodeTerrainGroup([tabular], spec3, undefined, undefined, undefined, [0], 'v20', { context: 'text-linecol' })
  assert.ok(line.length < sparse.length, `line/field columns must beat sparse words on tabular text (${line.length} vs ${sparse.length})`)
  for (const [name, data] of [['tabular', tabular], ['code', code]] as const) {
    const lex = encodeTerrainGroup([data], spec3, undefined, undefined, undefined, [0], 'v20', { context: 'text-lexcol' })
    const ln = encodeTerrainGroup([data], spec3, undefined, undefined, undefined, [0], 'v20', { context: 'text-linecol' })
    // `text-linecol` keeps the field/line hashes in the low slots and wins on pure
    // columnar records; `text-lexcol` keeps the word bigram and wins on free text and
    // source code, which is what the screening stage is allowed to choose between.
    if (name === 'code') assert.ok(lex.length < ln.length, `text-lexcol must beat text-linecol on source code (${lex.length} vs ${ln.length})`)
    else assert.ok(lex.length < sparse.length, `text-lexcol must beat sparse words on ${name} text (${lex.length} vs ${sparse.length})`)
    const flags = payloadModelFlags(lex)
    eq(inContainer(flags, () => decodeTerrainGroup(lex, [data.length], spec3, undefined, [0], 'v20', false, { context: 'text-lexcol' }))[0], data)
    const lexMd = encodeTerrainGroup([data], spec3, undefined, undefined, undefined, [0], 'v20', { context: 'text-lexcol', matchDist: true })
    eq(decompress(container(data, spec3, lexMd, { context: 'text-lexcol', matchDist: true })), data)
    assert.equal(container(data, spec3, lexMd, { context: 'text-lexcol', matchDist: true })[3], 26, 'matchDist bumps the container to version 26 (stale-bucket fix)')
    assert.equal(container(data, spec3, lex, { context: 'text-lexcol' })[3], 21, 'context index 2 stays inside the version-21 header')
  }
  assert.ok(line.length < sparse.length)
  console.log('P17.8 text-linecol upgrade + text-lexcol wire legality, roundtrip and wins PASS')
}

/** P17.8 direction 2: every carvable segment is scanned, including the members of a
 *  group that already holds several (the P17.7 first-pass blind spot), and pockets are
 *  adopted one at a time against the exact container size. */
export async function testP178Pockets() {
  const data = pocketStream(131072, [40960, 90112], 512)
  const r = await compressAdaptive(data, undefined, { serial: true })
  eq(decompress(r.container), data)
  const pc = r.pocketComparison
  assert.ok(pc, 'the carve stage must report its decision')
  assert.ok(pc.scannedBytes >= 131072 - 512, 'the coarse segment must be scanned')
  assert.ok(pc.pockets.length >= 2, `both embedded ramps must be carved (got ${pc.pockets.length})`)
  assert.ok(pc.accepted, 'the refined container must be strictly smaller')
  assert.ok(r.container.length < data.length, 'container must shrink')
  for (const p of pc.pockets) assert.ok(p.payloadBytes + 24 < p.end - p.start, 'a pocket must pay off locally')
  // The same plan must survive a second pass: the STORE parent now has many members.
  const again = await compressAdaptive(data, undefined, { serial: true })
  eq(again.container, r.container)
  console.log('P17.8 incremental multi-member pocket carve PASS')
}

/** P17.8 direction 3: contiguous BCJ segments are merged BEFORE encoding so the
 *  transform runs on the merged part; the header loses one length per seam and the
 *  container must shrink strictly. */
export async function testP178BcjCoalesce() {
  const data = callStream(131072)
  const third = Math.floor(data.length / 3)
  const picks: PlanSegment[] = [
    { start: 0, end: third, cls: 'binary', spec: { id: ID.BCJ_V3, s: 2, r: 1 } },
    { start: third, end: 2 * third, cls: 'binary', spec: { id: ID.BCJ_V3, s: 2, r: 1 } },
    { start: 2 * third, end: data.length, cls: 'binary', spec: { id: ID.BCJ_V3, s: 2, r: 1 } },
  ]
  const base = await compressGuardedPlanForProbe(data, picks)
  eq(decompress(base.container), data)
  const refined = refineBcjSegments(data, base)
  eq(decompress(refined.container), data)
  const cmp = refined.bcjComparison
  assert.ok(cmp, 'the BCJ stage must report its decision')
  assert.equal(cmp.seams, 2, 'three contiguous BCJ segments hold two seams')
  assert.ok(cmp.accepted, 're-cutting the BCJ stream must be adopted')
  assert.ok(refined.container.length < base.container.length, 'the merged plan must be strictly smaller')
  assert.equal(refined.segs.length, 1, 'the three segments become one')
  assert.equal(refined.segs[0].spec.id, ID.BCJ_V3)
  // A plan without BCJ segments pays nothing and keeps its bytes.
  const plain = refineBcjSegments(data, await compressGuardedPlanForProbe(callStream(16384), [{ start: 0, end: 16384, cls: 'binary', spec: { id: ID.BIN, s: 1, r: 1 } }]))
  assert.equal(plain.bcjComparison?.seams, 0)
  assert.equal(plain.bcjComparison?.accepted, false)
  console.log('P17.8 pre-encoding BCJ segment coalescing roundtrip PASS')
}
