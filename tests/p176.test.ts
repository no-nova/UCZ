import assert from 'node:assert/strict'
import { fastDeepEqual } from './fast-equal'
import {
  ID, planHeader, encodeTerrainGroup, decodeTerrainGroup, decompress, compressAdaptive, compressGuardedPlanForProbe,
  contextGroupCandidatesSync, contextSpecAllowed, type PlanSegment, type Spec,
} from '../src/lib/codec'
import { payloadModelFlags } from '../src/lib/payload-model'
import {
  withContainerModel, transposeInnerSuppress, V20_FLAG_CM, V20_FLAG_TRANSFORMS, V22_FLAG_MATCH_DISTANCE,
} from '../src/lib/coder'
import { V21_FLAG_CONTEXTS } from '../src/lib/context-policy'

const eq = (a: Uint8Array, b: Uint8Array) => fastDeepEqual(Buffer.from(a), Buffer.from(b))

/** Mirrors the container decoder's own version derivation, so a payload built by
 * `encodeTerrainGroup` can be handed straight to `decodeTerrainGroup` without a
 * full UCZ header. Suppression/APM flags come from the container model, exactly
 * as they do in production. */
function versionOf(flags: number): number {
  return flags & V22_FLAG_MATCH_DISTANCE ? 26 : flags & V21_FLAG_CONTEXTS ? 21
    : flags & (V20_FLAG_TRANSFORMS | V20_FLAG_CM) ? 20 : flags > 255 ? 19 : flags ? 18 : 17
}
const inContainer = <T>(flags: number, fn: () => T): T => (flags ? withContainerModel(versionOf(flags), flags, fn) : fn())

/** Single-group container built by the production serializer, so the decoder
 * path (header validation → kernel/WORD-PRE/context selection → payload) is the
 * one that ships, not a test-only shortcut. */
function container(data: Uint8Array, spec: Spec, payload: Uint8Array,
  meta: { wordPre?: boolean; context?: 'wp-token3'; matchDist?: boolean } = {}): Uint8Array {
  const flags = payloadModelFlags(payload)
  const header = planHeader(data.length, [{ start: 0, end: data.length, cls: 'text', spec }], [{
    spec, members: [0], payload, modelFlags: flags, v15: true,
    wordPre: !!meta.wordPre, context: meta.context, matchDist: !!meta.matchDist,
  }])
  const out = new Uint8Array(header.length + payload.length)
  out.set(Uint8Array.from(header)); out.set(payload, header.length)
  return out
}

/** Two interleaved columns: a 6-bit biased byte (CM friendly, H0 < 7.5) and a
 * xorshift high byte (incompressible). 64 KiB total = 32 KiB per column, which
 * is exactly the shape the wide column screen must accept (>=32768 B), and the
 * planner classifies this shape as a single 2-column transpose. */
function structuredPairs(pairs: number): Uint8Array {
  const out = new Uint8Array(pairs * 2)
  let x = 0x9e3779b9
  for (let i = 0; i < pairs; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0
    out[2 * i] = x & 0x3f
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0
    out[2 * i + 1] = x & 0xff
  }
  return out
}

const codeUnit = new TextEncoder().encode(
  'static int count_value(const uint8_t *input, size_t length) {\n' +
  '  int total = 0;\n' +
  '  for (size_t index = 0; index < length; index++) total += input[index];\n' +
  '  return total;\n' +
  '}\n')
const codeText = (n: number) => Uint8Array.from({ length: n }, (_, i) => codeUnit[i % codeUnit.length])
const sentence = new TextEncoder().encode('alpha beta gamma delta="text"\n')
const wordsText = (n: number) => Uint8Array.from({ length: n }, (_, i) => sentence[i % sentence.length])

/** P17.6: `ID.TRANSPOSE` (id 9) and `ID.TRANSPOSE_GROUP` (id 10) must run their
 * inner single-column CMs under v15/v20 with a2 + mixer2 suppressed, and the
 * payload must carry the v20 kernel flag so the group header selects it. */
