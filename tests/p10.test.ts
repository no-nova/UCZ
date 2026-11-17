import assert from 'node:assert/strict'
import { fastDeepEqual } from './fast-equal'
import { createHash } from 'node:crypto'
import e24 from './e24-v17-fixture.json'
import {
  modelTuning, a2Tuning, cmTableShape, cmTableBits, withCMBlockSize, withContainerModel,
  encodeCM, decodeCM, encodeCMDual, setAttribHook, attribHook,
  V18_FLAG_BIG_TABLE_22, V18_FLAG_TABLE_23, V18_FLAG_MATCH_22,
} from '../src/lib/coder'
import { payloadModelFlags } from '../src/lib/payload-model'
import {
  ID, encodeTerrainGroup, decodeTerrainGroup, decompress, compressAdaptive,
  compressGuardedPlanForProbe, groupV15CandidatesSync, encodeGroupDualForProbe,
  type PlanSegment, type Spec, type Compressed, type GroupJobRunner, parallelReport,
} from '../src/lib/codec'
import { V22_FLAG_MATCH_DISTANCE } from '../src/lib/coder'
import { V21_FLAG_CONTEXTS } from '../src/lib/context-policy'
import { runParallelJobs, closePool } from '../src/lib/parallel-pool'

const eq = (a: Uint8Array, b: Uint8Array) => fastDeepEqual(Buffer.from(a), Buffer.from(b))
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const part = (start: number, end: number, id: number, s = 1): PlanSegment =>
  ({ start, end, cls: 'binary', spec: { id, s, r: 1 } })
function check(r: Compressed, data: Uint8Array) {
  eq(decompress(r.container), data)
  assert.equal(r.overhead + r.segs.reduce((n, s) => n + s.compLen, 0), r.container.length)
  const bits = r.analysis.blocks.reduce((n, b, i) => n + r.blockCost[i] * (b.end - b.start), 0)
  assert.ok(Math.abs(bits - (r.container.length - r.overhead) * 8) < .5)
}

/** All actual inputs <=48 KiB. Large sizes below are policy scalars, NOT corpus
 * encodes. One tiny raw-CM scope test checks actual 23-bit allocation explicitly. */
