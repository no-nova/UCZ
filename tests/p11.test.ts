import assert from 'node:assert/strict'
import { fastDeepEqual } from './fast-equal'
import { createHash } from 'node:crypto'
import {
  modelTuning, cmTableShape, withCMBlockSize, withCMProbe, withContainerModel,
  encodeCM, decodeCM, setAttribHook, attribHook, V19_FLAG_TABLE_24, V19_FLAG_MATCH_23, V19_FLAG_MHT4_20,
} from '../src/lib/coder'
import {
  ID, chooseSpecSync, compressGuardedPlanForProbe, decompress, orphanProposalForProbe,
  planTuning, parallelReport, selectionHeaderBytes, type PlanSegment, type GroupJobRunner,
} from '../src/lib/codec'
import { payloadModelFlags } from '../src/lib/payload-model'
import { runParallelJobs, closePool } from '../src/lib/parallel-pool'
import { encodeGroupForJob } from '../src/lib/codec-jobs'

const eq = (a: Uint8Array, b: Uint8Array) => fastDeepEqual(Buffer.from(a), Buffer.from(b))
const sha = (x: Uint8Array) => createHash('sha256').update(x).digest('hex')
const MiB = 1024 * 1024
const part = (start: number, end: number, id: number, s = 1): PlanSegment =>
  ({ start, end, cls: 'binary', spec: { id, s, r: 1 } })
function noise(n: number) {
  let seed = 0x12345678
  return Uint8Array.from({ length: n }, () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed & 255 })
}

/** Actual inputs <=32 KiB. All large group/input lengths below are virtual
 * policy scalars, except the one explicitly documented 128-byte raw-CM test. */