export function testP176Transpose() {
  const data = structuredPairs(32768)
  const depth0 = transposeInnerSuppress.depth
  for (const spec of [{ id: ID.TRANSPOSE, s: 2, r: 1 }, { id: ID.TRANSPOSE_GROUP, s: 2, r: 1 }] as Spec[]) {
    const v20 = encodeTerrainGroup([data], spec, undefined, undefined, undefined, [0], 'v20')
    assert.equal(transposeInnerSuppress.depth, depth0, `${spec.id}: suppression depth must be restored`)
    assert.ok(payloadModelFlags(v20) & V20_FLAG_CM, `${spec.id}: v20 kernel must be recorded on the transposed payload`)
    // The transpose encoder suppresses a2/mixer2 itself; an outer suppression
    // must therefore not change a single byte (this is the P17.6 fix — before it
    // `ID.TRANSPOSE` had no suppression at all and `ID.TRANSPOSE_GROUP` only had
    // it when v13 was set, which id 10 never is).
    transposeInnerSuppress.depth++
    let outer: Uint8Array
    try { outer = encodeTerrainGroup([data], spec, undefined, undefined, undefined, [0], 'v20') }
    finally { transposeInnerSuppress.depth-- }
    eq(v20, outer)
    // ... and the suppression is a real model change on this fixture.
    const legacy = encodeTerrainGroup([data], spec, undefined, undefined, undefined, [0], false)
    assert.notEqual(Buffer.from(v20).compare(Buffer.from(legacy)), 0, `${spec.id}: v20 + suppression must differ from the v13 kernel`)
    // Direct group roundtrip under the same container model the payload declares.
    const back = inContainer(payloadModelFlags(v20), () => decodeTerrainGroup(v20, [data.length], spec, undefined, [0], 'v20'))
    eq(back[0], data)
    // Complete container roundtrip (header kernel bit 0x10000 selected from the flags).
    eq(decompress(container(data, spec, v20)), data)
    // The v15 kernel path must roundtrip as well (same framing, no CM flag).
    const v15 = encodeTerrainGroup([data], spec, undefined, undefined, undefined, [0], 'v15')
    assert.equal(payloadModelFlags(v15) & V20_FLAG_CM, 0)
    const back15 = inContainer(payloadModelFlags(v15), () => decodeTerrainGroup(v15, [data.length], spec, undefined, [0], 'v15'))
    eq(back15[0], data)
  }
  assert.equal(transposeInnerSuppress.depth, 0)
  console.log('P17.6 transpose v20/v15 kernel roundtrip, inner a2+mixer2 suppression symmetry, header flag PASS')
}

/** Full planner + container path for the same two specs (serial, one group). */
export async function testP176Container() {
  const data = structuredPairs(32768)
  for (const id of [ID.TRANSPOSE, ID.TRANSPOSE_GROUP]) {
    const seg: PlanSegment = { start: 0, end: data.length, cls: 'binary', spec: { id, s: 2, r: 1 } }
    const r = await compressGuardedPlanForProbe(data, [seg])
    eq(decompress(r.container), data)
    assert.ok(r.container.length < data.length)
    assert.ok([ID.TRANSPOSE, ID.TRANSPOSE_GROUP, ID.TRANSPOSE_2D, ID.TRANSPOSE_GROUP_V3].includes(r.segs[0].spec.id),
      `id ${id}: guarded plan must stay in the transpose family (id 10 may auto-upgrade to 2D)`)
    if (id === ID.TRANSPOSE) assert.equal(r.segs[0].spec.id, ID.TRANSPOSE)
    assert.equal(r.overhead + r.segs.reduce((n, s) => n + s.compLen, 0), r.container.length)
  }
  // The adaptive planner must recognize the same stream shape on its own.
  const adaptive = await compressAdaptive(data, undefined, { serial: true })
  eq(decompress(adaptive.container), data)
  assert.ok(adaptive.segs.some(s => [ID.TRANSPOSE, ID.TRANSPOSE_GROUP, ID.TRANSPOSE_GROUP_V3].includes(s.spec.id as 9 | 10 | 30)),
    'a 2-column structured stream must be planned as a transpose')
  console.log('P17.6 transpose full compress/decompress + planner adoption PASS')
}

/** P17.6: `wp-token3` on raw text (no WORD-PRE dictionary), with and without
 * the v22 distance-split match model. */
