import assert from 'node:assert/strict'
import { fastDeepEqual } from './fast-equal'
import { Worker } from 'node:worker_threads'
import { a2Tuning, modelTuning, encodeCM, cmTableBits } from '../src/lib/coder'
import { encodeGroupForJob } from '../src/lib/codec-jobs'
import { PARALLEL_WORKER_CODE } from '../src/lib/parallel-worker-code'
import { payloadModelFlags } from '../src/lib/payload-model'
import {
  planTuning, ID, encodeTerrainGroup, decompress, compressMacroPlanForProbe, compressOrphanPlanForProbe,
  orphanProposalForProbe, macroDirectSpec, sampleBudgetForSegment, selectionHeaderBytes, selectionRatio,
  candidatesFor, type PlanSegment, type Spec, type Compressed,
} from '../src/lib/codec'

const sp = (id: number): Spec => ({ id, s: 1, r: 1 })
const part = (start: number, end: number, id: number, cls: PlanSegment['cls'] = 'binary'): PlanSegment =>
  ({ start, end, spec: sp(id), cls })
const eq = (a: Uint8Array, b: Uint8Array) => fastDeepEqual(Buffer.from(a), Buffer.from(b))
function wrap(raw: Uint8Array, spec: Spec, payload: Uint8Array, v15 = true, wordPre = false) {
  const flags = payloadModelFlags(payload), h = [85, 67, 90, flags > 255 ? 19 : flags ? 18 : v15 ? 15 : 13]
  if (flags > 255) h.push(flags & 255, flags >>> 8)
  else if (flags) h.push(flags)
  const put = (v: number) => { do { const b = v & 127; v = Math.floor(v / 128); h.push(b | (v ? 128 : 0)) } while (v) }
  for (const v of [raw.length, 1, 1, spec.id, spec.s, spec.r | (v15 ? 0x8000 : 0) | (wordPre ? 0x4000 : 0), payload.length, raw.length]) put(v)
  const result = new Uint8Array(h.length + payload.length); result.set(h); result.set(payload, h.length)
  return result
}
function check(r: Compressed, raw: Uint8Array) {
  eq(decompress(r.container), raw)
  assert.equal(r.overhead + r.segs.reduce((n, s) => n + s.compLen, 0), r.container.length)
  const bits = r.analysis.blocks.reduce((n, b, i) => n + r.blockCost[i] * (b.end - b.start), 0)
  assert.ok(Math.abs(bits - (r.container.length - r.overhead) * 8) < 0.5)
}

