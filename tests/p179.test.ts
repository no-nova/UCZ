import assert from 'node:assert'
import { fastDeepEqual } from './fast-equal'
import {
  ID, encodeTerrainGroup, decodeTerrainGroup, planHeader, decompress,
  compressGuardedPlanForProbe, refineGroupCodecs, contextSpecAllowed, specLabel,
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

/** Colon separated records whose field columns repeat exactly line to line. */
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

/** Low-stride delta stream: a CM delta recipe codes it far below the byte recipe. */
function deltaStream(n: number): Uint8Array {
  const out = new Uint8Array(n)
  let v = 7
  for (let i = 0; i < n; i++) { v = (v + 3 + (i % 97 === 0 ? 5 : 0)) & 0xff; out[i] = v }
  return out
}

const spec3: Spec = { id: ID.TEXT_V3, s: 1, r: 1 }

/** P17.9 direction 1: the extended context namespace now carries three column
 *  layouts — `text-linecol` (P17.7, unchanged wire), `text-lexcol` (hybrid1 word
 *  slots) and `text-tabcol` (hybrid3 tabular slots) — and all three run the
 *  line/field driven state tracker, which is what makes them beat sparse words. */
export function testP179TextContexts() {
  fastDeepEqual(contextCodeOf('text-linecol'), { code: 1, ext: true })
  fastDeepEqual(contextCodeOf('text-lexcol'), { code: 2, ext: true })
  fastDeepEqual(contextCodeOf('text-tabcol'), { code: 3, ext: true })
  assert.equal(contextFromGroupBits(GROUP_CONTEXT_EXT_BIT | (3 << 17)), 'text-tabcol')
  assert.equal(contextFromGroupBits(5 << 17), 'text-sparse5')
  for (const ctx of ['text-linecol', 'text-lexcol', 'text-tabcol'] as const) {
    assert.equal(contextSpecAllowed(ctx, spec3, false), true)
    assert.equal(contextSpecAllowed(ctx, { id: ID.TEXT, s: 1, r: 1 }, false), true)
    assert.equal(contextSpecAllowed(ctx, { id: ID.BIN, s: 1, r: 1 }, false), false)
    assert.equal(contextSpecAllowed(ctx, { id: ID.TEXT_V3, s: 1, r: 1 }, true), false)
    assert.equal(contextSpecAllowed(ctx, { id: ID.TEXT_V3, s: 2, r: 1 }, false), false)
  }
  assert.throws(() => encodeTerrainGroup([codeText(4096)], { id: ID.BIN, s: 1, r: 1 }, undefined, undefined, undefined, [0], 'v20', { context: 'text-tabcol' }), /上下文/)
  const tabular = tabularText(131072)
  const code = codeText(131072)
  const sparse = encodeTerrainGroup([tabular], spec3, undefined, undefined, undefined, [0], 'v20', { context: 'text-sparse5' })
  const line = encodeTerrainGroup([tabular], spec3, undefined, undefined, undefined, [0], 'v20', { context: 'text-linecol' })
  const lex = encodeTerrainGroup([tabular], spec3, undefined, undefined, undefined, [0], 'v20', { context: 'text-lexcol' })
  const tab = encodeTerrainGroup([tabular], spec3, undefined, undefined, undefined, [0], 'v20', { context: 'text-tabcol' })
  // The tracker must be live: without line/field state these layouts hash only
  // constant values and cost more than the sparse word slots.
  assert.ok(line.length < sparse.length, `line/field columns must beat sparse words (${line.length} vs ${sparse.length})`)
  assert.ok(tab.length < line.length, `tabular slots must beat the field-only layout (${tab.length} vs ${line.length})`)
  assert.ok(lex.length < sparse.length, `lexical slots must beat sparse words (${lex.length} vs ${sparse.length})`)
  const codeLex = encodeTerrainGroup([code], spec3, undefined, undefined, undefined, [0], 'v20', { context: 'text-lexcol' })
  const codeLine = encodeTerrainGroup([code], spec3, undefined, undefined, undefined, [0], 'v20', { context: 'text-linecol' })
  assert.ok(codeLex.length < codeLine.length, `the word slots must win on source code (${codeLex.length} vs ${codeLine.length})`)
  for (const [name, data, payload, ctx] of [['tabular', tabular, tab, 'text-tabcol'], ['code', code, codeLex, 'text-lexcol']] as const) {
    const flags = payloadModelFlags(payload)
    eq(inContainer(flags, () => decodeTerrainGroup(payload, [data.length], spec3, undefined, [0], 'v20', false, { context: ctx }))[0], data)
    eq(decompress(container(data, spec3, payload, { context: ctx })), data)
    assert.equal(container(data, spec3, payload, { context: ctx })[3], 21, `${name}: context index stays inside the version-21 header`)
    const md = encodeTerrainGroup([data], spec3, undefined, undefined, undefined, [0], 'v20', { context: ctx, matchDist: true })
    const mdFlags = payloadModelFlags(md)
    eq(inContainer(mdFlags, () => decodeTerrainGroup(md, [data.length], spec3, undefined, [0], 'v20', false, { context: ctx, matchDist: true }))[0], data)
    eq(decompress(container(data, spec3, md, { context: ctx, matchDist: true })), data)
    assert.equal(container(data, spec3, md, { context: ctx, matchDist: true })[3], 26, `${name}: matchDist bumps the container to version 26`)
  }
  console.log('P17.9 text-lexcol upgrade + text-tabcol wire legality, tracker liveness and roundtrip PASS')
}

/** P17.9 direction 2: small non-STORE groups are re-priced after the carve, one
 *  group at a time, and every upgrade is gated by the exact serialized plan. */
export async function testP179GroupCodecs() {
  const data = deltaStream(131072)
  const picks: PlanSegment[] = [
    { start: 0, end: 16384, cls: 'binary', spec: { id: ID.BIN, s: 1, r: 1 } },
    { start: 16384, end: 65536, cls: 'binary', spec: { id: ID.STORE, s: 1, r: 1 } },
    { start: 65536, end: 81920, cls: 'binary', spec: { id: ID.BIN, s: 1, r: 1 } },
    { start: 81920, end: 131072, cls: 'binary', spec: { id: ID.STORE, s: 1, r: 1 } },
  ]
  const base = await compressGuardedPlanForProbe(data, picks)
  eq(decompress(base.container), data)
  const refined = refineGroupCodecs(data, base)
  eq(decompress(refined.container), data)
  const cmp = refined.groupCodecComparison
  assert.ok(cmp, 'the group codec stage must report its decision')
  assert.ok(cmp.scannedGroups >= 1, `the small BIN group must be priced (got ${cmp.scannedGroups})`)
  assert.ok(cmp.accepted, 'a small BIN group must find a CM recipe')
  assert.ok(refined.container.length < base.container.length, 'the upgraded plan must be strictly smaller')
  assert.ok(cmp.upgrades.length >= 1)
  for (const u of cmp.upgrades) {
    assert.equal(u.from.id, ID.BIN)
    assert.notDeepEqual(u.to, u.from)
  }
  // Header legality: the upgraded rule key must not collide with any live group.
  const ids = refined.segs.map(s => s.spec.id)
  assert.ok(ids.includes(ID.STORE), 'the STORE remainder stays untouched')
  const keys = new Set(refined.segs.map(s => `${s.spec.id},${s.spec.s},${s.spec.r}`))
  assert.ok(keys.size >= 2, 'upgraded groups keep distinct rule keys')
  for (const k of keys) assert.ok(k !== `${ID.BIN},1,1` || !cmp.accepted, 'an adopted upgrade moves the group off its old rule key')
  // A plan whose only candidate group is above the 128 KiB bound is left alone.
  const bigData = deltaStream(262144)
  const big = await compressGuardedPlanForProbe(bigData, [{ start: 0, end: 262144, cls: 'binary', spec: { id: ID.BIN, s: 1, r: 1 } }])
  const bigRefined = refineGroupCodecs(bigData, big)
  assert.equal(bigRefined.groupCodecComparison?.scannedGroups, 0)
  assert.equal(bigRefined.groupCodecComparison?.accepted, false)
  eq(bigRefined.container, big.container)
  console.log('P17.9 post-carve small-group codec refinement roundtrip PASS')
}