export function testP176WordToken3() {
  const text = codeText(131072)
  const spec: Spec = { id: ID.TEXT_V3, s: 1, r: 1 }
  assert.ok(contextSpecAllowed('wp-token3', spec, false))
  assert.ok(contextSpecAllowed('wp-token3', { id: ID.TEXT_V2, s: 1, r: 1 }, false))
  assert.ok(!contextSpecAllowed('wp-token3', { id: ID.BIN, s: 1, r: 1 }, false))
  assert.ok(!contextSpecAllowed('wp-token3', { id: ID.TEXT_V3, s: 2, r: 1 }, false))
  assert.ok(contextSpecAllowed('wp-token3', spec, true), 'WORD-PRE + wp-token3 stays legal for TEXT_V3')
  assert.throws(() => encodeTerrainGroup([text], { id: ID.BIN, s: 1, r: 1 }, undefined, undefined, undefined, [0], 'v20', { context: 'wp-token3' }), /上下文/)
  for (const md of [false, true]) {
    const opts = md ? { context: 'wp-token3' as const, matchDist: true } : { context: 'wp-token3' as const }
    const payload = encodeTerrainGroup([text], spec, undefined, undefined, undefined, [0], 'v20', opts)
    const flags = payloadModelFlags(payload)
    assert.ok(flags & V21_FLAG_CONTEXTS)
    if (md) assert.ok(flags & V22_FLAG_MATCH_DISTANCE)
    else assert.equal(flags & V22_FLAG_MATCH_DISTANCE, 0)
    const back = inContainer(flags, () => decodeTerrainGroup(payload, [text.length], spec, undefined, [0], 'v20', false, opts))
    eq(back[0], text)
    eq(decompress(container(text, spec, payload, { context: 'wp-token3', matchDist: md })), text)
    // wordTokens = true must actually change the bit stream vs. the sparse5 control.
    const control = encodeTerrainGroup([text], spec, undefined, undefined, undefined, [0], 'v20', md ? { matchDist: true } : undefined)
    assert.notEqual(Buffer.from(payload).compare(Buffer.from(control)), 0, 'word-trigram H[8] must change the encoded stream')
  }
  // Raw-text screening must price the new context (wordPre === false path).
  const cand = contextGroupCandidatesSync([text], spec, [0], undefined, true, true, true)!
  assert.ok(cand.trials.some(t => t.context === 'wp-token3'), 'raw-text screening must propose wp-token3')
  for (const trial of cand.trials.filter(t => t.context === 'wp-token3')) {
    const opts = trial.matchDist ? { context: 'wp-token3' as const, matchDist: true } : { context: 'wp-token3' as const }
    const back = inContainer(trial.flags, () => decodeTerrainGroup(trial.payload, [text.length], spec, undefined, [0], 'v20', false, opts))
    eq(back[0], text)
    eq(decompress(container(text, spec, trial.payload, { context: 'wp-token3', matchDist: !!trial.matchDist })), text)
  }
  console.log('P17.6 raw-text wp-token3 (no dictionary, ±matchDist) group + container roundtrip, screening PASS')
}

/** P17.6: dictionary-collapsed WORD-PRE keeps its dedicated payload framing and
 * must still decode through `decodeTerrainGroupWordPre` when the group also
 * carries `context: 'wp-token3'`. */
export function testP176WordPreToken3() {
  const text = wordsText(sentence.length * 1200)
  const spec: Spec = { id: ID.TEXT_V3, s: 1, r: 1 }
  const cand = contextGroupCandidatesSync([text], spec, [0], undefined, true, false, true)!
  const trials = cand.trials.filter(t => t.context === 'wp-token3')
  assert.ok(trials.length > 0, 'WORD-PRE groups must still price wp-token3')
  for (const trial of trials) {
    const opts = trial.matchDist ? { context: 'wp-token3' as const, matchDist: true } : { context: 'wp-token3' as const }
    const back = inContainer(trial.flags, () => decodeTerrainGroup(trial.payload, [text.length], spec, undefined, [0], 'v20', true, opts))
    eq(back[0], text)
    eq(decompress(container(text, spec, trial.payload, { wordPre: true, context: 'wp-token3', matchDist: !!trial.matchDist })), text)
  }
  console.log('P17.6 WORD-PRE + wp-token3 group + container roundtrip PASS')
}
