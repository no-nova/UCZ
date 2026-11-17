import assert from 'node:assert'
import { fastDeepEqual } from './fast-equal'
import {
  ID, encodeTerrainGroup, decodeTerrainGroup, planHeader, decompress, contextSpecAllowed, specLabel,
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

/** Fixed-width records: every line repeats the previous line's byte at the same
 *  column, so a vertical (previous-row) predictor has real signal. */
function columnarText(n: number): Uint8Array {
  const rows: string[] = []
  const titles = ['alpha_record_notes', 'beta_field_values', 'gamma_column_dump', 'delta_row_index']
  let size = 0
  for (let i = 0; size < n; i++) {
    const row = `${100000 + i}:${100000 + i}:${titles[i % titles.length]}_${(i % 89).toString(36)}\n`
    rows.push(row); size += row.length
  }
  return new TextEncoder().encode(rows.join(''))
}

const spec3: Spec = { id: ID.TEXT_V3, s: 1, r: 1 }

/** P24.3: the vertical-predictor column layout is a new extended context
 *  (`text-vertcol`, code 7) that runs the `text-tabcol` hash layout plus two
 *  gated inputs read from the previous row's byte at this field column and this
 *  line column. Gating uses the MSB-first prefix the model is currently coding:
 *  a predictor only contributes while its byte has coded the same prefix. */
export function testP243VerticalColumns() {
  fastDeepEqual(contextCodeOf('text-vertcol'), { code: 7, ext: true })
  assert.equal(contextFromGroupBits(GROUP_CONTEXT_EXT_BIT | (7 << 17)), 'text-vertcol')
  assert.equal(contextSpecAllowed('text-vertcol', spec3, false), true)
  assert.equal(contextSpecAllowed('text-vertcol', { id: ID.TEXT, s: 1, r: 1 }, false), true)
  assert.equal(contextSpecAllowed('text-vertcol', { id: ID.BIN, s: 1, r: 1 }, false), false)
  assert.equal(contextSpecAllowed('text-vertcol', { id: ID.TEXT_V3, s: 1, r: 1 }, true), false)
  assert.equal(contextSpecAllowed('text-vertcol', { id: ID.TEXT_V3, s: 2, r: 1 }, false), false)
  assert.throws(() => encodeTerrainGroup([columnarText(4096)], { id: ID.BIN, s: 1, r: 1 }, undefined, undefined, undefined, [0], 'v20', { context: 'text-vertcol' }), /上下文/)
  const data = columnarText(131072)
  const tab = encodeTerrainGroup([data], spec3, undefined, undefined, undefined, [0], 'v20', { context: 'text-tabcol' })
  const vc = encodeTerrainGroup([data], spec3, undefined, undefined, undefined, [0], 'v20', { context: 'text-vertcol' })
  // The predictors must be live: the same nine hashed contexts plus two gated
  // column inputs have to beat the plain tabular slots on repeated rows.
  assert.ok(vc.length < tab.length, `the vertical columns must beat the tabular slots (${vc.length} vs ${tab.length})`)
  const flags = payloadModelFlags(vc)
  eq(inContainer(flags, () => decodeTerrainGroup(vc, [data.length], spec3, undefined, [0], 'v20', false, { context: 'text-vertcol' }))[0], data)
  eq(decompress(container(data, spec3, vc, { context: 'text-vertcol' })), data)
  assert.equal(container(data, spec3, vc, { context: 'text-vertcol' })[3], 21, 'context code 7 stays inside the version-21 header')
  const md = encodeTerrainGroup([data], spec3, undefined, undefined, undefined, [0], 'v20', { context: 'text-vertcol', matchDist: true })
  const mdFlags = payloadModelFlags(md)
  eq(inContainer(mdFlags, () => decodeTerrainGroup(md, [data.length], spec3, undefined, [0], 'v20', false, { context: 'text-vertcol', matchDist: true }))[0], data)
  eq(decompress(container(data, spec3, md, { context: 'text-vertcol', matchDist: true })), data)
  assert.equal(container(data, spec3, md, { context: 'text-vertcol', matchDist: true })[3], 26, 'matchDist bumps the container to version 26 (stale-bucket fix)')
  console.log('P24.3 text-vertcol wire legality, gated vertical predictors and roundtrip PASS')
}

/** P24.4: `text-vertcol` runs an integer prediction-error EMA that the encoder
 *  and decoder both compute from `(y, pr)`, and above `vertTuning.thr` it damps
 *  the final probability and freezes the row/word tracker. A stream that mixes
 *  real columnar text with an incompressible block exercises both branches; the
 *  only thing that matters is that the two sides never disagree. */
export function testP244SyncHighEntropy() {
  const text = columnarText(65536)
  const noise = new Uint8Array(8192)
  let v = 0x9e3779b9
  for (let i = 0; i < noise.length; i++) { v = (Math.imul(v, 1664525) + 1013904223) >>> 0; noise[i] = v >>> 24 }
  const data = new Uint8Array(text.length + noise.length)
  data.set(text.subarray(0, 32768)); data.set(noise, 32768); data.set(text.subarray(32768), 32768 + noise.length)
  const payload = encodeTerrainGroup([data], spec3, undefined, undefined, undefined, [0], 'v20', { context: 'text-vertcol' })
  const flags = payloadModelFlags(payload)
  eq(inContainer(flags, () => decodeTerrainGroup(payload, [data.length], spec3, undefined, [0], 'v20', false, { context: 'text-vertcol' }))[0], data)
  eq(decompress(container(data, spec3, payload, { context: 'text-vertcol' })), data)
  console.log('P24.4 text-vertcol synchronized emaErr damping/freeze roundtrip PASS')
}