export async function testP10() {
  const saved = { model: { ...modelTuning }, a2: { ...a2Tuning }, hook: attribHook,
    threads: process.env.UCZ_THREADS, parallel: { ...parallelReport } }
  let checks = 0
  const MiB = 1024 * 1024
  try {
    assert.equal(V18_FLAG_BIG_TABLE_22, 0x02)
    assert.equal(V18_FLAG_TABLE_23, 0x04)
    fastDeepEqual(modelTuning, { maxTableBits: 24, matchTableBits: 23, largeOnly: true })
    const boundarySizes = [512 * 1024 - 1, 512 * 1024, 4 * MiB - 1, 4 * MiB]
    const boundaries = boundarySizes.map(n => cmTableShape(n))
    fastDeepEqual(boundaries.map(g => [g.cmBits, g.mht4Bits, g.mht8Bits]),
      [[21, 20, 20], [22, 20, 21], [22, 20, 21], [23, 20, 22]])
    for (const [bytes, bits] of [[512 * 1024 - 1, 14], [512 * 1024, 22], [4 * MiB - 1, 22], [4 * MiB, 23]])
      assert.equal(withCMBlockSize(bytes, () => cmTableBits(1024)), bits)
    // A transform can expand its stream. The raw group's tier still wins.
    assert.equal(withCMBlockSize(4 * MiB - 1, () => cmTableBits(8 * MiB)), 22)
    assert.equal(withCMBlockSize(4 * MiB, () => cmTableBits(0)), 10)
    checks++

    const saoBytes = 7251944, oneColumn = Math.floor(saoBytes / 28)
    const saoV17 = withContainerModel(17, 37, () => withCMBlockSize(saoBytes, () => cmTableShape(oneColumn)))
    const saoV18 = withContainerModel(18, 20, () => withCMBlockSize(saoBytes, () => cmTableShape(oneColumn)))
    assert.equal(saoV17.cmBits, 21)
    assert.equal(saoV18.cmBits, 23)
    assert.equal(saoV18.mht8Bits, 22)
    assert.equal(saoV18.sizingBytes, saoBytes)
    // Every old v17 mask keeps its old definitions. No model allocation here.
    for (let flags = 0; flags < 64; flags++) {
      const g = withContainerModel(17, flags, () => withCMBlockSize(saoBytes, () => cmTableShape(262145)))
      assert.equal(g.cmBits, flags & 1 && !(flags & 32) ? 22 : 21)
      assert.equal(g.mht4Bits, flags & 4 && !(flags & 32) ? 21 : 20)
    }
    // v21 IS supported since fbf3c87, so (21, 0) now fails later, on the flag
    // combination (v21 requires V21_FLAG_CONTEXTS | V20_FLAG_CM) — a different,
    // equally correct rejection. Keep one assertion per concern: an unsupported
    // VERSION must be rejected for being a version, and a missing v21 flag must be
    // rejected for being a flag configuration.
    // v22 is supported since P17.1 (group match-distance bit), v23/v24/v25 since P37.2-P37.7
    // (strict profile, strict+CRC, default+CRC), so the representative unsupported version is v26.
    assert.throws(() => withContainerModel(28, 0, () => {}), /版本/)
    assert.throws(() => withContainerModel(21, 0, () => {}), /无效的 v21 模型配置/)
    assert.throws(() => withContainerModel(18, 0x84, () => {}), /v18/)
    assert.throws(() => withCMBlockSize(4 * MiB, () => { throw Error('scope restore') }), /scope restore/)
    assert.equal(cmTableBits(1024), 14)
    checks++

    const old = Buffer.from(e24.containerBase64, 'base64')
    assert.equal(sha(old), e24.containerSha256)
    assert.equal(old[3], 17); assert.equal(old[4], 16) // old WP-only, not v18 match22
    const pattern = new TextEncoder().encode(e24.phrase)
    const original = Uint8Array.from({ length: e24.n }, (_, i) => pattern[i % pattern.length])
    assert.equal(sha(decompress(old)), e24.rawSha256)
    eq(decompress(old), original)
    // v24/v25 add the CRC-32C trailer (strict / default priors); v26 tops out.
    assert.throws(() => decompress(Uint8Array.of(85, 67, 90, 28, 0)), /版本/)
    checks++

    // Actual large tables, but only 128 bytes are encoded. Explicit raw-model
    // scope is NOT presented as a valid 4 MiB container or a compression benchmark.
    const tiny = Uint8Array.from({ length: 128 }, (_, i) => (i * 23 + (i >> 3)) & 255)
    let allocation: { dimensions: number[]; sizingBytes: number; inputBytes: number } | undefined
    setAttribHook((m, i) => {
      if (!i) {
        const v = m as typeof m & { mht: Int32Array; mht8: Int32Array }
        allocation = { dimensions: [m.tables[0].length, v.mht.length, v.mht8.length],
          sizingBytes: m.geometry.sizingBytes, inputBytes: m.geometry.inputBytes }
        setAttribHook(null)
      }
    })
    const payload = withCMBlockSize(4 * MiB, () => encodeCM(tiny, 'bin', 1, 1, undefined, 0, undefined, undefined, 'v15'))
    assert.equal(payloadModelFlags(payload), V18_FLAG_TABLE_23 | V18_FLAG_MATCH_22)
    fastDeepEqual(allocation, { dimensions: [2 ** 23, 2 ** 20, 2 ** 22], sizingBytes: 4 * MiB, inputBytes: tiny.length })
    Object.assign(modelTuning, { maxTableBits: 21, matchTableBits: 20 })
    eq(withContainerModel(18, payloadModelFlags(payload), () => withCMBlockSize(4 * MiB,
      () => decodeCM(payload, tiny.length, 'bin', 1, 1, undefined, 'v15'))), tiny)
    Object.assign(modelTuning, saved.model)
    // Removing the unused dual base must preserve alt exactly, including tier23.
    const dual = withCMBlockSize(4 * MiB, () => encodeCMDual(tiny, 'bin', 1, 1, 'v15'))
    eq(dual.alt, payload)
    assert.equal(payloadModelFlags(dual.alt), payloadModelFlags(payload))
    checks++

    // TG v15 must be a pure v15 payload, not min(base,v15) mislabeled by 0x8000.
    // Two regions keep every search window shorter than the full group so the
    // read-only hook can distinguish search models from final channel models.
    const grid = Uint8Array.from({ length: 28 * 128 * 2 }, (_, i) => ((i >> 2) * 3 + (i % 28) * 13) & 255)
    const parts = [grid.subarray(0, grid.length / 2), grid.subarray(grid.length / 2)]
    const tg: Spec = { id: ID.TRANSPOSE_GROUP_V3, s: 28, r: 1 }
    const finalKernels: boolean[] = [], sampleSizes: number[] = []
    setAttribHook((m, i) => {
      if (i) return
      if (m.geometry.sizingBytes === grid.length) finalKernels.push(m.isV15)
      else sampleSizes.push(m.geometry.sizingBytes)
    })
    const v15 = encodeTerrainGroup(parts, tg, undefined, undefined, undefined, [0, parts[0].length], 'v15')
    setAttribHook(null)
    assert.ok(finalKernels.length > 0, 'fixture must exercise final CM channels')
    assert.ok(finalKernels.every(Boolean), 'no redundant full base encode inside the v15 path')
    assert.ok(sampleSizes.every(n => n <= parts[0].length), 'layout probes must not inherit full-group sizing')
    fastDeepEqual(decodeTerrainGroup(v15, parts.map(p => p.length), tg, undefined, [0, parts[0].length], 'v15'), parts)
    assert.equal(payloadModelFlags(v15) & 6, 0, 'small actual group never emits table22/23')
    for (const spec of [{ id: ID.SUB_TRANSPOSE_V3, s: 4, r: 2 }, { id: ID.SUB_ANCHOR_V3, s: 10, r: 8 }]) {
      const bytes = Uint8Array.from({ length: 3072 }, (_, i) => i % 17 === 0 ? 10 : (i * 3) & 127)
      const p = encodeTerrainGroup([bytes], spec)
      eq(decodeTerrainGroup(p, [bytes.length], spec)[0], bytes)
      assert.equal(payloadModelFlags(p) & 6, 0)
    }
    checks++

    // P17.2: single-fragment identity rules must honour `matchDist` on BOTH sides.
    // `AITDCC/I` (segs 1, id 4 CM-TEXT, context undefined, matchDist true) encoded
    // with the second distance table but decoded without it: the right NUMBER of
    // wrong bytes, and no header exception to catch it. id 4/5 used to be a pair of
    // hand-written encoder/decoder branches that had drifted apart.
    {
      const words = new TextEncoder().encode('the quick brown fox jumps over the lazy dog. '.repeat(400))
      const bytes = Uint8Array.from({ length: 41000 }, (_, i) => (i * 37 + (i >> 5)) & 255)
      for (const [data, specs] of [[words, [ID.O0, ID.TEXT, ID.BIN, ID.TEXT_V3, ID.BIN_V3]], [bytes, [ID.O0, ID.TEXT, ID.BIN, ID.TEXT_V3, ID.BIN_V3]]] as const) {
        for (const id of specs) {
          for (const frags of [1, 2]) {
            const half = data.length >> 1
            const parts = frags === 1 ? [data] : [data.subarray(0, half), data.subarray(half)]
            const lens = parts.map(p => p.length), pos = frags === 1 ? [0] : [0, half]
            const spec: Spec = { id, s: 1, r: 1 }
            for (const md of [false, true]) {
              const options = md ? { matchDist: true as const } : undefined
              const payload = encodeTerrainGroup(parts, spec, undefined, undefined, undefined, pos, 'v20', options)
              fastDeepEqual(decodeTerrainGroup(payload, lens, spec, undefined, pos, 'v20', false, options), parts,
                `id=${id} frags=${frags} matchDist=${md} must round-trip`)
              // O0 runs a profile the second distance table does not cover, so the
              // option is inert there by design (legacyCmOptions); text/bin must
              // advertise it in their own flag set.
              if (md && id !== ID.O0) assert.equal(payloadModelFlags(payload) & V22_FLAG_MATCH_DISTANCE, V22_FLAG_MATCH_DISTANCE,
                `id=${id} matchDist payload must carry the v22 flag`)
            }
          }
        }
      }
    }
    checks++

    // P17.3: BCJ / BCJ2 / BCJ3 (11/20/25) × {single-part, multi-part} ×
    // {no context, bin-stride4} × {no matchDist, matchDist}. The `bin-stride4`
    // context is an identity BIN model over the group's OWN filtered stream, so the
    // encoder must run the declared E8/E9 transform before the CM and the decoder
    // must undo it — a pure identity decode would silently return filtered bytes.
    // BCJ3's productive spec is s=2 (bcjMsbFwd, carry-preserving); covering only
    // s=1 is what let the v21 gate disqualify every real ooffice/H group.
    {
      const code = Uint8Array.from({ length: 40000 }, (_, i) =>
        i % 7 === 0 ? 0xe8 : i % 11 === 0 ? 0xe9 : (i * 37 + (i >> 5)) & 255)
      const half = code.length >> 1
      let cells = 0
      for (const [id, strides] of [[ID.BCJ, [1]], [ID.BCJ_V2, [1]], [ID.BCJ_V3, [1, 2]]] as const) {
        for (const s of strides) {
          for (const frags of [1, 2]) {
            const parts = frags === 1 ? [code] : [code.subarray(0, half), code.subarray(half)]
            const lens = parts.map(p => p.length), pos = frags === 1 ? [0] : [0, half]
            for (const context of [undefined, 'bin-stride4'] as const) {
              for (const md of [false, true]) {
                const spec: Spec = { id, s, r: 1 }
                const options = context || md ? { context, matchDist: md || undefined } as any : undefined
                const payload = encodeTerrainGroup(parts, spec, undefined, undefined, undefined, pos, 'v20', options)
                const back = decodeTerrainGroup(payload, lens, spec, undefined, pos, 'v20', false, options)
                fastDeepEqual(Buffer.concat(back), Buffer.from(code),
                  `BCJ id=${id} s=${s} frags=${frags} context=${context} matchDist=${md} must round-trip`)
                if (context) assert.equal(payloadModelFlags(payload) & V21_FLAG_CONTEXTS, V21_FLAG_CONTEXTS,
                  `BCJ id=${id} context payload must advertise the v21 namespace`)
                cells++
              }
            }
          }
        }
      }
      assert.equal(cells, 32, 'BCJ round-trip matrix must cover every cell')
    }
    checks++

    // P17.3 invariant: matchDist is a v20-kernel feature. Requesting it on an older
    // kernel must RAISE rather than emit a stream whose decoder builds a different
    // model — that failure mode (right length, wrong bytes, no exception) is the one
    // P17.2 spent a whole cycle chasing on AITDCC/I.
    {
      const data = Uint8Array.from({ length: 20000 }, (_, i) => (i * 37 + (i >> 6)) & 255)
      for (const id of [ID.TEXT, ID.BIN, ID.TEXT_V3, ID.BIN_V3]) {
        assert.throws(() => encodeTerrainGroup([data], { id, s: 1, r: 1 } as Spec, undefined, undefined,
          undefined, [0], 'v15', { matchDist: true }), /matchDist/,
          `id=${id} must refuse matchDist on a legacy kernel`)
      }
    }
    checks++

    for (const spec of [{ id: ID.BIN_V3, s: 1, r: 1 }, { id: ID.TEXT_V3, s: 1, r: 1 }, { id: ID.DELTA_V3, s: 2, r: 1 }]) {
      const input = Uint8Array.from({ length: 4096 }, (_, i) => (i * 29 + (i >> 4)) & 255)
      const pieces = [input.subarray(0, 1800), input.subarray(1800)]
      eq(groupV15CandidatesSync(pieces, spec, [0, 1800])!.alt!, encodeGroupDualForProbe(pieces, spec, [0, 1800])!)
    }
    checks++

    // Real workers on small inputs. Only LPT scheduling weights are inflated to
    // exercise production dispatch without doing >256 KiB compression work.
    process.env.UCZ_THREADS = '2'
    const batches: { jobs: number; inputBytes: number; originalLoads: number[] }[] = []
    const runner: GroupJobRunner = async (jobs, loads, data) => {
      assert.ok(data.length <= 256 * 1024)
      batches.push({ jobs: jobs.length, inputBytes: data.length, originalLoads: [...loads] })
      return runParallelJobs(jobs, loads.map(n => Math.max(n, 512 * 1024)), data)
    }
    const data = Uint8Array.from({ length: 32768 }, (_, i) => (i * 7 + (i >>> 8)) & 63)
    const picks = [part(0, 20000, ID.BIN_V3), part(20000, 28192, ID.DELTA, 2),
      part(28192, 30240, ID.STORE), part(30240, 31264, ID.RLE), part(31264, 32768, ID.O0)]
    const before = JSON.stringify(picks)
    const cold = await compressGuardedPlanForProbe(data, picks, { serial: true, batchGuards: false })
    const warm = await compressGuardedPlanForProbe(data, picks, { runJobs: runner })
    eq(warm.container, cold.container); check(warm, data)
    assert.equal(JSON.stringify(picks), before)
    fastDeepEqual(warm.blockCost, cold.blockCost)
    assert.equal(warm.guardStats!.orphanTrials, 1, 'three orphan groups are one complete trial')
    assert.equal(warm.guardStats!.macroTrials, 1)
    assert.equal(warm.guardStats!.macroPrefetched, 1)
    assert.equal(warm.guardStats!.macroReused, 1)
    assert.ok(batches.some(b => b.jobs === 2), 'orphan and mandatory macro share a batch')
    assert.equal(warm.macroComparison!.baselineBytes,
      warm.orphanComparison!.accepted ? warm.orphanComparison!.candidateBytes : warm.orphanComparison!.baselineBytes)
    assert.equal(warm.macroComparison!.accepted, warm.macroComparison!.candidateBytes! < warm.macroComparison!.baselineBytes)
    checks++

    // No orphan possible: baseline and the direct macro can share the first batch.
    const directPicks = [part(0, 16384, ID.BIN_V3), part(16384, 32768, ID.DELTA, 2)]
    const directCold = await compressGuardedPlanForProbe(data, directPicks, { serial: true })
    const directWarm = await compressGuardedPlanForProbe(data, directPicks, { runJobs: runner })
    eq(directWarm.container, directCold.container); check(directWarm, data)
    assert.equal(directWarm.guardStats!.orphanTrials, 0)
    assert.equal(directWarm.guardStats!.macroPrefetched, 1)
    assert.equal(directWarm.guardStats!.macroReused, 1)
    checks++

    // Do not precompute a macro that may become unnecessary after absorption.
    const collapsePicks = [part(0, 28192, ID.BIN_V3), part(28192, 30240, ID.STORE),
      part(30240, 31264, ID.RLE), part(31264, 32768, ID.O0)]
    const collapsed = await compressGuardedPlanForProbe(data, collapsePicks, { runJobs: runner })
    check(collapsed, data)
    assert.equal(collapsed.guardStats!.macroPrefetched, 0)
    assert.ok(collapsed.orphanComparison!.accepted)
    assert.equal(collapsed.guardStats!.macroTrials, 0)
    checks++

    const failed = await compressGuardedPlanForProbe(data, picks, { runJobs: async () => { throw Error('injected worker failure') } })
    eq(failed.container, cold.container); check(failed, data)
    assert.ok(failed.guardStats!.workerFallbacks > 0)
    Object.assign(parallelReport, saved.parallel)
    checks++

    // Actual family bases, including rejected proposals, retain exact cost bins.
    const families = [part(0, 18000, ID.BIN), part(18000, 32768, ID.BIN_V2)]
    const family = await compressGuardedPlanForProbe(data, families, { serial: true })
    check(family, data)
    assert.ok(family.guardStats!.reusedFamilyBases > 0)
    checks++

    // P17.4: native TRANSPOSE_GROUP_V3 (id 30) column groups x {4, 8, 16} strides
    // x {single, multi-part} x {no context, xform-bin-stride4} x {md off, md on}.
    // The column planner emits per-group mode tags, and only `BIN` (m=5) runs a CM
    // profile that can host the second distance table; every cell must still be
    // byte-exact, and the v22 flag may only appear when a CM column actually ran.
    {
      const rec = (rows: number, width: number) => {
        const b = new Uint8Array(rows * width)
        let z = 0x1234567
        for (let i = 0; i < rows; i++) for (let c = 0; c < width; c++) {
          if (c === 0) b[i * width] = (i * 7) & 255
          else if (c === 1) { z ^= z << 13; z >>>= 0; z ^= z >>> 17; z ^= z << 5; z >>>= 0; b[i * width + 1] = z & 255 }
          else b[i * width + c] = ((i >> (4 + c)) & 15) * 16
        }
        return b
      }
      let cells = 0
      for (const width of [4, 8, 16]) {
        const whole = rec(4096, width), half = (whole.length / width / 2) | 0
        for (const frags of [1, 2]) {
          const parts = frags === 1 ? [whole]
            : [whole.subarray(0, half * width), whole.subarray(half * width)]
          const lens = parts.map(p => p.length)
          const pos = frags === 1 ? [0] : [0, half * width]
          // `xform-bin*` is only legal for DELTA / GRAD_V3 / TRANSPOSE_2D (see
          // contextSpecAllowed); the context a native TG3 group actually hosts is
          // plain `bin-stride4`, which also carries its own v20 column recipe.
          for (const context of [undefined, 'bin-stride4'] as const) {
            for (const md of [false, true]) {
              const spec: Spec = { id: ID.TRANSPOSE_GROUP_V3, s: width, r: 1 }
              const options = context || md ? { context, matchDist: md || undefined } as any : undefined
              const payload = encodeTerrainGroup(parts, spec, undefined, undefined, undefined, pos, 'v20', options)
              const back = decodeTerrainGroup(payload, lens, spec, undefined, pos, 'v20', false, options)
              fastDeepEqual(Buffer.concat(back), Buffer.from(whole),
                `id30 s=${width} frags=${frags} context=${context} matchDist=${md} must round-trip`)
              cells++
            }
          }
        }
      }
      // 3 strides x 2 fragmentations x 2 contexts x 2 matchDist = 24 cells.
      assert.equal(cells, 24, 'id30 matrix must cover every cell')
    }
    checks++

    // P17.4: `ID.TRANSPOSE (9)` must be able to reach the layout comparison at all.
    // Before the fix it fell through to the generic kernel chooser and a group whose
    // four columns split into one structured + three coarse-step families stayed on
    // the single legacy stream. Now the same bytes adopt 30 when it is strictly
    // smaller, and the container must shrink too (not just the payload).
    {
      const rec = (rows: number) => {
        const b = new Uint8Array(rows * 4)
        let z = 0x1234567
        for (let i = 0; i < rows; i++) {
          b[i * 4] = (i * 7) & 255
          z ^= z << 13; z >>>= 0; z ^= z >>> 17; z ^= z << 5; z >>>= 0
          b[i * 4 + 1] = z & 255
          b[i * 4 + 2] = (i % 3 === 0) ? 0xaa : 0x55
          b[i * 4 + 3] = ((i >> 4) & 15) * 16
        }
        return b
      }
      const data = rec(32768)
      // P17.6: `ID.TRANSPOSE` now runs its inner columns under v20 with the same
      // a2/mixer2 suppression as layout 30, so on this three-family fixture the
      // two layouts land within a couple of bytes of each other (and the plain
      // v13 kernel is smallest of all). What must still hold is that both layouts
      // are priced distinctly, that the planner reaches the comparison at all, and
      // that the adopted payload is never worse than the best candidate layout.
      const legacy = encodeTerrainGroup([data], { id: ID.TRANSPOSE, s: 4, r: 1 }, undefined, undefined, undefined, [0], 'v20')
      const v3 = encodeTerrainGroup([data], { id: ID.TRANSPOSE_GROUP_V3, s: 4, r: 1 }, undefined, undefined, undefined, [0], 'v20')
      const legacyOff = encodeTerrainGroup([data], { id: ID.TRANSPOSE, s: 4, r: 1 }, undefined, undefined, undefined, [0], false)
      const v3Off = encodeTerrainGroup([data], { id: ID.TRANSPOSE_GROUP_V3, s: 4, r: 1 }, undefined, undefined, undefined, [0], false)
      assert.notEqual(legacy.length, v3.length, 'fixture must price layouts 9 and 30 distinctly')
      // Suppression + v20 on the inner columns is a real model change for both layouts.
      assert.notEqual(legacy.length, legacyOff.length, 'id 9: v20 + suppression must differ from the v13 kernel')
      assert.notEqual(v3.length, v3Off.length, 'id 30: v20 + suppression must differ from the v13 kernel')
      const adaptive = await compressAdaptive(data, undefined, { serial: true })
      eq(decompress(adaptive.container), data)
      const adopted = adaptive.segs.map(s => s.spec.id)
      assert.ok(adopted.some(id => id === ID.TRANSPOSE || id === ID.TRANSPOSE_GROUP || id === ID.TRANSPOSE_GROUP_V3),
        `id 9 group must reach the transpose layout comparison, got ids ${adopted}`)
      assert.equal(adaptive.segs.length, 1)
      // P17.6: id 9 itself must now produce real kernel candidates (it was absent
      // from V15_PROFILES before, so the whole comparison was dead code for it).
      const cand = groupV15CandidatesSync([data], { id: ID.TRANSPOSE, s: 4, r: 1 }, [0])
      assert.ok(cand && (cand.alt || cand.v20), 'id 9 must produce v15/v20 kernel candidates')
      assert.ok(adaptive.container.length < data.length)
    }
    checks++

    const tinyAdaptive = await compressAdaptive(tiny, undefined, { serial: true })
    check(tinyAdaptive, tiny)
    assert.equal(tinyAdaptive.container[3] === 18 ? tinyAdaptive.container[4] & 6 : 0, 0)
    checks++

    console.log(`P10 tests passed (${checks} checks; <=48 KiB inputs, virtual boundaries, actual scoped allocation, pure kernels, real worker batching/fallback)`)
    return { checks, maxActualInputBytes: e24.n, boundaries,
      saoPolicyOnly: { rawGroupBytes: saoBytes, columnBytes: oneColumn, v17: saoV17, v18: saoV18 },
      tinyRawModelAllocation: allocation, tg: { inputBytes: grid.length, finalModels: finalKernels.length, probeModels: sampleSizes.length },
      guardedFixture: { inputBytes: data.length, containerBytes: warm.container.length,
        sha256: sha(warm.container), orphan: warm.orphanComparison, macro: warm.macroComparison,
        cold: cold.guardStats, warm: warm.guardStats, batches },
      directFixture: directWarm.guardStats, collapseFixture: collapsed.guardStats, fallback: failed.guardStats,
      note: 'Correctness/scheduling evidence only. Virtual group sizes and synthetic worker weights are not large-input compression measurements.' }
  } finally {
    setAttribHook(saved.hook); Object.assign(modelTuning, saved.model); Object.assign(a2Tuning, saved.a2)
    Object.assign(parallelReport, saved.parallel)
    if (saved.threads === undefined) delete process.env.UCZ_THREADS; else process.env.UCZ_THREADS = saved.threads
    await closePool()
  }
}