/** Small deterministic correctness/policy checks, not a corpus benchmark. */
export async function testP9Defaults() {
  const saved = { a2: { ...a2Tuning }, model: { ...modelTuning }, plan: { ...planTuning } }
  let checks = 0
  try {
    fastDeepEqual(modelTuning, { maxTableBits: 24, matchTableBits: 23, largeOnly: true })
    fastDeepEqual(a2Tuning, { resOn: true, textOn: true, wordPreTextOff: false })
    assert.equal(planTuning.v15SinglePlain, true)
    assert.equal(planTuning.candidateTgV3, true)
    assert.equal(planTuning.dropZeroHitIds, true)
    assert.equal(planTuning.dropLegacyV12Ids, false)
    assert.equal(planTuning.realHeaderCosts, true)
    assert.equal(planTuning.macroUniformGate, true)
    assert.equal(cmTableBits(524287), 21); assert.equal(cmTableBits(524288), 22)
    checks++

    const raw = Uint8Array.from({ length: 6000 }, (_, i) => (i * 37 + (i >> 3)) & 255)
    const text = sp(ID.TEXT_V3), bin = sp(ID.BIN_V3)
    const encode = (tokens: boolean) => encodeCM(raw, 'text', 1, 1, undefined, 0, undefined, undefined, 'v15', 0, tokens)
    a2Tuning.wordPreTextOff = true // explicitly exercise the archived off flag
    const rawOn = encode(false), wpOff = encode(true)
    assert.equal(payloadModelFlags(rawOn), 0)
    assert.equal(payloadModelFlags(wpOff), 64)
    a2Tuning.wordPreTextOff = false
    eq(encode(false), rawOn) // raw text is independent of the WORD-PRE policy
    assert.notDeepEqual(Buffer.from(encode(true)), Buffer.from(wpOff))
    a2Tuning.textOn = false
    const rawOff = encode(false), overrideWp = encode(true)
    assert.equal(payloadModelFlags(rawOff), 1)
    assert.equal(payloadModelFlags(overrideWp), 1)
    eq(overrideWp, wpOff) // explicit global override still disables tokens too
    assert.notDeepEqual(Buffer.from(rawOff), Buffer.from(rawOn))
    eq(decompress(wrap(raw, text, rawOff)), raw)
    checks++

    // v15 alone does not require v17. Raw BIN/O0, res2d and already-suppressed
    // row predictors ignore textOff; unused global table knobs are not emitted.
    a2Tuning.resOn = false
    for (const spec of [bin, sp(ID.O0), { id: ID.GRAD_V3, s: 2, r: 64 }, { id: ID.WIDE_GRAD, s: 1, r: 8192 }]) {
      const p = encodeTerrainGroup([raw], spec, undefined, undefined, undefined, [0], 'v15')
      assert.equal(payloadModelFlags(p), 0)
      const c = wrap(raw, spec, p)
      assert.equal(c[3], 15)
      eq(decompress(c), raw)
      checks++
    }
    const nonV15 = encodeTerrainGroup([raw], text)
    assert.equal(payloadModelFlags(nonV15), 0)
    eq(decompress(wrap(raw, text, nonV15, false)), raw)
    const residual = encodeTerrainGroup([raw], { id: ID.DELTA_V3, s: 2, r: 1 }, undefined, undefined, undefined, [0], 'v15')
    assert.equal(payloadModelFlags(residual), 32)
    eq(decompress(wrap(raw, { id: ID.DELTA_V3, s: 2, r: 1 }, residual)), raw)
    Object.assign(a2Tuning, saved.a2)
    checks++

    // Real final selector: a 3-byte v15 payload loses to a 4-byte legacy payload
    // once its two extra r-varint bytes are charged. No empirical multipliers.
    const tiny = Uint8Array.of(0, 7, 6, 5)
    const priced = await compressMacroPlanForProbe(tiny, [part(0, 4, ID.RLE)], bin)
    assert.equal(priced.macroComparison!.candidateBytes, 16)
    assert.equal(priced.container[3], 13)
    check(priced, tiny)
    const h = selectionHeaderBytes(bin, 1000, 127)
    assert.equal(selectionHeaderBytes(bin, 1000, 128), h + 1)
    assert.equal(selectionHeaderBytes(bin, 1000, 127, 0, true), h + 2)
    assert.equal(selectionHeaderBytes(bin, 1000, 127, 16, true, true), h + 3)
    assert.equal(selectionHeaderBytes({ ...bin, r: 8192 }, 1000, 127), h + 1)
    assert.equal(selectionRatio(bin, 0.5, 1000), 0.5 + selectionHeaderBytes(bin, 1000, 500) / 1000)
    checks++

    // Segment-local budget, not whole-file n: only the individually large
    // segments of a <=4-segment input receive 65536 bytes.
    assert.equal(sampleBudgetForSegment(40 * 1024 * 1024, 2000, 65536), 8192)
    assert.equal(sampleBudgetForSegment(40 * 1024 * 1024, 4, 1024 * 1024), 65536)
    assert.equal(sampleBudgetForSegment(40 * 1024 * 1024, 4, 65536), 16000)
    assert.equal(sampleBudgetForSegment(40 * 1024 * 1024, 5, 1024 * 1024), 16000)
    assert.equal(sampleBudgetForSegment(40 * 1024 * 1024, 2000, 300), 300)
    checks++

    // Pure, virtual-length policy checks allocate no large input.
    const MiB = 1024 * 1024
    const boundary = [part(0, 16 * MiB, ID.TEXT_V3, 'text'),
      part(16 * MiB, 18 * MiB, ID.STORE), // exactly 2 MiB: not eligible
      part(18 * MiB, 19 * MiB, ID.RLE), part(19 * MiB, 20 * MiB, ID.O0),
      part(20 * MiB, 21 * MiB, ID.FILL)]
    fastDeepEqual(orphanProposalForProbe(21 * MiB, boundary)!.members, [0, 2, 3])
    const fifth = [part(0, 800, ID.BIN_V3), part(800, 1000, ID.STORE)]
    assert.equal(orphanProposalForProbe(1000, fifth), null, 'exactly 20% is excluded')
    fastDeepEqual(orphanProposalForProbe(1001, [fifth[0], part(800, 999, ID.STORE), part(999, 1001, ID.FILL)])!.members, [0, 1])
    const many = [part(0, 9000, ID.BIN_V3), ...Array.from({ length: 30 }, (_, i) =>
      ({ ...part(9000 + i * 10, 9010 + i * 10, ID.DELTA), spec: { id: ID.DELTA, s: i + 1, r: 1 } }))]
    assert.equal(orphanProposalForProbe(9300, many)!.groups, 24)
    checks++

    // <=25 MiB OR dominant terrain text bypasses screening; >25 MiB binary
    // remains eligible for the older sample screen (never for sampled adoption).
    const virtual = (n: number, cls: PlanSegment['cls']) => [part(0, Math.floor(n * 0.8), ID.BIN_V3, cls), part(Math.floor(n * 0.8), n, ID.STORE)]
    fastDeepEqual(macroDirectSpec(25 * MiB, virtual(25 * MiB, 'binary')), bin)
    assert.equal(macroDirectSpec(25 * MiB + 1, virtual(25 * MiB + 1, 'binary')), null)
    fastDeepEqual(macroDirectSpec(30 * MiB, virtual(30 * MiB, 'text')), text)
    const phrase = new TextEncoder().encode('alpha beta gamma delta: a shared model observes repeated words and changing row numbers.\n')
    const prose = Uint8Array.from({ length: 49152 }, (_, i) => phrase[i % phrase.length])
    const direct = await compressMacroPlanForProbe(prose, [part(0, 32768, ID.STORE, 'text'), part(32768, prose.length, ID.RLE, 'text')])
    assert.equal(direct.macroComparison!.screen, 'direct')
    assert.equal(direct.macroComparison!.sample, undefined)
    assert.equal(direct.macroComparison!.proposal.id, ID.TEXT_V3)
    assert.equal(direct.macroComparison!.accepted, true)
    assert.ok(direct.container[3] < 18, 'discarded WORD-PRE trial must not add its flag')
    check(direct, prose)
    checks++

    // Actual orphan encodes: strict gain, exact tie/rejection, preserved FILL,
    // and unchanged major groups retain their already-encoded payload costs.
    const input = Uint8Array.from({ length: 16000 }, (_, i) => phrase[i % phrase.length])
    input.fill(42, 15000)
    const picks = [part(0, 6000, ID.TEXT_V3, 'text'), part(6000, 10000, ID.BIN_V3),
      part(10000, 14000, ID.O0), part(14000, 15000, ID.STORE), part(15000, 16000, ID.FILL)]
    const before = JSON.stringify(picks)
    const base = await compressMacroPlanForProbe(input, picks, null)
    const absorbed = await compressOrphanPlanForProbe(input, picks)
    const a = absorbed.orphanComparison!
    assert.ok(a.accepted)
    assert.ok(a.candidateBytes! < a.baselineBytes)
    assert.ok(a.candidateBytes! - a.candidateHeaderBytes! < a.baselineBytes - a.baselineHeaderBytes)
    assert.equal(JSON.stringify(picks), before)
    assert.equal(absorbed.segs[1].compLen, base.segs[1].compLen)
    assert.equal(absorbed.segs[2].compLen, base.segs[2].compLen)
    assert.equal(absorbed.segs[4].spec.id, ID.FILL)
    check(absorbed, input)
    const short = Uint8Array.of(0, 7, 6, 5, 0, 7, 6, 5, 0, 7, 255)
    const shortPlan = [part(0, 10, ID.BIN_V3), part(10, 11, ID.O0)]
    const guarded = await compressOrphanPlanForProbe(short, shortPlan)
    const g = guarded.orphanComparison!
    assert.ok(g)
    assert.equal(g.accepted, false, 'header savings alone cannot authorize orphan absorption')
    assert.equal(g.accepted, g.candidateBytes! < g.baselineBytes
      && g.candidateBytes! - g.candidateHeaderBytes! < g.baselineBytes - g.baselineHeaderBytes)
    check(guarded, short)
    checks++

    // Pruning only removes the user-selected 3a IDs; historical decoders and
    // legacy v1/v2 candidates stay available. WIDE detector coverage is separate.
    const periodic = Uint8Array.from({ length: 32768 }, (_, i) => (i % 1024) & 255)
    const dropped = new Set<number>([ID.RLE, ID.ANCHOR, ID.ANCHOR_FOLD, ID.MICRO, ID.GRAD, ID.GRAD_V2, ID.PEEL, ID.WIDE_GRAD, ID.SUB_TRANSPOSE_V3])
    const candidates = candidatesFor(periodic, 'binary', 2, periodic.subarray(0, 16000))
    assert.ok(candidates.every(s => !dropped.has(s.id)))
    assert.ok(candidates.some(s => s.id === ID.BIN))
    assert.ok(candidates.some(s => s.id === ID.TRANSPOSE_GROUP_V3))
    checks++

    // Actual embedded worker: WORD-PRE's required flag must travel as a number,
    // not disappear with the encoder-only WeakMap during structured cloning.
    const local = encodeGroupForJob([prose], text, [0], [prose.length])
    assert.ok(local.cand?.wordPre)
    assert.equal(local.modelFlags, 0)
    assert.equal(local.cand!.altFlags, 0)
    assert.equal(local.cand!.wordPreFlags, 0)
    const wp = local.cand!.wordPre!
    assert.equal(payloadModelFlags(wp), 0)
    eq(decompress(wrap(prose, text, wp, true, true)), prose)
    const sab = new SharedArrayBuffer(prose.length); new Uint8Array(sab).set(prose)
    const worker = new Worker(PARALLEL_WORKER_CODE, { eval: true, workerData: { sab } })
    try {
      const reply = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WORD-PRE worker timeout')), 15000)
        worker.once('error', e => { clearTimeout(timer); reject(e) })
        worker.once('message', r => { clearTimeout(timer); r.error ? reject(new Error(r.error)) : resolve(r) })
        worker.postMessage({ kind: 'encodeGroup', parts: [[0, prose.length]], spec: text, positions: [0], ends: [prose.length] })
      })
      fastDeepEqual(reply, local)
      checks++
    } finally { await worker.terminate() }
    console.log(`P9 defaults tests passed (${checks} checks; selected flags, selective a2, exact costs/orphans, direct macro, worker metadata)`)
  } finally {
    Object.assign(a2Tuning, saved.a2); Object.assign(modelTuning, saved.model); Object.assign(planTuning, saved.plan)
  }
}