export async function testP11() {
  const saved = { hook: attribHook, model: { ...modelTuning }, threads: process.env.UCZ_THREADS, parallel: { ...parallelReport } }
  let checks = 0
  try {
    fastDeepEqual(modelTuning, { maxTableBits: 24, matchTableBits: 23, largeOnly: true })
    assert.equal(planTuning.orphanMaxCount, 64)
    const lengths = [512 * 1024 - 1, 512 * 1024, 4 * MiB - 1, 4 * MiB, 8 * MiB - 1, 8 * MiB]
    const shapes = lengths.map(n => cmTableShape(n))
    fastDeepEqual(shapes.map(s => [s.cmBits, s.mht4Bits, s.mht8Bits]),
      [[21,20,20],[22,20,21],[22,20,21],[23,20,22],[23,20,22],[24,20,23]])
    assert.equal(withCMBlockSize(8 * MiB - 1, () => cmTableShape(16 * MiB)).cmBits, 23)
    assert.equal(withCMBlockSize(8 * MiB, () => cmTableShape(0)).cmBits, 10)
    assert.equal(withContainerModel(18, 20, () => withCMBlockSize(16 * MiB, () => cmTableShape(128))).mht4Bits, 20)
    assert.equal(withContainerModel(18, 20, () => cmTableShape(16 * MiB)).cmBits, 23)
    const sao = withCMBlockSize(7251944, () => cmTableShape(258998))
    fastDeepEqual([sao.cmBits, sao.mht4Bits, sao.mht8Bits], [23,20,22])
    checks++

    // Probe caps override inherited group size, actual probe length and all
    // encoding caps. Geometry-only checks do not allocate these virtual inputs.
    const probeShapes = lengths.map(n => withCMBlockSize(16 * MiB, () => withCMProbe(() => cmTableShape(n))))
    for (const s of probeShapes) {
      assert.ok(s.cmBits <= 21); assert.ok(s.mht4Bits <= 20); assert.ok(s.mht8Bits <= 20)
    }
    let models = 0
    setAttribHook((m, i) => { if (!i) {
      models++; assert.ok(m.geometry.cmBits <= 21); assert.ok(m.geometry.mht4Bits <= 20)
      assert.ok(m.geometry.sizingBytes <= 4096)
    } })
    withCMBlockSize(16 * MiB, () => chooseSpecSync(noise(4096), 'binary', 1, 4096, 0, 16 * MiB))
    setAttribHook(saved.hook)
    assert.ok(models > 0)
    assert.throws(() => withCMProbe(() => { throw Error('restore probe') }), /restore probe/)
    assert.equal(withCMBlockSize(8 * MiB, () => cmTableShape(128)).cmBits, 24)
    checks++

    // Real 24/20/23 allocations on a 128-byte raw-CM stream. This is NOT a
    // fabricated 8 MiB UCZ container and NOT a throughput/ratio benchmark.
    const tiny = noise(128)
    let allocation: number[] = []
    setAttribHook((m, i) => { if (!i) {
      const v = m as typeof m & { mht: Int32Array; mht8: Int32Array }
      allocation = [m.tables[0].length, v.mht.length, v.mht8.length]
      assert.equal(m.geometry.sizingBytes, 8 * MiB); assert.equal(m.geometry.inputBytes, 128)
      setAttribHook(saved.hook)
    } })
    const raw = withCMBlockSize(8 * MiB, () => encodeCM(tiny, 'bin', 1, 1, undefined, 0, undefined, undefined, 'v15'))
    const rawFlags = payloadModelFlags(raw)
    fastDeepEqual(allocation, [2 ** 24, 2 ** 20, 2 ** 23])
    assert.equal(rawFlags, V19_FLAG_TABLE_24 | V19_FLAG_MATCH_23 | V19_FLAG_MHT4_20)
    Object.assign(modelTuning, { maxTableBits: 21, matchTableBits: 20 })
    eq(withContainerModel(19, rawFlags, () => withCMBlockSize(8 * MiB,
      () => decodeCM(raw, tiny.length, 'bin', 1, 1, undefined, 'v15'))), tiny)
    Object.assign(modelTuning, saved.model)
    checks++

    // High uint16 bits, truncation and unknown bits are independently parsed.
    // Handcrafted STORE frame deliberately exercises header parsing without a
    // large model. It is not evidence of encoder-selected table flags.
    const headerOnlyFixture = Uint8Array.of(85,67,90,19,0x10,0x03, 1,1,1, 0,1,1,1, 1, 77)
    eq(decompress(headerOnlyFixture), Uint8Array.of(77))
    assert.throws(() => decompress(Uint8Array.of(85,67,90,19,0)), /截断/)
    for (const flags of [0x400, 0x8000, 0x180]) assert.throws(() => withContainerModel(19, flags, () => {}), /v19/)
    assert.throws(() => withContainerModel(18, 0x100, () => {}), /v18/)
    const bin = { id: ID.BIN_V3, s: 1, r: 1 }
    assert.equal(selectionHeaderBytes(bin, 100, 10, 0x310), selectionHeaderBytes(bin, 100, 10) + 2)
    checks++

    // Limit is distinct rule GROUPS, not segment count. 29 STORE segments are
    // one group; raising 24->64 is not proof those 29 segments were truncated.
    const many = [part(0,9000,ID.BIN_V3), ...Array.from({length:70},(_,i)=>part(9000+i*10,9010+i*10,ID.DELTA,i+1))]
    const proposal = orphanProposalForProbe(9700, many)!
    assert.equal(proposal.groups, 24); assert.equal(proposal.members.length, 25)
    const largeMany = [part(0,8*MiB,ID.BIN_V3), ...Array.from({length:70},(_,i)=>part(8*MiB+i*10,8*MiB+10+i*10,ID.DELTA,i+1))]
    assert.equal(orphanProposalForProbe(8*MiB+700, largeMany)!.groups, 64)
    const stores = [part(0,16*MiB,ID.BIN_V3), ...Array.from({length:29},(_,i)=>part(16*MiB+i*65536,16*MiB+(i+1)*65536,ID.STORE))]
    const storeProposal = orphanProposalForProbe(16*MiB+29*65536, stores)!
    assert.equal(storeProposal.groups, 1); assert.equal(storeProposal.members.length, 30)
    checks++

    // A real, rejected full family proposal. The orphan then rejects its
    // header-only saving; macro accepts that SAME full plan by exactly one byte.
    // This covers cross-phase reuse AND the original strict payload/container
    // distinction, rather than merely asserting that some cache counter grew.
    const data = noise(32768); data.fill(0, 28672)
    const picks = [part(0,28672,ID.BIN_V3), part(28672,32768,ID.BIN_V2)]
    const before = JSON.stringify(picks)
    let fullBaseEncodes = 0
    setAttribHook((m, i) => { if (!i && !m.isV15 && m.geometry.inputBytes === data.length) fullBaseEncodes++ })
    const cold = await compressGuardedPlanForProbe(data, picks, { serial:true, reuseGuardBases:false })
    const coldBases = fullBaseEncodes; fullBaseEncodes = 0
    const warm = await compressGuardedPlanForProbe(data, picks, { serial:true })
    const warmBases = fullBaseEncodes; setAttribHook(saved.hook)
    assert.equal(warm.guardStats!.rejectedFamilyTrials, 1)
    assert.equal(warm.guardStats!.reusedTrialBases, 1)
    assert.equal(coldBases - warmBases, 1, 'exactly one full base pass removed')
    assert.equal(warm.orphanComparison!.accepted, false)
    assert.equal(warm.macroComparison!.accepted, true)
    // P17.7: the container also coalesces contiguous identical-spec seams, so the
    // macro payoff is now the one-byte plan win plus that header saving (>= 1 B).
    assert.ok(warm.macroComparison!.baselineBytes - warm.container.length >= 1,
      'macro must still be accepted by a real byte win')
    eq(cold.container, warm.container); eq(decompress(warm.container), data)
    fastDeepEqual(warm.blockCost, cold.blockCost)
    assert.equal(JSON.stringify(picks), before)
    checks++

    process.env.UCZ_THREADS = '2'
    const batches: { jobs:number; candidateOnly:number; inputBytes:number }[] = []
    const runner: GroupJobRunner = async (jobs, loads, input) => {
      assert.ok(input.length <= 32768)
      const replies = await runParallelJobs(jobs, loads.map(n=>Math.max(n,512*1024)), input)
      if (replies) jobs.forEach((j,i)=>{ if(j.kind==='encodeGroup' && j.skipBase) {
        const r=replies[i]; assert.equal(r.kind,'encodeGroup')
        if(r.kind==='encodeGroup'){assert.equal(r.bytes.length,0);assert.equal(r.cost.length,0)}
      } })
      batches.push({jobs:jobs.length,candidateOnly:jobs.filter(j=>j.kind==='encodeGroup'&&j.skipBase).length,inputBytes:input.length})
      return replies
    }
    const parallel = await compressGuardedPlanForProbe(data,picks,{runJobs:runner})
    eq(parallel.container,cold.container); fastDeepEqual(parallel.blockCost,cold.blockCost)
    // This plan has exactly TWO non-FILL segments but ONE merged group boundary is
    // not created: BIN_V3(28672) + BIN_V2(4096) stay two segments in ONE group, so
    // `groupJobs` emits exactly one job. `worthParallelizing` additionally requires
    // `jobCount >= 2`, so the runner is invoked (with the one candidate-only job)
    // but the pool legitimately declines and returns null.
    //
    // The old assertion demanded >= 2 candidate-only jobs, which this fixture can
    // never produce — it failed at 1d25fec as well, before any P16.2 change. What
    // this fixture CAN prove is the property the test exists for: the batch that is
    // offered carries the candidate-only marker, so a real pool would reuse the
    // already-computed base instead of re-encoding it.
    assert.equal(batches.length, 1, 'exactly one pool invocation')
    assert.equal(batches[0].jobs, 1)
    assert.equal(batches[0].candidateOnly, 1, 'the offered job is candidate-only')
    assert.ok(batches[0].inputBytes <= 32768)
    eq(decompress(parallel.container),data)
    const fullJob=encodeGroupForJob([tiny],bin,[0],[tiny.length])
    const partialJob=encodeGroupForJob([tiny],bin,[0],[tiny.length],true)
    assert.equal(partialJob.bytes.length,0);assert.equal(partialJob.cost.length,0)
    fastDeepEqual(partialJob.cand,fullJob.cand)
    checks++

    const failed = await compressGuardedPlanForProbe(data,picks,{runJobs:async()=>{throw Error('P11 injected failure')}})
    eq(failed.container,cold.container);fastDeepEqual(failed.blockCost,cold.blockCost)
    assert.ok(failed.guardStats!.workerFallbacks>0)
    Object.assign(parallelReport,saved.parallel)
    checks++

    // Counterexample to unconditional intermediate elimination: direct macro is
    // mandatory and unchanged by orphan acceptance, yet orphan wins by 3786 B.
    const trap = noise(32768)
    for(let i=20000;i<28192;i++){const x=(i-20000)>>1;trap[i]=(i&1)?x>>8:x&255}
    trap.fill(0,28192,30240)
    const trapPicks=[part(0,20000,ID.BIN_V3),part(20000,28192,ID.DELTA,2),part(28192,30240,ID.STORE),part(30240,31264,ID.RLE),part(31264,32768,ID.O0)]
    const retained=await compressGuardedPlanForProbe(trap,trapPicks,{serial:true})
    const retainedParallel=await compressGuardedPlanForProbe(trap,trapPicks,{runJobs:runner})
    assert.equal(retained.orphanComparison!.accepted,true);assert.equal(retained.macroComparison!.accepted,false)
    assert.equal(retained.macroComparison!.baselineBytes,retained.orphanComparison!.candidateBytes)
    assert.ok(retained.macroComparison!.candidateBytes!>retained.container.length)
    eq(retained.container,retainedParallel.container);eq(decompress(retained.container),trap)
    assert.equal(retained.guardStats!.orphanTrials,1)
    checks++

    console.log(`P11 tests passed (${checks} checks; <=32 KiB inputs; real 24-bit allocation; exact rejected-base reuse and worker candidates)`)
    return {checks,maxActualInputBytes:32768,shapes,probeShapes,probeModels:models,saoPolicyOnly:sao,
      rawModelAllocation:{inputBytes:128,virtualGroupBytes:8*MiB,dimensions:allocation,flags:rawFlags},
      groupLimit:{distinctGroups:proposal.groups,storeSegments:29,storeGroups:storeProposal.groups},
      rejectedFamily:{inputBytes:data.length,containerBytes:warm.container.length,sha256:sha(warm.container),
        coldBaseCalls:coldBases,warmBaseCalls:warmBases,cold:cold.guardStats,warm:warm.guardStats,parallel:parallel.guardStats,
        orphan:warm.orphanComparison,macro:warm.macroComparison},batches,
      orphanWinner:{inputBytes:trap.length,containerBytes:retained.container.length,orphan:retained.orphanComparison,macro:retained.macroComparison},
      note:'Correctness evidence only; virtual policy lengths and artificial worker weights are not large-input compression measurements.'}
  } finally {
    setAttribHook(saved.hook);Object.assign(modelTuning,saved.model);Object.assign(parallelReport,saved.parallel)
    if(saved.threads===undefined)delete process.env.UCZ_THREADS;else process.env.UCZ_THREADS=saved.threads
    await closePool()
  }
}
