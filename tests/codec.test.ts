import { testP131Gate, testP131Worker } from './p131.test'
import { availableParallelism } from 'node:os'
import { fastDeepEqual } from './fast-equal'
import { testBcjSeams, testBcjTargetFirst, testBcjTargetLast, testBcjLargeWorker, testBcjUpgrade, testBcjCacheWorker, testFamilyReuse, testPolicy, testScreen, testWorkerScreen } from './p13.test'
import { testP122CachedCollision, testP122Reservations, testP122Collision, testP122WorkerPlan, testP122Worker, testP122Kernel, testP122Mixed, testP121Worker, testP121Transforms, testP120Units, testP12HistoricalDecode, testP120Family, testP12Worker } from './p12.test'
import { strict as assert } from 'node:assert'
import { testP9Format } from './p9-format.test'
import { testP9Macro } from './p9-macro.test'
import { testP9Defaults } from './p9-defaults.test'
import { testP10 } from './p10.test'
import { testP11 } from './p11.test'
import { testP111 } from './p111.test'
import { testP176Transpose, testP176Container, testP176WordToken3, testP176WordPreToken3 } from './p176.test'
import { testP177TransposeFlags, testP177Coalesce, testP177LineCol, testP177Pockets } from './p177.test'
import { testP178TextContexts, testP178Pockets, testP178BcjCoalesce } from './p178.test'
import { testP179TextContexts, testP179GroupCodecs } from './p179.test'
import { testP180Sym2bit, testP180Sym5bit, testP180Planner } from './p180.test'
import { testP243VerticalColumns, testP244SyncHighEntropy } from './p24.test'
import { memorySafeThreads } from '../src/lib/parallel'
import { testManifoldUniversality } from './manifold.test'
import { testDefaultProfileSurvivesPermutation, testStrictProfileInvariance } from './invariance.test'
import { testConcurrencyAndChecksum } from './concurrency.test'
import { testScientificInstruments } from './scientific.test'
import { testEdgeCases } from './edge.test'
import { MAX_INPUT_BYTES, MAX_SINGLE_CM_BYTES, MAX_OUTPUT_BYTES, shouldRunSingleCM } from '../src/lib/limits'
import v12Fixtures from './v12-fixtures.json'
import { compressAdaptive, decompress, evaluatePlan, decodeSpec, encodeSpec, encodeTerrainGroup, decodeTerrainGroup, singleModelSize, sampleWindow, sampleWindows, candidatesFor, inspectPeel, groupV15CandidatesSync, planTuning, ID } from '../src/lib/codec'
import { analyze, detectAnchors, detectLag, detectLagCandidates, detectWide16Lag, detectRecordStride, mergeShortRuns, refineFillSeams, cleanTinySeams, type Cls } from '../src/lib/analyze'
import { encodeCM, decodeCM, encodeMatchExperiment, decodeMatchExperiment, type Profile } from '../src/lib/coder'
import { encodeTranspose2d, decodeTranspose2d } from '../src/lib/transpose2d'
import { fitMicroSeed, microFwd, microInv } from '../src/lib/micro'
import { encodePeeledTranspose, decodePeeledTranspose, inspectPeeledTranspose, encodePeeledAnchor, decodePeeledAnchor, inspectPeeledAnchor } from '../src/lib/sub-peel'
import { encodeAnchor, decodeAnchor, anchorRowCount, MAX_ANCHOR_ROWS } from '../src/lib/anchor'
import { deltaFwd, medFwd, d16Fwd, bcjFwd, bcjInv, anchorFoldFwd, anchorFoldInv } from '../src/lib/transforms'
import { SAMPLES } from '../src/lib/samples'
import { buildMapModel, drawDigram } from '../src/lib/viz'
import { CM_FAMILIES, CM_ENCODING, isFamilyCM } from '../src/lib/unify'
import { lptAssign, threadCount } from '../src/lib/parallel'
import { encodeCMDual, decodeCM as decodeCMapm, apm2Tuning, a2Tuning } from '../src/lib/coder'
import { wordPreFwd, wordPreInv, buildTokenDict } from '../src/lib/wordpre'
import { lzPreFwd, lzPreInv } from '../src/lib/lzpre'

/** Historical selector fixtures intentionally require MICRO/ANCHOR/PEEL/etc.
 * They exercise retained algorithms, not the new default candidate pool. Only
 * those fixtures opt into the old selector; general roundtrips, new policy tests
 * and both serial/parallel integration tests continue to use the new defaults. */
async function legacySelection<T>(run: () => T | Promise<T>): Promise<T> {
  const saved = { ...planTuning }
  Object.assign(planTuning, {
    dropZeroHitIds: false, realHeaderCosts: false, v15SinglePlain: false,
    macroUniformGate: false, orphanConsolidation: false, sampleFloor: 4096, soloSampleCap: 0,
  })
  try { return await run() } finally { Object.assign(planTuning, saved) }
}

async function test() {
  testP131Gate(); await testP131Worker();
  await testBcjSeams(); await testBcjTargetFirst(); await testBcjTargetLast();
  testPolicy(); testScreen(); await testWorkerScreen();
  await testBcjUpgrade(); await testBcjCacheWorker(); await testFamilyReuse(); await testBcjLargeWorker();
  await testP122CachedCollision(); await testP122Reservations(); await testP122Collision(); await testP122WorkerPlan(); await testP122Worker(); await testP122Kernel(); await testP122Mixed();
  await testP121Transforms(); await testP121Worker();
  testP120Units(); testP12HistoricalDecode(); await testP120Family(); await testP12Worker()
  await testP9Format()
  await testP9Macro()
  await testP9Defaults()
  await testP10()
  await testP11()
  await testP111()
  testP176Transpose(); await testP176Container(); testP176WordToken3(); testP176WordPreToken3()
  testP177TransposeFlags(); await testP177Coalesce(); testP177LineCol(); await testP177Pockets()
  testP178TextContexts(); await testP178Pockets(); await testP178BcjCoalesce()
  testP179TextContexts(); await testP179GroupCodecs()
testP180Sym2bit(); testP180Sym5bit(); await testP180Planner()
testP243VerticalColumns(); testP244SyncHighEntropy()
  let seed = 123456789
  const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
  // Isolated v13-based match experiment: all three modes must be symmetric;
  // baseline instrumentation must not change a single bit of the old stream.
  {
    let state=0x12345678
    const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0}
    let words=''
    for(let i=0;i<400;i++) words+=`unique-${i%23}-abcdefghij${i%3===0?'ONE':'TWO'}-end; `
    const inputs=[new Uint8Array(),Uint8Array.of(0),Uint8Array.from({length:4097},()=>random()&255),new TextEncoder().encode(words)]
    let observedOlderWins=false
    for(const profile of ['text','bin'] as const) for(const data of inputs) {
      const base=encodeCM(data,profile,1,1,undefined,0,undefined,undefined,'v13')
      for(const mode of ['single','dual','dual-distance'] as const) {
        const costs=new Float32Array(data.length), bins=new Float32Array(Math.ceil(data.length/512))
        const result=encodeMatchExperiment(data,profile,mode,costs,{values:bins,blockSize:512})
        fastDeepEqual(decodeMatchExperiment(result.payload,data.length,profile,mode),data)
        fastDeepEqual(encodeMatchExperiment(data,profile,mode).payload,result.payload)
        if(mode==='single') fastDeepEqual(result.payload,base)
        if(mode==='dual' && result.stats.olderWins>0) observedOlderWins=true
        assert.ok(result.stats.correctBits<=result.stats.predictedBits)
        assert.equal(result.stats.distanceStarts.reduce((a,b)=>a+b,0),result.stats.matchesStarted)
        for(let k=0;k<bins.length;k++) {
          const sum=costs.subarray(k*512,Math.min(data.length,(k+1)*512)).reduce((a,b)=>a+b,0)
          assert.ok(Math.abs(sum-bins[k])<Math.max(0.1,sum*0.00001))
        }
      }
    }
    assert.ok(observedOlderWins,'dual-candidate fixture must exercise older candidate')
    // Each distance bucket is exercised, including overlapping near matches.
    const distances=Uint8Array.from({length:82000},()=>random()&255)
    for(const [start,distance] of [[0,16],[200,64],[1000,512],[3000,8192],[15000,66000]])
      distances.set(distances.slice(start,start+12),start+distance)
    for(const mode of ['single','dual','dual-distance'] as const) {
      const coded=encodeMatchExperiment(distances,'bin',mode)
      assert.ok(coded.stats.distanceStarts.every(n=>n>0),JSON.stringify(coded.stats.distanceStarts))
      fastDeepEqual(decodeMatchExperiment(coded.payload,distances.length,'bin',mode),distances)
    }
    assert.throws(()=>encodeMatchExperiment(Uint8Array.of(1),'bin','dual',new Float32Array(0)))
  }
  // Frozen payloads generated by the previous v12 implementation.
  const oldBytes=Uint8Array.from({length:100},(_,i)=>(i*37+4)&255)
  for(const fixture of v12Fixtures) {
    fastDeepEqual(decodeSpec(Uint8Array.from(fixture.p),oldBytes.length,fixture.sp),oldBytes)
    const z=Uint8Array.from([85,67,90,12,100,1,1,fixture.sp.id,fixture.sp.s,fixture.sp.r,fixture.p.length,100,...fixture.p])
    fastDeepEqual(decompress(z),oldBytes)
  }
  assert.equal(MAX_INPUT_BYTES,256*1024*1024)
  assert.equal(MAX_SINGLE_CM_BYTES,10*1024*1024)
  assert.ok([21.6,33.6,41.5,51.2,64,128,256].every(mb=>mb*1024*1024<=MAX_INPUT_BYTES))
  assert.ok(!shouldRunSingleCM(MAX_SINGLE_CM_BYTES+1))
  assert.ok(shouldRunSingleCM(MAX_SINGLE_CM_BYTES))
  assert.ok(!shouldRunSingleCM(1,true))
  // Wide 16-bit rows, including the non-power-of-two 4144-byte case.
  for(const width of [3800,4144,8190,8192]) {
    let state=98765
    const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0}
    const base=Uint16Array.from({length:width/2},()=>random()%8192)
    const data=new Uint8Array(width*80)
    for(let row=0;row<80;row++) for(let col=0;col<width/2;col++) {
      const value=(base[col]+row%7)&65535, pos=row*width+col*2
      data[pos]=value&255;data[pos+1]=value>>>8
    }
    assert.equal(detectWide16Lag(data),width)
    const keepPruning = planTuning.dropZeroHitIds
    planTuning.dropZeroHitIds = false
    try { assert.ok(candidatesFor(data,'repeat',8,data.subarray(0,16000)).some(sp=>sp.id===ID.WIDE_GRAD && sp.s===2 && sp.r===width)) }
    finally { planTuning.dropZeroHitIds = keepPruning }
    if(width===4144) {
      const result=await compressAdaptive(data)
      fastDeepEqual(decompress(result.container),data)
      assert.equal(result.segs.length,1)
      assert.ok(result.container.length < 8000)
      assert.equal(result.overhead+result.segs.reduce((sum,sg)=>sum+sg.compLen,0),result.container.length)
      const cost=result.analysis.blocks.reduce((sum,b,i)=>sum+result.blockCost[i]*(b.end-b.start),0)
      assert.ok(Math.abs(cost-(result.container.length-result.overhead)*8)<0.5)
    }
    const view=data.subarray(0,Math.min(data.length,65536))
    for(const kind of [1,2]) {
      const spec={id:ID.WIDE_GRAD,s:kind,r:width}
      const coded=encodeSpec(view,spec)
      fastDeepEqual(decodeSpec(coded,view.length,spec),view)
      fastDeepEqual(decodeTerrainGroup(encodeTerrainGroup([view.subarray(0,501),view.subarray(501)],spec),[501,view.length-501],spec),[view.subarray(0,501),view.subarray(501)])
    }
  }
  assert.equal(detectWide16Lag(new Uint8Array(400000)),0)
  assert.throws(()=>encodeSpec(new Uint8Array(8),{id:ID.WIDE_GRAD,s:2,r:8194}))
  assert.throws(()=>decodeSpec(new Uint8Array(),8,{id:ID.WIDE_GRAD,s:1,r:255}))
  const wc={id:ID.WIDE_GRAD,s:2,r:4144}, wd=Uint8Array.of(10,20,30), wp=encodeSpec(wd,wc)
  const v14=Uint8Array.from([85,67,90,14,3,1,1,31,2,0xb0,0x20,wp.length,3,...wp])
  fastDeepEqual(decompress(v14),wd)
  const v13=v14.slice();v13[3]=13;assert.throws(()=>decompress(v13))
  // MICRO seeds are per-region, while the residual coder is shared.
  for(const sp of [{id:ID.TEXT_V2,s:1,r:1},{id:ID.BIN_V2,s:1,r:1},{id:ID.BCJ_V2,s:1,r:1},{id:ID.GRAD_V2,s:3,r:24}]) {
    const parts=[Uint8Array.from({length:2001},()=>rand()&255),Uint8Array.from({length:1234},()=>rand()&255)]
    const positions=[30,5000], packed=encodeTerrainGroup(parts,sp,undefined,undefined,undefined,positions)
    fastDeepEqual(decodeTerrainGroup(packed,parts.map(p=>p.length),sp,undefined,positions),parts)
    fastDeepEqual(decodeSpec(encodeSpec(parts[0],sp,undefined,0,30),parts[0].length,sp,30),parts[0])
  }
  for (const id of [ID.TEXT_V2,ID.BIN_V2,ID.BCJ_V2,ID.GRAD_V2,ID.TRANSPOSE_2D]) {
    const sp={id,s:id===ID.TRANSPOSE_2D?2:1,r:1}, d=Uint8Array.of(84), packed=encodeSpec(d,sp)
    const v12=Uint8Array.from([85,67,90,12,1,1,1,id,sp.s,1,packed.length,1,...packed])
    fastDeepEqual(decompress(v12),d)
    const v11=v12.slice();v11[3]=11;assert.throws(()=>decompress(v11))
  }
  seed=123456789
  for(const width of [2,4,20,28,64]) {
    const parts=[Uint8Array.from({length:width*300+3},(_,i)=>i%width<width/2?rand()&255:(Math.floor(i/width)%16)),Uint8Array.from({length:width*257+1},()=>rand()&255),new Uint8Array(0)]
    const encoded=encodeTranspose2d(parts,width)
    fastDeepEqual(decodeTranspose2d(encoded,parts.map(p=>p.length),width),parts)
    assert.throws(()=>decodeTranspose2d(encoded.subarray(0,encoded.length-1),parts.map(p=>p.length),width))
    const spec={id:ID.TRANSPOSE_2D,s:width,r:1}, wrapped=encodeTerrainGroup(parts,spec)
    fastDeepEqual(decodeTerrainGroup(wrapped,parts.map(p=>p.length),spec),parts)
    assert.ok(wrapped.length<=encodeTerrainGroup(parts,{id:ID.TRANSPOSE_GROUP,s:width,r:1}).length+1)
  }
  let geoSeed=123456
  const geoRand=()=>{geoSeed^=geoSeed<<13;geoSeed^=geoSeed>>>17;geoSeed^=geoSeed<<5;return geoSeed>>>0}
  const correlated=new Uint8Array(28*3000)
  for(let i=0;i<correlated.length;i+=28) correlated.fill(geoRand()%16,i,i+28)
  const geoSpec={id:ID.TRANSPOSE_2D,s:28,r:1}, geoPacked=encodeTerrainGroup([correlated],geoSpec)
  assert.equal(geoPacked[0],1)
  assert.ok(geoPacked.length < encodeTerrainGroup([correlated],{id:ID.TRANSPOSE_GROUP,s:28,r:1}).length)
  fastDeepEqual(decodeTerrainGroup(geoPacked,[correlated.length],geoSpec)[0],correlated)
  {
    const original={id:ID.TRANSPOSE_GROUP,s:28,r:1}
    const old=encodeTerrainGroup([correlated],original)
    const enhanced=encodeTerrainGroup([correlated],{id:ID.TRANSPOSE_GROUP_V3,s:28,r:1})
    const candidate=encodeTerrainGroup([correlated],geoSpec)
    const legacySize=candidate[0]===0?candidate.length-1:Infinity
    const chosen=enhanced.length<Math.min(candidate.length,legacySize)?{id:ID.TRANSPOSE_GROUP_V3,payload:enhanced}:candidate[0]===1?{id:ID.TRANSPOSE_2D,payload:candidate}:{id:ID.TRANSPOSE_GROUP,payload:old}
    const put=(v:number)=>{const a:number[]=[];while(v>=128){a.push((v%128)|128);v=Math.floor(v/128)}a.push(v);return a}
    const header=[85,67,90,chosen.id===ID.TRANSPOSE_GROUP_V3||chosen.id===ID.TRANSPOSE_2D? (chosen.id===ID.TRANSPOSE_GROUP_V3?13:12):7,...put(correlated.length),1,1,chosen.id,28,1,...put(chosen.payload.length),...put(correlated.length)]
    const encoded=Uint8Array.from([...header,...chosen.payload])
    const cost=evaluatePlan(correlated,[{start:0,end:correlated.length,cls:'binary',spec:original}])
    assert.equal(cost.totalBytes,encoded.length);assert.equal(cost.headerBytes,header.length)
    fastDeepEqual(decompress(encoded),correlated)
    assert.notEqual(chosen.id,ID.TRANSPOSE_GROUP, 'fixture must auto-upgrade')
    const tail=correlated.subarray(0,57), duplicateSpec={id:chosen.id,s:28,r:1}
    const tailPayload=encodeTerrainGroup([tail],duplicateSpec)
    const duplicateHeader=[85,67,90,chosen.id===ID.TRANSPOSE_GROUP_V3?13:12,...put(correlated.length+tail.length),2,2,chosen.id,28,1,...put(chosen.payload.length),chosen.id,28,1,...put(tailPayload.length),...put(correlated.length),...put(tail.length),1]
    const duplicateContainer=Uint8Array.from([...duplicateHeader,...chosen.payload,...tailPayload])
    assert.throws(()=>decompress(duplicateContainer),/无效的规则字典/)
    const duplicateData=new Uint8Array(correlated.length+tail.length);duplicateData.set(correlated);duplicateData.set(tail,correlated.length)
    // The malformed wire dictionary above must still be rejected. This input
    // plan, however, starts with distinct keys: suppress a conflicting late
    // promotion rather than turning a valid encoder request into an exception.
    const collisionCost=evaluatePlan(duplicateData,[{start:0,end:correlated.length,cls:'binary',spec:original},{start:correlated.length,end:duplicateData.length,cls:'binary',spec:duplicateSpec}])
    assert.equal(collisionCost.groupCount,2);assert.ok(collisionCost.totalBytes>0)
  }
  seed=123456789
  for(const sp of [{id:ID.TEXT_V3,s:1,r:1},{id:ID.BIN_V3,s:1,r:1},{id:ID.BCJ_V3,s:1,r:1},{id:ID.GRAD_V3,s:2,r:28},{id:ID.DELTA_V3,s:2,r:1},{id:ID.SUB_TRANSPOSE_V3,s:4,r:2},{id:ID.SUB_ANCHOR_V3,s:10,r:8},{id:ID.TRANSPOSE_GROUP_V3,s:7,r:1}]) {
    const parts=[Uint8Array.from({length:777},(_,i)=>i%17===0?10:rand()&255),Uint8Array.from({length:991},(_,i)=>i%19===0?10:rand()&255)]
    const payload=encodeTerrainGroup(parts,sp,undefined,undefined,undefined,[20,1000])
    fastDeepEqual(decodeTerrainGroup(payload,parts.map(p=>p.length),sp,undefined,[20,1000]),parts)
    fastDeepEqual(decodeSpec(encodeSpec(parts[0],sp,undefined,0,20),parts[0].length,sp,20),parts[0])
    const data=Uint8Array.of(42), one=encodeSpec(data,sp)
    const z=Uint8Array.from([85,67,90,13,1,1,1,sp.id,sp.s,sp.r,one.length,1,...one])
    fastDeepEqual(decompress(z),data)
    const bad=z.slice();bad[3]=12;assert.throws(()=>decompress(bad))
  }
  for(const profile of ['text','bin','res','res2d'] as Profile[]) for(const stride of [0,4,28]) {
    const input=Uint8Array.from({length:2049},()=>rand()&255)
    const coded=encodeCM(input,profile,2,28,undefined,0,undefined,undefined,'v13',stride)
    fastDeepEqual(decodeCM(coded,input.length,profile,2,28,undefined,'v13',stride),input)
  }
  seed=123456789
  const alignedText=new TextEncoder().encode(('abcdefghij0123456789<>; XYZ 1234'.repeat(2)).repeat(32))
  const textAnalysis=analyze(alignedText)
  assert.ok(textAnalysis.blocks.every(b=>b.cls==='text'))
  // Reversed complete row slices and unreversed short tails across seams.
  const reversedParts=[Uint8Array.of(1,2,3,4,5,6),Uint8Array.of(7,8,9,10,11)]
  const reversed=Uint8Array.of(4,3,2,1,5,6,10,9,8,7,11)
  const makeGroup=(mode:number,bytes:Uint8Array)=>Uint8Array.from([4,mode|128,bytes.length,...bytes])
  const revSpec={id:ID.TRANSPOSE_GROUP_V3,s:4,r:1}
  fastDeepEqual(decodeTerrainGroup(makeGroup(ID.STORE,reversed),[6,5],revSpec),reversedParts)
  const diff=new Uint8Array(reversed.length);let offset=0
  for(const len of [6,5]) { for(let i=0;i<len;i++)diff[offset+i]=(reversed[offset+i]-(i>=4?reversed[offset+i-4]:0))&255;offset+=len }
  const codedDiff=encodeCM(diff,'res',4,1,undefined,0,undefined,undefined,'v13')
  fastDeepEqual(decodeTerrainGroup(makeGroup(ID.DELTA,codedDiff),[6,5],revSpec),reversedParts)
  const codedBin=encodeCM(reversed,'bin',4,1,undefined,0,undefined,undefined,'v13',4)
  fastDeepEqual(decodeTerrainGroup(makeGroup(ID.BIN,codedBin),[6,5],revSpec),reversedParts)
  // Variant contexts must be deterministic without changing legacy profiles.
  const contextData=Uint8Array.from({length:5000},(_,i)=>i%17===0?65+(i%26):(i*37+(i>>>3))&255)
  for(const profile of ['text','bin','res2d'] as Profile[]) for(const stride of [0,28,256]) {
    const coded=encodeCM(contextData,profile,1,28,undefined,0,undefined,undefined,true,stride)
    fastDeepEqual(decodeCM(coded,contextData.length,profile,1,28,undefined,true,stride),contextData)
  }
  assert.throws(()=>encodeCM(contextData,'bin',1,1,undefined,0,undefined,undefined,true,-1))
  for(const stride of [20,28]) {
    const record=Uint8Array.from({length:stride},(_,i)=>i*7)
    const data=Uint8Array.from({length:30001},(_,i)=>record[i%stride])
    assert.equal(detectRecordStride(data),stride)
  }
  const savedSeed = seed
  for (const n of [0,1,2,15,16,31,127,512,2049]) for (const [s,r] of [[1,1],[3,24],[16,4096]]) {
    const bytes=Uint8Array.from({length:n},()=>rand()&255)
    for(const weights of [fitMicroSeed(bytes,s,r),Uint8Array.of(128,255,127,224,200)])
      fastDeepEqual(microInv(microFwd(bytes,s,r,weights),s,r,weights),bytes)
  }
  assert.throws(()=>fitMicroSeed(noiseForMicro(),0,1))
  assert.throws(()=>microInv(new Uint8Array(1),1,1,new Uint8Array(4)))
  function noiseForMicro() { return new Uint8Array(16) }
  const msp={id:ID.MICRO,s:3,r:24}
  const mp=[Uint8Array.from({length:777},()=>rand()&255),Uint8Array.from({length:991},()=>rand()&255)]
  const mc=new Float32Array(4), me=encodeTerrainGroup(mp,msp,undefined,{values:mc,blockSize:512})
  fastDeepEqual(decodeTerrainGroup(me,mp.map(x=>x.length),msp),mp)
  assert.throws(()=>decodeTerrainGroup(me.subarray(0,9),mp.map(x=>x.length),msp))
  const one=Uint8Array.of(42), payload=encodeSpec(one,{id:ID.MICRO,s:1,r:1})
  const container=Uint8Array.from([85,67,90,11,1,1,1,17,1,1,payload.length,1,...payload])
  fastDeepEqual(decompress(container),one)
  const oldVersion=container.slice();oldVersion[3]=10;assert.throws(()=>decompress(oldVersion))
  const bad=container.slice();bad[8]=17;assert.throws(()=>decompress(bad))
  let ms=12345
  const mr=()=>{ms^=ms<<13;ms^=ms>>>17;ms^=ms<<5;return ms>>>0}
  const slope=new Uint8Array(32768)
  for(let i=0;i<slope.length;i++) slope[i]=Math.max(0,Math.min(255,Math.round(.8*(i?slope[i-1]:128)+25+(mr()%9-4))))
  const microResult=await legacySelection(() => compressAdaptive(slope))
  assert.equal((await legacySelection(() => evaluatePlan(slope,microResult.segs,{alreadyMerged:true}))).totalBytes,microResult.container.length)
  assert.ok(microResult.container[3]>=11)
  assert.ok(microResult.segs.some(s=>s.spec.id===ID.MICRO && s.micro?.weights.length===5))
  fastDeepEqual(decompress(microResult.container),slope)
  assert.equal(microResult.overhead+microResult.segs.reduce((a,s)=>a+s.compLen,0),microResult.container.length)
  for(const sg of microResult.segs) {
    const bits=microResult.analysis.blocks.filter(b=>b.start>=sg.start&&b.start<sg.end).reduce((sum,b)=>sum+microResult.blockCost[Math.floor(b.start/512)]*(b.end-b.start),0)
    assert.ok(Math.abs(bits-sg.compLen*8)<Math.max(.02,sg.compLen*8*.00001))
  }
  seed = savedSeed
  const text = new TextEncoder().encode('The quick brown fox jumps over the lazy dog. This is a text example.\n'.repeat(35))
  const noise = Uint8Array.from({length: 2048}, () => rand() & 255)
  const mixed = new Uint8Array(text.length * 2 + noise.length)
  mixed.set(text); mixed.set(noise, text.length); mixed.set(text, text.length + noise.length)
  const fill = new Uint8Array(4096); fill.fill(11, 0, 1024); fill.set(noise, 1024); fill.fill(42, 3072)
  for (const data of [new Uint8Array(), Uint8Array.of(5), noise, text, mixed, fill]) {
    const result = await compressAdaptive(data)
    fastDeepEqual(decompress(result.container), data)
    assert.equal(result.overhead + result.segs.reduce((n, s) => n + s.compLen, 0), result.container.length)
    for (let i = 0; i < result.analysis.blocks.length; i++) assert.ok(Number.isFinite(result.blockCost[i]))
    for (const sg of result.segs) {
      let bits = 0
      for (const bl of result.analysis.blocks) if (bl.start >= sg.start && bl.start < sg.end)
        bits += result.blockCost[Math.floor(bl.start / 512)] * (bl.end - bl.start)
      assert.ok(Math.abs(bits - sg.compLen * 8) < Math.max(0.02, sg.compLen * 8 * 0.00001), `分块成本与区域大小不一致 ${bits} vs ${sg.compLen * 8}`)
    }
    if (data.length) assert.throws(() => decompress(result.container.subarray(0, result.container.length - 1)))
  }
  // The final boundaries can be measured exactly without changing the plan.
  for (const data of [new Uint8Array(), Uint8Array.of(7), noise, text, mixed, fill]) {
    const encoded=await compressAdaptive(data)
    const cost=evaluatePlan(data,encoded.segs,{alreadyMerged:true})
    assert.equal(cost.totalBytes,encoded.container.length)
    assert.equal(cost.headerBytes,encoded.overhead)
    assert.equal(cost.payloadBytes,encoded.container.length-encoded.overhead)
    assert.equal(cost.segmentCount,encoded.segs.length)
    fastDeepEqual(evaluatePlan(data,encoded.segs,{alreadyMerged:true}),cost)
  }
  // Each codec gets an independently assembled one-group UCZ container.
  // TRANSPOSE_GROUP also checks the automatic three-way payload comparison.
  {
    const cases = [
      ['STORE',ID.STORE,1,1],['FILL',ID.FILL,1,1],['RLE',ID.RLE,1,1],
      ['O0',ID.O0,1,1],['TEXT',ID.TEXT,1,1],['BIN',ID.BIN,1,1],
      ['TEXT_V2',ID.TEXT_V2,1,1],['BIN_V2',ID.BIN_V2,1,1],['TEXT_V3',ID.TEXT_V3,1,1],['BIN_V3',ID.BIN_V3,1,1],
      ['DELTA',ID.DELTA,2,1],['DELTA_V3',ID.DELTA_V3,2,1],['GRAD',ID.GRAD,2,28],['GRAD_V2',ID.GRAD_V2,2,28],['GRAD_V3',ID.GRAD_V3,2,28],
      ['D16',ID.D16,1,2],['BCJ',ID.BCJ,1,1],['BCJ_V2',ID.BCJ_V2,1,1],['BCJ_V3',ID.BCJ_V3,1,1],
      ['ANCHOR',ID.ANCHOR,11,1],['ANCHOR_FOLD',ID.ANCHOR_FOLD,10,8],['PEEL',ID.PEEL,4,1],
      ['SUB_TRANSPOSE',ID.SUB_TRANSPOSE,4,2],['SUB_TRANSPOSE_V3',ID.SUB_TRANSPOSE_V3,4,2],
      ['SUB_ANCHOR',ID.SUB_ANCHOR,10,8],['SUB_ANCHOR_V3',ID.SUB_ANCHOR_V3,10,8],['MICRO',ID.MICRO,2,28],
      ['TRANSPOSE',ID.TRANSPOSE,4,1],['TRANSPOSE_GROUP',ID.TRANSPOSE_GROUP,4,1],['TRANSPOSE_2D',ID.TRANSPOSE_2D,4,1],['TRANSPOSE_GROUP_V3',ID.TRANSPOSE_GROUP_V3,4,1],
      ['WIDE_GRAD_D16',ID.WIDE_GRAD,1,256],['WIDE_GRAD_MED',ID.WIDE_GRAD,2,256],
    ] as const
    const put=(v:number)=>{const a:number[]=[];while(v>=128){a.push((v%128)|128);v=Math.floor(v/128)}a.push(v);return a}
    for(const [name,id,s,r] of cases) {
      const len=173
      const bytes=Uint8Array.from({length:len},(_,i)=>id===ID.FILL?17:i%19===0?10:(i*37+(i>>>3))&255)
      const spec={id,s,r}
      let finalId:number=id, payload=id===ID.FILL?Uint8Array.of(17):encodeTerrainGroup([bytes],spec,undefined,undefined,undefined,[0])
      if(id===ID.TRANSPOSE_GROUP) {
        const geom=encodeTerrainGroup([bytes],{id:ID.TRANSPOSE_2D,s,r}), enhanced=encodeTerrainGroup([bytes],{id:ID.TRANSPOSE_GROUP_V3,s,r})
        if(enhanced.length<Math.min(geom.length,geom[0]===0?geom.length-1:Infinity)){finalId=ID.TRANSPOSE_GROUP_V3;payload=enhanced}
        else if(geom[0]===1){finalId=ID.TRANSPOSE_2D;payload=geom}
      }
      const version=finalId===ID.WIDE_GRAD?14:finalId>=ID.TEXT_V3?13:finalId>=ID.TEXT_V2?12:finalId===ID.MICRO?11:finalId===ID.SUB_TRANSPOSE||finalId===ID.SUB_ANCHOR?10:finalId===ID.PEEL?9:finalId===ID.ANCHOR_FOLD?8:7
      const header=[85,67,90,version,...put(len),1,1,...put(finalId),...put(s),...put(r),...put(payload.length),...put(len)]
      const container=new Uint8Array(header.length+payload.length);container.set(header);container.set(payload,header.length)
      const picks=[{start:0,end:len,cls:'binary' as Cls,spec}]
      const cost=evaluatePlan(bytes,picks)
      fastDeepEqual(cost,{totalBytes:container.length,headerBytes:header.length,payloadBytes:payload.length,groupCount:1,segmentCount:1},name)
      fastDeepEqual(evaluatePlan(bytes,picks),cost,name+' deterministic')
      fastDeepEqual(decompress(container),bytes,name+' round trip')
    }
    for(const [values,segmentCount] of [[[7,7],1],[[7,9],2]] as const) {
      const bytes=Uint8Array.of(values[0],values[0],values[1],values[1])
      const spec={id:ID.FILL,s:1,r:1}
      const picks=[{start:0,end:2,cls:'fill' as Cls,spec},{start:2,end:4,cls:'fill' as Cls,spec}]
      const payload=segmentCount===1?[values[0]]:[...values]
      const header=[85,67,90,7,4,segmentCount,1,ID.FILL,1,1,payload.length,...(segmentCount===1?[4]:[2,2])]
      const container=Uint8Array.from([...header,...payload])
      fastDeepEqual(evaluatePlan(bytes,picks),{totalBytes:container.length,headerBytes:header.length,payloadBytes:payload.length,groupCount:1,segmentCount})
      fastDeepEqual(decompress(container),bytes)
    }
  }
  // Dictionary parameter boundaries mirror the actual container decoder; the
  // encoder additionally enforces per-part PEEL/sub-channel resource limits.
  {
    const d=Uint8Array.of(1,2,3,10,4,5,6)
    const run=(spec:{id:number;s:number;r:number})=>evaluatePlan(d,[{start:0,end:d.length,cls:'binary',spec}])
    const valid=[
      {id:ID.ANCHOR,s:1,r:1},{id:ID.ANCHOR,s:256,r:1},
      ...[ID.ANCHOR_FOLD,ID.SUB_ANCHOR,ID.SUB_ANCHOR_V3].flatMap(id=>[2,9,24,32,127,130,137,152,160,255].map(r=>({id,s:0,r}))),
      {id:ID.ANCHOR_FOLD,s:32,r:32},
      ...[ID.SUB_TRANSPOSE,ID.SUB_TRANSPOSE_V3].flatMap(id=>[{id,s:2,r:1},{id,s:64,r:2}]),
      {id:ID.PEEL,s:2,r:1},{id:ID.PEEL,s:64,r:1},
      {id:ID.MICRO,s:1,r:1},{id:ID.MICRO,s:16,r:4096},
      {id:ID.WIDE_GRAD,s:1,r:256},{id:ID.WIDE_GRAD,s:2,r:8192},
    ]
    for(const spec of valid) assert.doesNotThrow(()=>run(spec),JSON.stringify(spec))
    const invalid=[
      {id:32,s:1,r:1},{id:ID.STORE,s:NaN,r:1},{id:ID.STORE,s:1,r:0},
      {id:ID.BCJ,s:2,r:1},{id:ID.TEXT_V3,s:1,r:2},
      {id:ID.ANCHOR,s:0,r:1},{id:ID.ANCHOR,s:257,r:1},{id:ID.ANCHOR,s:1,r:2},
      ...[ID.ANCHOR_FOLD,ID.SUB_ANCHOR,ID.SUB_ANCHOR_V3].flatMap(id=>[1,25,31,128,129,153,159,256].map(r=>({id,s:0,r}))),
      ...[ID.SUB_ANCHOR,ID.SUB_ANCHOR_V3].flatMap(id=>[9,32,137,160].map(r=>({id,s:r&127,r}))),
      ...[ID.SUB_TRANSPOSE,ID.SUB_TRANSPOSE_V3].flatMap(id=>[{id,s:1,r:1},{id,s:65,r:1},{id,s:2,r:3}]),
      {id:ID.PEEL,s:1,r:1},{id:ID.PEEL,s:65,r:1},{id:ID.PEEL,s:2,r:2},
      {id:ID.MICRO,s:17,r:1},{id:ID.MICRO,s:1,r:4097},
      {id:ID.WIDE_GRAD,s:0,r:256},{id:ID.WIDE_GRAD,s:3,r:256},{id:ID.WIDE_GRAD,s:2,r:255},{id:ID.WIDE_GRAD,s:2,r:257},{id:ID.WIDE_GRAD,s:2,r:8194},
    ]
    for(const spec of invalid) assert.throws(()=>run(spec),undefined,JSON.stringify(spec))
    for(const id of [ID.PEEL,ID.SUB_TRANSPOSE,ID.SUB_TRANSPOSE_V3,ID.SUB_ANCHOR,ID.SUB_ANCHOR_V3]) {
      const big=new Uint8Array(8*1024*1024+1)
      const spec={id,s: id===ID.SUB_ANCHOR||id===ID.SUB_ANCHOR_V3?10:2,r:id===ID.SUB_ANCHOR||id===ID.SUB_ANCHOR_V3?8:1}
      assert.throws(()=>evaluatePlan(big,[{start:0,end:big.length,cls:'binary',spec}]),/上限|越界/)
    }
  }
  // Independent hand-built mixed-group container: A/C share CM, B is stored.
  const a=Uint8Array.of(7,8,9,10),b=Uint8Array.of(201,202),c=Uint8Array.of(5,6,7)
  const planData=Uint8Array.from([...a,...b,...c]), bin={id:ID.BIN,s:1,r:1},store={id:ID.STORE,s:1,r:1}
  const plan=[{start:0,end:4,cls:'binary' as Cls,spec:bin},{start:4,end:6,cls:'binary' as Cls,spec:store},{start:6,end:9,cls:'binary' as Cls,spec:bin}]
  const binPayload=encodeTerrainGroup([a,c],bin)
  const manual=Uint8Array.from([85,67,90,7,9,3,2,ID.BIN,1,1,binPayload.length,ID.STORE,1,1,2,4,2,3,5,...binPayload,...b])
  const planCost=evaluatePlan(planData,plan)
  assert.equal(planCost.totalBytes,manual.length);assert.equal(planCost.headerBytes,manual.length-binPayload.length-b.length)
  fastDeepEqual(decompress(manual),planData)
  const joined=[{start:0,end:4,cls:'binary' as Cls,spec:bin},{start:4,end:9,cls:'repeat' as Cls,spec:bin}]
  assert.equal(evaluatePlan(planData,joined).segmentCount,1)
  assert.equal(evaluatePlan(planData,joined,{alreadyMerged:true}).segmentCount,2)
  assert.throws(()=>evaluatePlan(planData,plan.slice(1)))
  assert.throws(()=>evaluatePlan(planData,[{start:0,end:9,cls:'fill',spec:{id:ID.FILL,s:1,r:1}}]))
  assert.throws(()=>evaluatePlan(planData,[{start:0,end:9,cls:'binary',spec:{id:ID.BIN,s:0,r:1}}]))
  // Independent container assembly for mixed non-adjacent rules, varints,
  // collapsed bitmap, per-region seeds, fill values, BCJ positions and tails.
  {
    const specs=[{id:ID.FILL,s:1,r:1},{id:ID.BCJ_V3,s:1,r:1},{id:ID.MICRO,s:2,r:1},
      {id:ID.ANCHOR,s:11,r:1},{id:ID.PEEL,s:3,r:1},{id:ID.SUB_ANCHOR_V3,s:10,r:8},
      {id:ID.WIDE_GRAD,s:2,r:4144},{id:ID.D16,s:1,r:1},{id:ID.FILL,s:1,r:1},
      {id:ID.BCJ_V3,s:1,r:1},{id:ID.MICRO,s:2,r:1}]
    const parts=specs.map((sp,j)=>Uint8Array.from({length:130+j*5},(_,i)=>sp.id===ID.FILL ? (j===0?7:9) : i%17===0?10:(i*17+j*23)&255))
    parts[1][12]=0xe8;parts[9][10]=0xe9
    const bytes=Uint8Array.from(parts.flatMap(p=>Array.from(p))), plan: {start:number;end:number;cls:Cls;spec:typeof specs[number]}[]=[]
    let offset=0
    for(let j=0;j<parts.length;j++) {plan.push({start:offset,end:offset+parts[j].length,cls:'binary',spec:specs[j]});offset+=parts[j].length}
    const groups:{spec:typeof specs[number];members:number[];payload:Uint8Array}[]=[]
    for(let i=0;i<plan.length;i++) {const spec=plan[i].spec;let g=groups.find(g=>g.spec.id===spec.id&&g.spec.s===spec.s&&g.spec.r===spec.r);if(!g){g={spec,members:[],payload:new Uint8Array()};groups.push(g)}g.members.push(i)}
    groups.sort((x,y)=>y.members.length-x.members.length)
    for(const g of groups) g.payload=g.spec.id===ID.FILL?Uint8Array.from(g.members.map(i=>parts[i][0])):encodeTerrainGroup(g.members.map(i=>parts[i]),g.spec,undefined,undefined,undefined,g.members.map(i=>plan[i].start))
    const header=[85,67,90,14],put=(v:number)=>{while(v>=128){header.push((v%128)|128);v=Math.floor(v/128)}header.push(v)}
    put(bytes.length);put(parts.length);put(groups.length)
    for(const g of groups){put(g.spec.id);put(g.spec.s);put(g.spec.r);put(g.payload.length)}
    for(const p of parts)put(p.length)
    let pending=parts.map((_,i)=>i),bit=0,byte=0
    for(const g of groups.slice(0,-1)) {const next:number[]=[];for(const i of pending){if(g.members.includes(i))byte|=1<<bit;else next.push(i);if(++bit===8){header.push(byte);byte=0;bit=0}}pending=next}
    if(bit)header.push(byte)
    const container=Uint8Array.from([...header,...groups.flatMap(g=>Array.from(g.payload))])
    const measured=evaluatePlan(bytes,plan,{alreadyMerged:true})
    assert.equal(measured.totalBytes,container.length)
    assert.equal(measured.headerBytes,header.length)
    assert.equal(measured.payloadBytes,container.length-header.length)
    assert.equal(measured.groupCount,groups.length)
    fastDeepEqual(decompress(container),bytes)
  }
  const m = await compressAdaptive(mixed)
  assert.ok(m.segs.length >= 3)
  assert.equal(m.segs[0].spec.id, m.segs[m.segs.length - 1].spec.id)
  assert.throws(() => decodeSpec(Uint8Array.of(1, 6), 5, {id: ID.RLE, s: 1, r: 1}))
  fastDeepEqual(decompress(Uint8Array.of(85, 67, 90, 1, 3, 1, 0, 3, 3, 1, 2, 3)), Uint8Array.of(1, 2, 3))
  for (const width of [24, 32, 48, 64, 128, 256]) {
    const row = Uint8Array.from({length: width}, () => rand() & 255)
    const grid = Uint8Array.from({length: width * 40}, (_, i) => (row[i % width] + Math.floor(i / width)) & 255)
    const analysis = analyze(grid)
    assert.ok(analysis.blocks.some(b => b.cls === 'smooth'), `width ${width}`)
    assert.ok(detectLag(grid, 1) > 0, `lag ${width}`)
    fastDeepEqual(decompress((await compressAdaptive(grid)).container), grid)
  }
  // 小区合并与原始最左优先实现保持相同结果。
  const classes: Cls[] = ['text','binary','noise','smooth','fill','repeat']
  for (let test = 0; test < 300; test++) {
    const labels = Array.from({length:rand() % 500}, () => classes[rand() % classes.length])
    const expected = labels.slice()
    for (;;) {
      const runs: {s:number;e:number;c:Cls}[] = []
      for (let i = 0; i < expected.length; i++) {
        const last = runs[runs.length - 1]
        if (last && last.c === expected[i]) last.e = i + 1
        else runs.push({s:i,e:i+1,c:expected[i]})
      }
      if (runs.length <= 1) break
      const k = runs.findIndex(r => r.e - r.s < 2)
      if (k < 0) break
      const to = k === 0 ? runs[1].c : k === runs.length-1 ? runs[k-1].c : runs[k-1].e-runs[k-1].s >= runs[k+1].e-runs[k+1].s ? runs[k-1].c : runs[k+1].c
      expected.fill(to,runs[k].s,runs[k].e)
    }
    mergeShortRuns(labels, 2)
    fastDeepEqual(labels, expected)
  }
  // 每个区域先重置变换，然后共享残差模型，包括奇数长度 D16。
  const parts = [Uint8Array.from({length: 51}, (_, i) => (i * 3) & 255), Uint8Array.from({length: 65}, (_, i) => (200 - i * 2) & 255)]
  for (const spec of [{id:ID.DELTA,s:3,r:1},{id:ID.GRAD,s:3,r:12},{id:ID.D16,s:1,r:2}]) {
    const transformed = parts.map(p => spec.id === ID.DELTA ? deltaFwd(p,spec.s) : spec.id === ID.GRAD ? medFwd(p,spec.s,spec.r) : d16Fwd(p,spec.s,spec.r))
    const joined = Uint8Array.from(transformed.flatMap(p => [...p]))
    const profile = spec.id === ID.GRAD ? 'res2d' : 'res'
    const expected = encodeCM(joined, profile, spec.id === ID.D16 ? 2 * spec.s : spec.s, spec.id === ID.GRAD ? spec.r : 1)
    const payload = encodeTerrainGroup(parts, spec)
    fastDeepEqual(payload, expected)
    fastDeepEqual(decodeTerrainGroup(payload, parts.map(p=>p.length), spec), parts)
    // v3 动态坑位 [变换, STORE, 变换]，验证非相邻区域与恢复顺序。
    const middle = Uint8Array.of(99,98,97)
    const vint = (v:number) => { const a:number[] = []; while (v >= 128) { a.push((v % 128) | 128); v = Math.floor(v / 128) } a.push(v); return a }
    const v3 = Uint8Array.from([85,67,90,3,...vint(parts[0].length + middle.length + parts[1].length),3,2,spec.id,spec.s,spec.r,...vint(payload.length),ID.STORE,1,1,middle.length,parts[0].length,middle.length,parts[1].length,5,...payload,...middle])
    fastDeepEqual(decompress(v3), Uint8Array.from([...parts[0], ...middle, ...parts[1]]))
    // 手工构造 v2 两个区域的旧式连续变换容器。
    const raw = Uint8Array.from(parts.flatMap(p => [...p]))
    const oldPayload = encodeSpec(raw, spec)
    const varint = (v:number) => { const a:number[] = []; while(v >= 128) { a.push((v % 128) | 128); v = Math.floor(v / 128) } a.push(v); return a }
    const old = Uint8Array.from([85,67,90,2,...varint(raw.length),2,1,spec.id,spec.s,spec.r,...varint(oldPayload.length),...parts.map(p=>p.length),...oldPayload])
    fastDeepEqual(decompress(old), raw)
  }
  // Every stride 2..64, including prime/odd widths, should be discoverable.
  for (let width = 2; width <= 64; width++) {
    const data = Uint8Array.from({length:width * 800}, (_,i) => {
      const col = i % width
      return col < Math.ceil(width / 2) ? (col * 73 + 17) & 255 : rand() & 255
    })
    assert.equal(detectRecordStride(data), width, `record stride ${width}`)
  }
  const noiseProbe = Uint8Array.from({length:4096}, () => rand() & 255)
  assert.equal(detectRecordStride(noiseProbe), 0)
  // Per-column models, partial rows, offsets and non-aligned segment boundaries.
  for (const width of [2, 3, 7, 28, 37, 64]) {
    const spec = {id: ID.TRANSPOSE, s: width, r: 1}
    for (const lengths of [[0], [1], [width - 1], [width + 1], [513, 19, 1001], [3000, 1025]]) {
      const pieces = lengths.map((n, p) => Uint8Array.from({length:n}, (_,i) => i % width < width / 2 ? (i % width) * 3 : (rand() + p) & 255))
      const byteCost = new Float32Array(lengths[0] + 10).fill(-1)
      const one = encodeSpec(pieces[0], spec, byteCost, 5)
      fastDeepEqual(decodeSpec(one, lengths[0], spec), pieces[0])
      if (lengths[0]) {
        const bits = byteCost.subarray(5, 5 + lengths[0]).reduce((a,b) => a+b, 0)
        assert.ok(Math.abs(bits - one.length * 8) < 0.1, `transpose cost width ${width}`)
      }
      assert.equal(byteCost[4], -1)
      const total = lengths.reduce((a,b)=>a+b,0)
      const blockCost = new Float32Array(Math.ceil(total / 512))
      const payload = encodeTerrainGroup(pieces, spec, undefined, {values:blockCost, blockSize:512})
      fastDeepEqual(decodeTerrainGroup(payload, lengths, spec), pieces)
      if (total) assert.ok(Math.abs(blockCost.reduce((a,b)=>a+b,0) - payload.length * 8) < 0.1)
      assert.throws(() => decodeTerrainGroup(payload.subarray(0, payload.length-1), lengths, spec))
    }
  }
  // Transposed delta columns share one model, but reset prediction at each segment seam.
  const deltaParts = [10, 200].map(start => Uint8Array.from({length:6000}, (_,i) => i % 2 === 0 ? (start + i / 2) & 255 : 17))
  const deltaPayload = encodeTerrainGroup(deltaParts, {id:ID.TRANSPOSE,s:2,r:1})
  assert.equal(deltaPayload[0], ID.DELTA)
  let hp = 1, plen = 0, mul = 1
  do { const b = deltaPayload[hp++]; plen += (b & 127) * mul; mul *= 128; if (b < 128) break } while (true)
  const residual = Uint8Array.from(deltaParts.flatMap(part => Array.from(deltaFwd(Uint8Array.from({length:part.length / 2}, (_,i) => part[i * 2]), 1))))
  fastDeepEqual(deltaPayload.subarray(hp, hp + plen), encodeCM(residual, 'res', 1, 1))
  fastDeepEqual(decodeTerrainGroup(deltaPayload, deltaParts.map(p => p.length), {id:ID.TRANSPOSE,s:2,r:1}), deltaParts)
  // v4 collapse bitmap restores disjoint transpose segments around a STORE segment.
  const separated = [Uint8Array.from({length:513}, (_,i) => (i * 11) & 255), Uint8Array.from({length:1001}, (_,i) => (i * 7) & 255)]
  const between = Uint8Array.of(201, 202, 203)
  const separatedPayload = encodeTerrainGroup(separated, {id:ID.TRANSPOSE,s:28,r:1})
  const varint4 = (v:number) => { const a:number[] = []; while (v >= 128) { a.push((v % 128) | 128); v = Math.floor(v / 128) } a.push(v); return a }
  const v4 = Uint8Array.from([85,67,90,4,...varint4(513+3+1001),3,2, ID.TRANSPOSE,28,1,...varint4(separatedPayload.length),ID.STORE,1,1,3,...varint4(513),3,...varint4(1001),5,...separatedPayload,...between])
  fastDeepEqual(decompress(v4), Uint8Array.from([...separated[0], ...between, ...separated[1]]))
  const badVersion = v4.slice(); badVersion[3] = 3
  assert.throws(() => decompress(badVersion))
  // V5 grouped streams remain reversible for tails and disjoint, unaligned parts.
  for (const width of [2, 7, 28]) {
    const spec = {id:ID.TRANSPOSE_GROUP,s:width,r:1}
    for (const lengths of [[0], [1], [width - 1], [width + 1], [513, 19, 1001]]) {
      const pieces = lengths.map((n,p) => Uint8Array.from({length:n}, (_,i) => i % width < width / 2 ? (i % width) * 3 : (rand()+p) & 255))
      const total = lengths.reduce((a,b) => a+b,0), costs = new Float32Array(Math.ceil(total/512))
      const packed = encodeTerrainGroup(pieces, spec, undefined, {values:costs,blockSize:512})
      fastDeepEqual(decodeTerrainGroup(packed, lengths, spec), pieces)
      const perByte = new Float32Array(lengths[0] + 10).fill(-1)
      const single = encodeSpec(pieces[0], spec, perByte, 5)
      fastDeepEqual(decodeSpec(single, lengths[0], spec), pieces[0])
      assert.equal(perByte[4], -1)
      if (lengths[0]) assert.ok(Math.abs(perByte.subarray(5, 5 + lengths[0]).reduce((a,b)=>a+b,0) - single.length * 8) < 0.1)
      if (total) assert.ok(Math.abs(costs.reduce((a,b) => a+b,0) - packed.length * 8) < 0.1)
      assert.throws(() => decodeTerrainGroup(packed.subarray(0,packed.length-1), lengths, spec))
    }
  }
  // Group-delta seams reset even when a segment ends in a partial record.
  const groupParts = [Uint8Array.of(10, 20, 30, 40, 11, 21, 31), Uint8Array.of(200, 210, 220, 230, 201, 211, 221, 231, 202, 212)]
  const groupResidual = Uint8Array.from(groupParts.flatMap(part => [...deltaFwd(part, 4)]))
  const groupCompressed = encodeCM(groupResidual, 'res', 4, 1)
  const vlen = (v:number) => { const a:number[] = []; while (v >= 128) { a.push((v % 128) | 128); v = Math.floor(v / 128) } a.push(v); return a }
  const groupPayload = Uint8Array.from([4, ID.DELTA, ...vlen(groupCompressed.length), ...groupCompressed])
  fastDeepEqual(decodeTerrainGroup(groupPayload, groupParts.map(p => p.length), {id:ID.TRANSPOSE_GROUP,s:4,r:1}), groupParts)
  const invalidSpan = groupPayload.slice(); invalidSpan[0] = 0
  assert.throws(() => decodeTerrainGroup(invalidSpan, groupParts.map(p => p.length), {id:ID.TRANSPOSE_GROUP,s:4,r:1}))
  const invalidMode = groupPayload.slice(); invalidMode[1] = 255
  assert.throws(() => decodeTerrainGroup(invalidMode, groupParts.map(p => p.length), {id:ID.TRANSPOSE_GROUP,s:4,r:1}))
  // v5 grouped transpose can share a model across non-adjacent regions.
  const groupedSpec = {id:ID.TRANSPOSE_GROUP,s:28,r:1}
  const groupedParts = [Uint8Array.from({length:513}, (_,i) => i & 255), Uint8Array.from({length:1001}, (_,i) => (i * 7) & 255)]
  const groupedPayload = encodeTerrainGroup(groupedParts, groupedSpec)
  const v5var = (v:number) => { const a:number[] = []; while (v >= 128) { a.push((v % 128) | 128); v = Math.floor(v / 128) } a.push(v); return a }
  const v5 = Uint8Array.from([85,67,90,5,...v5var(513+3+1001),3,2,ID.TRANSPOSE_GROUP,28,1,...v5var(groupedPayload.length),ID.STORE,1,1,3,...v5var(513),3,...v5var(1001),5,...groupedPayload,201,202,203])
  fastDeepEqual(decompress(v5), Uint8Array.from([...groupedParts[0],201,202,203,...groupedParts[1]]))
  const groupAsV4 = v5.slice(); groupAsV4[3] = 4
  assert.throws(() => decompress(groupAsV4))
  // Repeat/binary labels can propose the same 2D gradient as smooth labels.
  const row = Uint8Array.from({length:1024}, () => rand() & 255)
  const periodic = Uint8Array.from({length:32768}, (_,i) => row[i % row.length])
  const keepPruning = planTuning.dropZeroHitIds
  planTuning.dropZeroHitIds = false
  try { for (const cls of ['repeat','binary'] as const) {
    const cand = candidatesFor(periodic, cls, 2, sampleWindow(periodic, 16000, 2).sample)
    assert.ok(cand.some(s => s.id === ID.GRAD && s.s === 2 && s.r === 1024), `GRAD missing for ${cls}`)
    assert.ok(!candidatesFor(periodic.subarray(0,4096), cls, 2, periodic.subarray(0,4096)).some(s => s.id === ID.GRAD))
  }
  } finally { planTuning.dropZeroHitIds = keepPruning }
  const sampleData = new Uint8Array(600000)
  const sw = sampleWindow(sampleData, 16000, 1024)
  assert.equal(sw.start % 1024, 0)
  assert.ok(sw.start > 250000 && sw.start < 320000)
  assert.equal(sw.sample.length, 15 * 1024)
  const recWidth = 28
  const records = Uint8Array.from({length:recWidth * 2000 + 11}, (_,i) => (i % recWidth) < 16 ? (i % recWidth) * 7 : rand() & 255)
  const packedRecords = await legacySelection(() => compressAdaptive(records))
  assert.equal((await legacySelection(() => evaluatePlan(records,packedRecords.segs,{alreadyMerged:true}))).totalBytes,packedRecords.container.length)
  assert.ok(packedRecords.segs.some(s => s.trials.some(t => t.spec.id === ID.TRANSPOSE && t.spec.s === recWidth)), 'transpose must be trialled')
  assert.ok(packedRecords.segs.some(s => s.spec.id === ID.TRANSPOSE || s.spec.id === ID.TRANSPOSE_GROUP), 'transpose should win on structured records')
  assert.equal(packedRecords.container[3], 7)
  for (const sg of packedRecords.segs) for (const trial of sg.trials) {
    if (trial.sampleStart && trial.spec.id === ID.TRANSPOSE_GROUP) { assert.equal(trial.sampleStart % trial.spec.s, 0); if (trial.sampleLen! >= trial.spec.s * 4) assert.equal(trial.sampleLen! % trial.spec.s, 0) }
    if (trial.sampleStart && trial.spec.id === ID.GRAD) { assert.equal(trial.sampleStart % trial.spec.r, 0); if (trial.sampleLen! >= trial.spec.r * 4) assert.equal(trial.sampleLen! % trial.spec.r, 0) }
  }
  fastDeepEqual(decompress(packedRecords.container), records)
  for (const sg of packedRecords.segs) {
    let bits = 0
    for (const bl of packedRecords.analysis.blocks) if (bl.start >= sg.start && bl.start < sg.end) bits += packedRecords.blockCost[Math.floor(bl.start / 512)] * (bl.end - bl.start)
    assert.ok(Math.abs(bits - sg.compLen * 8) < Math.max(0.02, sg.compLen * 8 * 0.00001))
  }
  const malformed = encodeSpec(records.subarray(0, 100), {id:ID.TRANSPOSE,s:28,r:1})
  malformed[0] = 255
  assert.throws(() => decodeSpec(malformed, 100, {id:ID.TRANSPOSE,s:28,r:1}))
  assert.throws(() => encodeSpec(records, {id:ID.TRANSPOSE,s:65,r:1}))
  // Exact fill seams, including a 63-byte non-fill run and three-byte gap.
  const seamData = Uint8Array.from({length:1300}, (_,i) => (i * 31 + 7) & 255)
  seamData.fill(0, 111, 310); seamData.fill(17, 313, 377); seamData.fill(19, 377, 440)
  const seamInput = [
    {start:0,end:128,cls:'binary' as Cls,bestS:1,b0:0,b1:1},
    {start:128,end:430,cls:'fill' as Cls,bestS:1,b0:0,b1:1},
    {start:430,end:1300,cls:'binary' as Cls,bestS:1,b0:0,b1:3},
  ]
  const refined = refineFillSeams(seamData, seamInput)
  fastDeepEqual(refined.filter(s => s.cls === 'fill').map(s => [s.start,s.end]), [[111,310],[313,377]])
  assert.equal(refined[0].start,0); assert.equal(refined.at(-1)!.end,seamData.length)
  for (let i = 1; i < refined.length; i++) assert.equal(refined[i-1].end, refined[i].start)
  fastDeepEqual(refineFillSeams(new Uint8Array(), []), [])
  const multi = sampleWindows(new Uint8Array(600000), 16000, 1024)
  assert.equal(multi.length,3); assert.ok(multi.every(w => w.start % 1024 === 0 && w.sample.length >= 4096))
  assert.ok(detectLagCandidates(periodic,2).includes(1024))
  // A one-window spurious period cannot become a long-region candidate.
  const periods = new Uint8Array(120000)
  for (const [f,width] of [[0.2,1024],[0.5,1024],[0.8,1534]]) {
    const start = Math.floor(((periods.length-16000)*f)/2)*2
    const row = Uint8Array.from({length:width},()=>rand()&255)
    for (let i=0;i<16000;i++) periods[start+i]=row[i%width]
  }
  const stableLags=detectLagCandidates(periods,2)
  assert.ok(stableLags.includes(1024)); assert.ok(!stableLags.includes(1534))
  // Tiny seam noise is never discarded: two fills can become an RLE candidate,
  // or a non-fill neighbor absorbs it. Expensive gaps stay separate.
  const noisyFill = new Uint8Array(8000); noisyFill.set([1,0,1],4000)
  const makeSeg=(start:number,end:number,cls:Cls)=>({start,end,cls,bestS:1,b0:Math.floor(start/512),b1:Math.ceil(end/512)})
  const rawSeams=[makeSeg(0,4000,'fill'),makeSeg(4000,4003,'binary'),makeSeg(4003,8000,'fill')]
  const cleaned=cleanTinySeams(noisyFill,rawSeams)
  fastDeepEqual(cleaned.map(s=>[s.start,s.end,s.cls]),[[0,8000,'repeat']])
  const absorbed=cleanTinySeams(noisyFill,[makeSeg(0,3000,'binary'),makeSeg(3000,3003,'repeat'),makeSeg(3003,8000,'fill')])
  fastDeepEqual(absorbed.map(s=>[s.start,s.end]),[[0,3003],[3003,8000]])
  const costly = noisyFill.slice(); for (let i=4000;i<4015;i++) costly[i]=i%251+1
  assert.equal(cleanTinySeams(costly,[makeSeg(0,4000,'fill'),makeSeg(4000,4015,'binary'),makeSeg(4015,8000,'fill')]).length,3)
  assert.equal(cleanTinySeams(noisyFill,[makeSeg(0,4000,'fill'),makeSeg(4000,4016,'binary'),makeSeg(4016,8000,'fill')]).length,3)
  const noisyPacked=await compressAdaptive(noisyFill)
  fastDeepEqual(decompress(noisyPacked.container),noisyFill)
  assert.ok(noisyPacked.segs.every(s=>s.end-s.start>=16))
  // Non-standard BCJ: random, high offset, incomplete immediate and disjoint parts.
  const bcjSpec = {id:ID.BCJ,s:1,r:1}
  for (const base of [0, 12345, 0xfffffff0, 0xffffffff]) {
    for (const len of [0,1,4,5,513,1027]) {
      const data = Uint8Array.from({length:len}, () => rand() & 255)
      if (len >= 5) { data[0] = 0xe8; data[1] = 0xe9 }
      fastDeepEqual(bcjInv(bcjFwd(data,base),base),data)
      fastDeepEqual(decodeSpec(encodeSpec(data,bcjSpec,undefined,0,base),len,bcjSpec,base),data)
    }
  }
  const bcjParts = [Uint8Array.of(0xe8,0xff,0xff,0xff,0xff,0xe9), Uint8Array.of(0xe9,1,2,3,4,0xe8,0)]
  const offsets = [513,0xfffffff0]
  const bcjPayload = encodeTerrainGroup(bcjParts,bcjSpec,undefined,undefined,undefined,offsets)
  fastDeepEqual(decodeTerrainGroup(bcjPayload,bcjParts.map(p=>p.length),bcjSpec,undefined,offsets),bcjParts)
  // File positions, not arbitrary test offsets, are required in a container.
  const inFilePayload = encodeTerrainGroup(bcjParts,bcjSpec,undefined,undefined,undefined,[0,7])
  const inFile = Uint8Array.from([85,67,90,6,14,3,2,ID.BCJ,1,1,...vlen(inFilePayload.length),ID.STORE,1,1,1,6,1,7,5,...inFilePayload,99])
  fastDeepEqual(decompress(inFile),Uint8Array.from([...bcjParts[0],99,...bcjParts[1]]))
  const invalidOld = inFile.slice(); invalidOld[3] = 5; assert.throws(() => decompress(invalidOld))
  const invalidParam = inFile.slice(); invalidParam[8] = 2; assert.throws(() => decompress(invalidParam))
  assert.throws(() => decompress(inFile.subarray(0,inFile.length-1)))
  // Costs with non-aligned logical fragments conserve payload bits across codecs.
  const irregular = [Uint8Array.from({length:111},()=>rand()&255), Uint8Array.from({length:740},()=>rand()&255)]
  for (const spec of [{id:ID.BIN,s:1,r:1},{id:ID.BCJ,s:1,r:1},{id:ID.TRANSPOSE,s:7,r:1},{id:ID.TRANSPOSE_GROUP,s:7,r:1}]) {
    const fragmentCosts = new Float32Array(5)
    const payload = encodeTerrainGroup(irregular,spec,undefined,{values:fragmentCosts,blockSize:512,ends:Uint32Array.of(111,512,851),offset:1},undefined,[11,900])
    fastDeepEqual(decodeTerrainGroup(payload,irregular.map(p=>p.length),spec,undefined,[11,900]),irregular)
    if (spec.id === ID.TRANSPOSE || spec.id === ID.TRANSPOSE_GROUP) assert.ok(Math.abs(fragmentCosts.reduce((a,b)=>a+b,0)-payload.length*8)<0.1)
    else {
      const perByte = new Float32Array(851)
      encodeTerrainGroup(irregular,spec,perByte,undefined,undefined,[11,900])
      for (const [j,start,end] of [[1,0,111],[2,111,512],[3,512,851]])
        assert.ok(Math.abs(fragmentCosts[j]-perByte.subarray(start,end).reduce((a,b)=>a+b,0))<0.02)
    }
    assert.equal(fragmentCosts[0],0); assert.equal(fragmentCosts[4],0)
  }
  const consecutiveFill = new Uint8Array(4096); consecutiveFill.fill(17,2048)
  const consecutivePacked = await compressAdaptive(consecutiveFill)
  fastDeepEqual(decompress(consecutivePacked.container),consecutiveFill)
  assert.equal(decompress(consecutivePacked.container).length,consecutiveFill.length)
  assert.ok(consecutivePacked.container.length <= 27, 'low-cardinality fill plan must not regress')

  // P22.3: arbitrary non-dyadic lag with a small periodic byte delta.
  const lagN = 60000, lagD = 10000
  const lagData = new Uint8Array(lagN)
  for (let i = 0; i < lagD; i++) lagData[i] = (i * 131 + 17) & 255
  for (let i = lagD; i < lagN; i++) lagData[i] = (lagData[i - lagD] + ((i % 16) * 31 + 7)) & 255
  const lagPacked = await compressAdaptive(lagData)
  assert.equal(decompress(lagPacked.container).length, lagN)
  fastDeepEqual(decompress(lagPacked.container), lagData)
  assert.ok(lagPacked.container.length <= 10250, `arbitrary lag period plan should trigger (${lagPacked.container.length})`)
  // An executable-shaped input for the BCJ assertion. Two properties matter, and
  // the previous fixture had neither the second one nor the first:
  //  1) IRREGULAR instruction lengths. The old fixture wrote an E8 every 5 bytes
  //     with a strictly arithmetic displacement, i.e. a perfect stride-5 record.
  //     TRANSPOSE_GROUP(s=5) legitimately encodes it to 66 bytes, so demanding
  //     "BCJ must be selected" was not a property of BCJ at all — it was a
  //     property of the generator, and it was false on real data with a fixed
  //     stride (verified identical at 0912a8f: id30/s=5, 66 B).
  //  2) REPEATED call TARGETS drawn from a small set while call SITES move. That
  //     is exactly what rel32 normalisation exploits: rel32 = target - (site+5)
  //     changes with the site, but target does not, so adding pc makes every call
  //     to the same function identical. Without a small target set, BCJ has
  //     nothing to normalise into and correctly loses.
  const syntheticExe = (() => {
    let x = 0x9e3779b9 >>> 0
    const rnd = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 0 }
    const n = 100000, out = new Uint8Array(n)
    for (let i = 0; i < n; i++) out[i] = rnd() & 255
    const targets = [0x401000, 0x402300, 0x403100, 0x404500, 0x405a00]
    let i = 0
    while (i + 4 < n) {
      if (rnd() % 3 === 0) {
        out[i] = rnd() % 2 ? 0xe8 : 0xe9
        const displacement = (targets[rnd() % targets.length] - (i + 5)) >>> 0
        out[i + 1] = displacement & 255; out[i + 2] = (displacement >>> 8) & 255
        out[i + 3] = (displacement >>> 16) & 255; out[i + 4] = displacement >>> 24
        i += 5
      } else i += 1 + (rnd() % 6)
    }
    return out
  })()
  const bufferInput = Buffer.from(syntheticExe)
  const snapshot = Buffer.from(bufferInput)
  fastDeepEqual(bcjInv(bcjFwd(bufferInput,1234),1234),new Uint8Array(snapshot))
  fastDeepEqual(bufferInput,snapshot)
  const exePacked = await legacySelection(() => compressAdaptive(bufferInput))
  fastDeepEqual(bufferInput,snapshot)
  // Any member of the BCJ family is the right answer: the pipeline is entitled to
  // pick up the v20/v21 improvements (BCJ_V3 / BCJ2) for the same transform. The
  // property under test is "an executable-shaped input is modelled via rel32
  // normalisation", not "it lands on the oldest id of that family".
  assert.ok(exePacked.segs.some(s=>[ID.BCJ, ID.BCJ_V2, ID.BCJ_V3].includes(s.spec.id as 11|20|25)),
    `expected a BCJ-family segment, got ${exePacked.segs.map(s=>s.spec.id).join(',')}`)
  fastDeepEqual(decompress(exePacked.container),new Uint8Array(syntheticExe))
  const noisePacked = await compressAdaptive(noise)
  assert.ok(noisePacked.segs.every(s=>s.spec.id!==ID.BCJ))
  const unaligned = Uint8Array.from({length:18000},()=>rand()&255)
  unaligned.fill(0,3101,11283)
  const unalignedPacked = await compressAdaptive(unaligned)
  assert.ok(unalignedPacked.segs.some(s=>s.start===3101 && s.end===11283 && s.spec.id===ID.FILL))
  fastDeepEqual(decompress(unalignedPacked.container),unaligned)
  const unalignedBits=unalignedPacked.analysis.blocks.reduce((a,b,i)=>a+unalignedPacked.blockCost[i]*(b.end-b.start),0)
  assert.ok(Math.abs(unalignedBits-(unalignedPacked.container.length-unalignedPacked.overhead)*8)<0.1)
  const seamPacked = await compressAdaptive(seamData)
  fastDeepEqual(decompress(seamPacked.container),seamData)
  const allBits = seamPacked.analysis.blocks.reduce((a,b,i)=>a + seamPacked.blockCost[i]*(b.end-b.start),0)
  assert.ok(Math.abs(allBits-(seamPacked.container.length-seamPacked.overhead)*8)<0.1)
  assert.equal(seamPacked.overhead+seamPacked.segs.reduce((a,b)=>a+b.compLen,0),seamPacked.container.length)
  // Variable rows: missing first/last delimiters, adjacent delimiters, long
  // tails, binary NUL anchors, non-adjacent segments and strict framing.
  const anchorSpec = {id:ID.ANCHOR,s:11,r:1}
  const anchorInputs = [new Uint8Array(), Uint8Array.of(10), Uint8Array.of(10,10,10),
    new TextEncoder().encode('prefix without anchor\nfirst\n\nlast without terminator'),
    Uint8Array.from({length:4097},(_,i)=>i%103===0?10:(i*7)%251)]
  for (const data of anchorInputs) {
    const before = new Uint8Array(data)
    const payload=encodeAnchor(data,10)
    fastDeepEqual(decodeAnchor(payload,data.length,10),data)
    fastDeepEqual(decodeSpec(encodeSpec(data,anchorSpec),data.length,anchorSpec),data)
    fastDeepEqual(data,before)
    assert.throws(()=>decodeAnchor(payload.subarray(0,payload.length-1),data.length,10))
    assert.throws(()=>decodeAnchor(Uint8Array.from([...payload,0]),data.length,10))
  }
  for (let k=0;k<50;k++) {
    const anchor=rand()&255, len=rand()%2000
    const data=Uint8Array.from({length:len},()=>rand()%5===0?anchor:rand()&255)
    fastDeepEqual(decodeAnchor(encodeAnchor(data,anchor),data.length,anchor),data)
  }
  const binaryAnchors=Uint8Array.of(3,0,1,2,0,0,4,5,6,7)
  fastDeepEqual(decodeAnchor(encodeAnchor(binaryAnchors,0),binaryAnchors.length,0),binaryAnchors)
  assert.equal(anchorRowCount(new Uint8Array(MAX_ANCHOR_ROWS+2),0),MAX_ANCHOR_ROWS+1)
  assert.throws(()=>encodeAnchor(new Uint8Array(MAX_ANCHOR_ROWS+2),0))
  const aParts=[anchorInputs[3],anchorInputs[4]], aLengths=aParts.map(p=>p.length)
  const bins=new Float32Array(3)
  const aPayload=encodeTerrainGroup(aParts,anchorSpec,undefined,{values:bins,blockSize:512,ends:Uint32Array.of(aLengths[0],aLengths[0]+512,aLengths[0]+aLengths[1])})
  fastDeepEqual(decodeTerrainGroup(aPayload,aLengths,anchorSpec),aParts)
  assert.ok(Math.abs(bins.reduce((a,b)=>a+b,0)-aPayload.length*8)<0.1)
  const anchorContainer=Uint8Array.from([85,67,90,7,...vlen(aLengths[0]+1+aLengths[1]),3,2,ID.ANCHOR,11,1,...vlen(aPayload.length),ID.STORE,1,1,1,...vlen(aLengths[0]),1,...vlen(aLengths[1]),5,...aPayload,99])
  fastDeepEqual(decompress(anchorContainer),Uint8Array.from([...aParts[0],99,...aParts[1]]))
  const invalidV6=anchorContainer.slice(); invalidV6[3]=6; assert.throws(()=>decompress(invalidV6))
  const invalidWidth=anchorContainer.slice(); invalidWidth[10]=2; assert.throws(()=>decompress(invalidWidth))
  assert.throws(()=>decompress(anchorContainer.subarray(0,anchorContainer.length-1)))
  let anchorSeed=212
  const arand=()=>{anchorSeed^=anchorSeed<<13;anchorSeed^=anchorSeed>>>17;anchorSeed^=anchorSeed<<5;return anchorSeed>>>0}
  const logBytes:number[]=[]
  while(logBytes.length<72000) {
    for(let c=0;c<32;c++) logBytes.push(32+c*6+arand()%8)
    const len=arand()%45
    for(let j=0;j<len;j++){const v=arand()%256;logBytes.push(v===10?11:v)}
    logBytes.push(10)
  }
  const structuredLog=Uint8Array.from(logBytes)
  const logResult=await legacySelection(() => compressAdaptive(structuredLog))
  assert.ok(logResult.segs.some(s=>s.spec.id===ID.ANCHOR),'structured variable records should choose anchor after full validation')
  assert.ok(logResult.segs.some(s=>s.trials.some(t=>t.spec.id===ID.ANCHOR && t.fullSize!==undefined)))
  fastDeepEqual(decompress(logResult.container),structuredLog)
  const logBits=logResult.analysis.blocks.reduce((sum,bl,i)=>sum+logResult.blockCost[i]*(bl.end-bl.start),0)
  assert.ok(Math.abs(logBits-(logResult.container.length-logResult.overhead)*8)<0.1)
  assert.equal(logResult.overhead+logResult.segs.reduce((sum,sg)=>sum+sg.compLen,0),logResult.container.length)
  const randomResult=await compressAdaptive(noise)
  assert.ok(randomResult.segs.every(s=>s.spec.id!==ID.ANCHOR))
  // Zero-expansion, self-delimiting fold: exhaustive small alphabet and
  // randomized long rows, including unterminated tails and saturated columns.
  for(let len=0;len<=7;len++) for(let v=0;v<3**len;v++) {
    let x=v; const d=new Uint8Array(len)
    for(let i=0;i<len;i++) { d[i]=[0,9,32][x%3]; x=Math.floor(x/3) }
    for(const [row,r] of [[0,2],[0,3],[0,24],[0,9],[0,32],[9,9],[32,9],[9,160]]) {
      const transformed=anchorFoldFwd(d,row,r)
      assert.equal(transformed.length,d.length)
      fastDeepEqual(anchorFoldInv(transformed,row,r),d)
    }
  }
  for(let t=0;t<1200;t++) {
    const row=rand()&255, r=[2,8,24,9,32,44,58,128+8,128+44][rand()%9]
    const data=Uint8Array.from({length:rand()%1000},()=>rand()%4===0?row:rand()%3===0?(r&127):rand()&255)
    fastDeepEqual(anchorFoldInv(anchorFoldFwd(data,row,r),row,r),data)
  }
  const csv = new TextEncoder().encode('2026-01-01,INFO,host-a,123,value\n2026-01-02,WARN,host-b,456,other\n'.repeat(40))
  assert.ok(detectAnchors(csv,'text').some(a=>a.s===10 && a.r===44))
  let csvSeed=412
  const csvRand=()=>{csvSeed^=csvSeed<<13;csvSeed^=csvSeed>>>17;csvSeed^=csvSeed<<5;return csvSeed>>>0}
  const csvLines:string[]=[]
  for(let i=0;i<3000;i++) {
    const n=csvRand()
    csvLines.push(`${(n%100000000).toString().padStart(8,'0')},${['WARN','INFO','FAIL'][n%3]},${'abcde'[n%5].repeat(n%30+1)},${(csvRand()%10000000).toString().padStart(7,'0')},${'xyz'.repeat(n%4+1)}\n`)
  }
  const csvData=new TextEncoder().encode(csvLines.join(''))
  const csvPacked=await legacySelection(() => compressAdaptive(csvData))
  assert.ok(csvPacked.segs.some(s=>s.spec.id===ID.ANCHOR_FOLD || s.spec.id===ID.SUB_ANCHOR))
  assert.ok(csvPacked.container[3]===8 || csvPacked.container[3]===10 || csvPacked.container[3]===12 || csvPacked.container[3]===13)
  fastDeepEqual(decompress(csvPacked.container),csvData)
  assert.ok(csvPacked.segs.some(s=>s.trials.some(t=>t.spec.id===ID.ANCHOR_FOLD)))
  const csvBits=csvPacked.analysis.blocks.reduce((a,b,i)=>a+csvPacked.blockCost[i]*(b.end-b.start),0)
  assert.ok(Math.abs(csvBits-(csvPacked.container.length-csvPacked.overhead)*8)<0.1)
  const nullRows=new Uint8Array(2000); for(let i=0;i<nullRows.length;i++) nullRows[i]=i%20===0?0:65
  assert.ok(detectAnchors(nullRows,'binary').some(a=>a.s===0 && a.r===136))
  const foldParts=[new TextEncoder().encode('aa,bb\nccc,d\nlast'),new TextEncoder().encode('xx,yy\n,,z\nend')]
  for(const foldSpec of [{id:ID.ANCHOR_FOLD,s:10,r:44},{id:ID.ANCHOR_FOLD,s:10,r:136},{id:ID.ANCHOR_FOLD,s:0,r:136}]) {
    const foldPayload=encodeTerrainGroup(foldParts,foldSpec)
    const foldedJoined=Uint8Array.from(foldParts.flatMap(p=>[...anchorFoldFwd(p,foldSpec.s,foldSpec.r)]))
    fastDeepEqual(foldPayload,encodeCM(foldedJoined,foldSpec.r & 128 ? 'bin' : 'text'))
    const foldedCost=new Float32Array(3)
    encodeTerrainGroup(foldParts,foldSpec,undefined,{values:foldedCost,blockSize:512,ends:Uint32Array.of(5,foldParts[0].length,foldParts[0].length+foldParts[1].length)})
    assert.ok(Math.abs(foldedCost.reduce((a,b)=>a+b,0)-foldPayload.length*8)<0.1)
    fastDeepEqual(decodeTerrainGroup(foldPayload,foldParts.map(p=>p.length),foldSpec),foldParts)
    for(const part of foldParts) fastDeepEqual(decodeSpec(encodeSpec(part,foldSpec),part.length,foldSpec),part)
    const len=foldParts[0].length+foldParts[1].length+1
    // r >= 128 requires its normal varint representation in the rule dictionary.
    const valid=Uint8Array.from([85,67,90,8,...vlen(len),3,2,ID.ANCHOR_FOLD,foldSpec.s,...vlen(foldSpec.r),...vlen(foldPayload.length),ID.STORE,1,1,1,...vlen(foldParts[0].length),1,...vlen(foldParts[1].length),5,...foldPayload,99])
    fastDeepEqual(decompress(valid),Uint8Array.from([...foldParts[0],99,...foldParts[1]]))
    const old=valid.slice();old[3]=7;assert.throws(()=>decompress(old))
    assert.throws(()=>decompress(valid.subarray(0,valid.length-1)))
  }
  // Recursive peeling uses a real child terrain analysis and terminal rules only.
  const peelSpec={id:ID.PEEL,s:7,r:1}
  for(const sizes of [[0],[1],[6],[7],[8],[513,3,1001]]) {
    const parts=sizes.map((n,p)=>Uint8Array.from({length:n},(_,i)=>i%7<3?i%7:(rand()+p)&255))
    const payload=encodeTerrainGroup(parts,peelSpec)
    fastDeepEqual(decodeTerrainGroup(payload,sizes,peelSpec),parts)
    assert.throws(()=>decodeTerrainGroup(payload.subarray(0,payload.length-1),sizes,peelSpec))
    const one=encodeSpec(parts[0],peelSpec)
    fastDeepEqual(decodeSpec(one,sizes[0],peelSpec),parts[0])
    const cols=inspectPeel(one,[sizes[0]],7)
    assert.equal(cols.length,7)
    assert.equal(cols.reduce((a,c)=>a+c.rawLen,0),sizes[0])
    assert.ok(cols.every(c=>c.regions.every(r=>r.end>r.start && r.rule!=='PEEL')))
  }
  assert.throws(()=>decodeSpec(Uint8Array.of(6,1,1,5,ID.PEEL,1,0,1,0),2,{id:ID.PEEL,s:2,r:1}))
  assert.throws(()=>encodeSpec(new Uint8Array(8*1024*1024+1),peelSpec))
  let peelSeed=1234
  const peelRand=()=>{peelSeed^=peelSeed<<13;peelSeed^=peelSeed>>>17;peelSeed^=peelSeed<<5;return peelSeed>>>0}
  const width=28, rows=12000, mixedColumns=new Uint8Array(width*rows)
  for(let row=0;row<rows;row++) for(let col=0;col<width;col++) {
    const phase=Math.floor((row+col*131)/1500)%4
    mixedColumns[row*width+col]=phase===0?(col*7)&255:phase===1?peelRand()&255:phase===2?65+col%26:peelRand()&255
  }
  const peeled=await legacySelection(() => compressAdaptive(mixedColumns))
  assert.equal((await legacySelection(() => evaluatePlan(mixedColumns,peeled.segs,{alreadyMerged:true}))).totalBytes,peeled.container.length)
  // The property under test is "a record whose columns have mixed terrain is
  // modelled by splitting the columns", not "the winner is the oldest id that does
  // that". PEEL, SUB_TRANSPOSE and SUB_TRANSPOSE_V3 are three generations of the
  // same idea (and TRANSPOSE_2D is the 2-D variant); the planner is entitled to
  // prefer any of them. Measured on this fixture (full region, 336,000 B):
  //   TRANSPOSE_2D 168,943 | SUB_TRANSPOSE_V3 169,017 | SUB_TRANSPOSE 169,018
  //   PEEL 169,674 | identity BIN_V3 194,605
  // i.e. column splitting is worth 25.6 KB here, and the generations differ by 0.4%.
  const peelFamily = [ID.PEEL, ID.SUB_TRANSPOSE, ID.SUB_TRANSPOSE_V3, ID.TRANSPOSE_2D]
  assert.ok(peeled.segs.some(s=>peelFamily.includes(s.spec.id as 14|15|22|28)),
    `expected a column-splitting segment, got ${peeled.segs.map(s=>s.spec.id).join(',')}`)
  // And it must actually be a win: >10% below the best single-stream identity rule.
  assert.ok(peeled.container.length < 194605 * 0.9,
    `column splitting should beat the identity rule by a wide margin, got ${peeled.container.length}`)
  // The container version must be one that can actually carry the chosen rule.
  // 9/12/13 were the PEEL-era writers; SUB_TRANSPOSE_V3 (id 28) needs v13 and
  // TRANSPOSE_2D (id 22) needs v13+, so listing 9/12/13 hardcoded the answer for
  // one particular winner. Check the invariant instead: the version must be at
  // least what the segment table needs for this spec id, using the same ladder
  // the writer applies (codec.ts, containerVersion derivation).
  const minVersionForSpec = (id: number): number =>
    id === ID.WIDE_GRAD ? 14
    : id >= ID.TEXT_V3 ? 13
    : id >= ID.TEXT_V2 ? 12
    : id === ID.MICRO ? 11
    : (id === ID.SUB_TRANSPOSE || id === ID.SUB_ANCHOR) ? 10
    : id === ID.PEEL ? 9
    : id === ID.ANCHOR_FOLD ? 8 : 7
  const chosenPeel = peeled.segs.find(s=>peelFamily.includes(s.spec.id as 14|15|22|28))!
  assert.ok(peeled.container[3] >= minVersionForSpec(chosenPeel.spec.id),
    `v${peeled.container[3]} cannot express id ${chosenPeel.spec.id} (needs v${minVersionForSpec(chosenPeel.spec.id)})`)
  fastDeepEqual(decompress(peeled.container),mixedColumns)
  const forcedPeel=inspectPeel(encodeSpec(mixedColumns,{id:ID.PEEL,s:28,r:1}),[mixedColumns.length],28)
  assert.ok(forcedPeel.some(col=>col.regions.length>1))
  assert.ok(forcedPeel.some(col=>col.regions.some(r=>r.rule==='FILL')))
  const peelBits=peeled.analysis.blocks.reduce((a,b,i)=>a+peeled.blockCost[i]*(b.end-b.start),0)
  assert.ok(Math.abs(peelBits-(peeled.container.length-peeled.overhead)*8)<0.2)
  const downgraded=peeled.container.slice();downgraded[3]=8;assert.throws(()=>decompress(downgraded))
  // Subchannel routing: both layouts, modes and phase resets across seams.
  for(let t=0;t<60;t++) {
    const width=[2,3,7,16,28][rand()%5]
    const parts=Array.from({length:1+rand()%4},()=>Uint8Array.from({length:rand()%500},()=>rand()&255))
    for(const profile of ['bin','text'] as const) {
      const payload=encodePeeledTranspose(parts,width,profile)
      fastDeepEqual(decodePeeledTranspose(payload,parts.map(x=>x.length),width,profile),parts)
      assert.throws(()=>decodePeeledTranspose(payload.subarray(0,payload.length-1),parts.map(x=>x.length),width,profile))
    }
  }
  const modesData=Uint8Array.from({length:20*8},(_,i)=>i%8<4?(Math.floor(i/8)+i%8)&255:42)
  const groupedSub=encodePeeledTranspose([modesData],8)
  const groupedInfo=inspectPeeledTranspose(groupedSub,8)
  assert.ok(groupedInfo.grouped); assert.ok(groupedInfo.modes.includes(1)); assert.ok(groupedInfo.modes.includes(2))
  fastDeepEqual(decodePeeledTranspose(groupedSub,[modesData.length],8),[modesData])
  let indieSeed=1
  const indieRand=()=>{indieSeed^=indieSeed<<13;indieSeed^=indieSeed>>>17;indieSeed^=indieSeed<<5;return indieSeed>>>0}
  let indieData=new Uint8Array()
  for(let k=0;k<2;k++) {
    indieData=new Uint8Array(2000*8)
    const tables=Array.from({length:8},()=>Uint8Array.from({length:256},()=>indieRand()&255))
    for(let c=0;c<8;c++){let x=c;for(let i=0;i<2000;i++){x=(tables[c][x]+(i%(k+2)===0?i:0))&255;indieData[i*8+c]=x}}
  }
  const indiePayload=encodePeeledTranspose([indieData],8)
  const indieInfo=inspectPeeledTranspose(indiePayload,8)
  assert.equal(indieInfo.grouped,false)
  assert.ok(indieInfo.payloadSizes.every(n=>n<=2000))
  fastDeepEqual(decodePeeledTranspose(indiePayload,[indieData.length],8),[indieData])
  const randomColumn=Uint8Array.from({length:20000},()=>rand()&255)
  const randomSub=encodePeeledTranspose([randomColumn],4)
  assert.ok(inspectPeeledTranspose(randomSub,4).modes.includes(0))
  fastDeepEqual(decodePeeledTranspose(randomSub,[randomColumn.length],4),[randomColumn])
  const diffParts=[Uint8Array.from({length:4096},(_,i)=>Math.floor(i/4)&255),Uint8Array.from({length:4099},(_,i)=>(200+Math.floor(i/4))&255)]
  const diffSub=encodePeeledTranspose(diffParts,4)
  assert.ok(inspectPeeledTranspose(diffSub,4).modes.some(m=>m===2||m===3))
  fastDeepEqual(decodePeeledTranspose(diffSub,diffParts.map(x=>x.length),4),diffParts)
  const anchorParts=[0,1,2].map(m=>Uint8Array.from({length:12000},(_,i)=>i%4===0?((Math.floor(i/4)+m*23)&255):i%4===1?((Math.floor(i/4)*3+m)&255):i%4===2?0:10))
  for(const r of [8,136,44,172]) {
    const packed=encodePeeledAnchor(anchorParts,10,r)
    fastDeepEqual(decodePeeledAnchor(packed,anchorParts.map(x=>x.length),10,r),anchorParts)
    assert.throws(()=>decodePeeledAnchor(packed.subarray(0,packed.length-1),anchorParts.map(x=>x.length),10,r))
    if((r&127)===8) assert.ok(inspectPeeledAnchor(packed,anchorParts.map(x=>x.length),r).channels.some(c=>c.mode===3))
  }
  // Explicit grid stream with mode-3 DELTA, proving boundaries can be
  // recovered while inverse delta is running and reset at every region.
  const gridParts=[new TextEncoder().encode('A,X\nB,Y\n'),new TextEncoder().encode('C,Z\n')]
  const col0=[Uint8Array.of(65,44,66,44),Uint8Array.of(67,44)]
  const col1=[Uint8Array.of(88,10,89,10),Uint8Array.of(90,10)]
  const colPayload=(xs:Uint8Array[])=>encodeCM(Uint8Array.from(xs.flatMap(x=>[...deltaFwd(x,1)])),'bin')
  const cp0=colPayload(col0),cp1=colPayload(col1)
  const gridEncoded=Uint8Array.from([0,2,0,1,3,6,3,...vlen(cp0.length),...cp0,6,3,...vlen(cp1.length),...cp1,0,0])
  fastDeepEqual(decodePeeledAnchor(gridEncoded,gridParts.map(x=>x.length),10,44),gridParts)
  for(let t=0;t<100;t++) {
    const row=[0,10,60,255][rand()%4], r=[2,8,24,9,44,62,136,172,190][rand()%9]
    if((r&127)===row && ((r&127)>=32||(r&127)===9))continue
    const parts=Array.from({length:1+rand()%4},()=>Uint8Array.from({length:rand()%180},()=>rand()%4===0?row:rand()%4===0?r&127:rand()&255))
    const packed=encodePeeledAnchor(parts,row,r)
    fastDeepEqual(decodePeeledAnchor(packed,parts.map(x=>x.length),row,r),parts)
  }
  let subSeed=234
  const subRand=()=>{subSeed^=subSeed<<13;subSeed^=subSeed>>>17;subSeed^=subSeed<<5;return subSeed>>>0}
  const routedData=new Uint8Array(16*8000)
  for(let i=0;i<8000;i++) for(let c=0;c<16;c++) routedData[i*16+c]=c<4?(i*(c+1)+Math.floor(i/500))&255:c<8?subRand()&255:c<12?c*7:(i>>(c-10))&255
  const routed=await legacySelection(() => compressAdaptive(routedData))
  assert.equal((await legacySelection(() => evaluatePlan(routedData,routed.segs,{alreadyMerged:true}))).totalBytes,routed.container.length)
  assert.ok(routed.segs.some(s=>s.spec.id===ID.SUB_TRANSPOSE || s.spec.id===ID.SUB_TRANSPOSE_V3))
  assert.ok(routed.container[3]===10 || routed.container[3]===12 || routed.container[3]===13)
  assert.ok(routed.segs.some(s=>s.subPeel && 'modes' in s.subPeel && s.subPeel.modes.includes(0)))
  fastDeepEqual(decompress(routed.container),routedData)
  const routedBits=routed.analysis.blocks.reduce((sum,b,i)=>sum+routed.blockCost[i]*(b.end-b.start),0)
  assert.ok(Math.abs(routedBits-(routed.container.length-routed.overhead)*8)<0.2)
  for(const subSpec of [{id:ID.SUB_TRANSPOSE,s:4,r:2},{id:ID.SUB_ANCHOR,s:10,r:8}]) {
    const parts=[Uint8Array.from({length:513},(_,i)=>i%7===0?10:i&255),Uint8Array.from({length:1001},(_,i)=>i%13===0?10:(i*7)&255)]
    const payload=encodeTerrainGroup(parts,subSpec)
    fastDeepEqual(decodeTerrainGroup(payload,parts.map(p=>p.length),subSpec),parts)
    const bits=new Float32Array(3)
    encodeTerrainGroup(parts,subSpec,undefined,{values:bits,blockSize:512,ends:Uint32Array.of(513,1024,1514)})
    assert.ok(Math.abs(bits.reduce((a,b)=>a+b,0)-payload.length*8)<0.1)
    const total=parts[0].length+parts[1].length+1
    const container=Uint8Array.from([85,67,90,10,...vlen(total),3,2,subSpec.id,subSpec.s,...vlen(subSpec.r),...vlen(payload.length),ID.STORE,1,1,1,...vlen(parts[0].length),1,...vlen(parts[1].length),5,...payload,99])
    fastDeepEqual(decompress(container),Uint8Array.from([...parts[0],99,...parts[1]]))
    const v9=container.slice();v9[3]=9;assert.throws(()=>decompress(v9))
  }
  // 可视化不得按区域数分配每个区域完整的 256×256 表。
  const map = buildMapModel(Uint8Array.of(1), 512, Float32Array.of(1), Int32Array.of(40000))
  assert.equal(map.seg[0], 40000)
  const manyData = new Uint8Array(20000).fill(42)
  const manySegs = Array.from({length:10000}, (_,i) => ({start:i*2,end:i*2+2}))
  const colors = manySegs.map(() => [100,150,200])
  let rendered = false
  const fakeContext = { createImageData: (w:number,h:number) => ({data:new Uint8ClampedArray(w*h*4)}), putImageData: () => { rendered = true } }
  const fakeCanvas = {width:0,height:0,getContext: () => fakeContext} as unknown as HTMLCanvasElement
  drawDigram(fakeCanvas, manyData, manySegs, colors, -1)
  assert.ok(rendered)
  // 旧版 1.5 MB 限制已移除；超过 10 MiB 时默认明确跳过。
  assert.notEqual(singleModelSize(new Uint8Array(1_500_001)), null)
  assert.equal(singleModelSize(new Uint8Array(10 * 1024 * 1024 + 1)), null)
  // 聚合模型代价须与逐字节代价求和一致，尾块不足 512 字节。
  const sampleBytes = Uint8Array.from({ length: 1803 }, () => rand() & 255)
  const costs = new Float32Array(sampleBytes.length), blockCosts = new Float32Array(Math.ceil(sampleBytes.length / 512))
  const p1 = encodeCM(sampleBytes, 'bin', 1, 1, costs)
  const p2 = encodeCM(sampleBytes, 'bin', 1, 1, undefined, 0, {values:blockCosts, blockSize:512})
  fastDeepEqual(p1, p2)
  for (let b = 0; b < blockCosts.length; b++) {
    const sum = costs.subarray(b*512, (b+1)*512).reduce((x,y) => x+y, 0)
    assert.ok(Math.abs(sum - blockCosts[b]) < 0.02)
  }
  const shortRow = Uint8Array.from({length:24}, () => rand() & 255)
  const shortGrid = Uint8Array.from({length:24*60}, (_,i) => shortRow[i % 24])
  assert.equal(detectLag(shortGrid, 3), 24)
  const sample = await legacySelection(() => compressAdaptive(SAMPLES[0].make().data))
  const image = sample.segs[0]
  const gradient = image.trials.find(t => t.spec.id === ID.GRAD && t.spec.r === 384)
  assert.ok(gradient, 'BMP region must trial GRAD-2D at width 384')
  assert.ok(image.label === 'DELTA(步长3)' || image.label === 'GRAD-2D2(步长3, 行384)' || image.label === 'GRAD-2D3(步长3, 行384)' || image.label === 'DELTA3(步长3)')
  assert.ok(gradient.payloadSize! > image.trials.find(t => t.spec.id === ID.DELTA && t.spec.s === 3)!.payloadSize!)
  // ---- P0 hardening: decode allocation cap, transpose single-pass, CM unify ----
  {
    // A forged header must be rejected before the output buffer is allocated.
    const put=(v:number)=>{const a:number[]=[];while(v>=128){a.push((v%128)|128);v=Math.floor(v/128)}a.push(v);return a}
    const forged=(n:number)=>Uint8Array.from([85,67,90,14,...put(n),...put(1)])
    assert.throws(()=>decompress(forged(MAX_OUTPUT_BYTES+1)),/超过上限/)
    assert.throws(()=>decompress(forged(1024*1024*1024)),/超过上限/)
    assert.throws(()=>decompress(forged(2**40)),/超过上限/)
    // The limit is overridable, and the header claim still has to match the data.
    assert.throws(()=>decompress(forged(4096),undefined,4096),/截断|长度/)
    assert.throws(()=>decompress(forged(1024),undefined,512),/超过上限/)
    const ok=await compressAdaptive(text)
    fastDeepEqual(decompress(ok.container, undefined, text.length), text)
  }
  {
    // Transpose plan: the legacy grouped stream is encoded once and its column
    // weights are reused for the cost map, so bytes and cost bins are identical
    // whether or not a cost buffer is requested.
    const parts=[Uint8Array.from({length:96*40},(_,i)=>(i*7+(i%96===0?13:0))&255)]
    const withCosts={values:new Float32Array(40),blockSize:96,ends:Uint32Array.from({length:40},(_,i)=>(i+1)*96)}
    const plain=encodeTerrainGroup(parts,{id:ID.TRANSPOSE_GROUP,s:4,r:1})
    const costed=encodeTerrainGroup(parts,{id:ID.TRANSPOSE_GROUP,s:4,r:1},undefined,withCosts)
    fastDeepEqual(costed,plain)
    assert.ok(withCosts.values.some(v=>v>0),'代价仓必须被填充')
    const picks=[{start:0,end:parts[0].length,cls:'binary' as Cls,spec:{id:ID.TRANSPOSE_GROUP,s:4,r:1}}]
    fastDeepEqual(evaluatePlan(parts[0],picks),evaluatePlan(parts[0],picks))
  }
  {
    // Family unify only rewrites when the unified payload is strictly smaller.
    const family=CM_FAMILIES.find(f=>f.name==='TEXT')!
    const rep=(ch:string,n:number)=>Uint8Array.from(new TextEncoder().encode(ch.repeat(n)))
    // Unified sizes measured with the same call the encoder uses.
    const measure=(id:number,parts:Uint8Array[])=>{
      const joined=new Uint8Array(parts.reduce((a,p)=>a+p.length,0));let pos=0
      for(const p of parts){joined.set(p,pos);pos+=p.length}
      const enc=CM_ENCODING[id]
      return encodeCM(joined,enc.profile,1,1,undefined,0,undefined,undefined,enc.variant).length
    }
    const a=rep('the quick brown fox jumps over the lazy dog. ',1200)
    const b=rep('pack my box with five dozen liquor jugs. ',900)
    assert.equal(family.target,ID.TEXT_V3)
    assert.ok(measure(family.target,[a,b]) < measure(ID.TEXT,[a])+measure(ID.TEXT_V2,[b]))
    assert.ok(family.members.every(id=>CM_ENCODING[id]!==undefined))
    assert.equal(isFamilyCM(ID.DELTA),false,'带参数的规则不得进入归一族')
    assert.equal(isFamilyCM(ID.ANCHOR_FOLD),false)
  }
  // ---- P1: 并行与串行必须逐字节等价 ----
  {
    // 构造多区域数据：交替的文本段与二进制段，能触发多种规则与 anchor 候选。
    const textPart = new TextEncoder().encode('the quick brown fox jumps over the lazy dog. '.repeat(900))
    const binPart = Uint8Array.from({ length: 40000 }, (_, i) => (i * 37 + (i >>> 5)) & 255)
    const mix = new Uint8Array(textPart.length * 2 + binPart.length * 2)
    mix.set(textPart, 0)
    mix.set(binPart, textPart.length)
    mix.set(textPart.slice().reverse(), textPart.length + binPart.length)
    mix.set(binPart.slice().reverse(), textPart.length * 2 + binPart.length)
    const serial = await compressAdaptive(mix, undefined, { serial: true })
    const parallel = await compressAdaptive(mix)
    fastDeepEqual(parallel.container, serial.container, '并行与串行产物必须逐字节一致')
    fastDeepEqual(decompress(parallel.container), mix)
    // 线程数解析：UCZ_THREADS 可覆盖，非法值被忽略。
    const saved = process.env.UCZ_THREADS
    try {
      process.env.UCZ_THREADS = '3'
      // 环境无关：线程数还受可用核数与该机内存上限约束（小内存机器上 memorySafeThreads()
      // 可能返回 1..2），所以只断言"请求被尊重到环境允许的上限"，不写死 3。
      assert.equal(threadCount(), Math.min(Math.min(Math.max(1, availableParallelism()), 8), memorySafeThreads(), 3))
      process.env.UCZ_THREADS = 'abc'
      assert.ok(threadCount() >= 1)
    } finally {
      if (saved === undefined) delete process.env.UCZ_THREADS
      else process.env.UCZ_THREADS = saved
    }
    // LPT 静态均衡：所有任务都必须被分配到某个桶里，且划分与运行速度无关。
    const buckets = lptAssign([5, 4, 3, 2, 1], 2)
    fastDeepEqual(buckets.flat().sort((a, b) => a - b), [0, 1, 2, 3, 4])
    fastDeepEqual(lptAssign([5, 4, 3, 2, 1], 2), lptAssign([5, 4, 3, 2, 1], 2))
  }
  // ---- P4-3：v15 / WORD-PRE 候选由 worker 与 v13 载荷一次算好 ----
  // 并行分组路径不再"worker 算一遍 v13、主线程再算一遍 v15"。候选改为跨线程
  // 回传后，择优判据必须与串行完全一致：容器逐字节相同。
  {
    // 确定性伪自然语言（词表 3000）+ 二进制尾段：两个分组，且文本分组会走
    // CM 的 v15 候选路径（V15_PROFILES 覆盖 TEXT/TEXT_V2/TEXT_V3）。
    let st = 20261107
    const rnd = () => { st ^= st << 13; st ^= st >>> 17; st ^= st << 5; return st >>> 0 }
    const cons = 'bcdfghjklmnprstvwz', vows = 'aeiou', vocab: string[] = []
    for (let i = 0; i < 3000; i++) {
      let w = ''
      for (let k = 0, m = 2 + (rnd() % 3); k < m; k++) w += cons[rnd() % cons.length] + vows[rnd() % vows.length]
      vocab.push(w)
    }
    let txt = ''
    while (txt.length < 700000) {
      const n = 5 + (rnd() % 12)
      for (let i = 0; i < n; i++) txt += (i ? ' ' : '') + vocab[rnd() % vocab.length]
      txt += (rnd() & 1 ? '. ' : ', ')
      if ((rnd() % 9) === 0) txt += '\n'
    }
    const head = new TextEncoder().encode(txt)
    const bin = Uint8Array.from({ length: 150000 }, (_, i) => (i * 131 + (i >>> 4)) & 255)
    const input = new Uint8Array(head.length + bin.length)
    input.set(head, 0); input.set(bin, head.length)
    assert.ok(input.length > 512 * 1024, '样本必须大到值得并行')
    const serial = await compressAdaptive(input, undefined, { serial: true })
    const parallel = await compressAdaptive(input)
    fastDeepEqual(parallel.container, serial.container, 'P4-3 并行与串行产物必须逐字节相同')
    fastDeepEqual(decompress(parallel.container), input)
    // worker 与主线程共用同一份候选实现（groupV15CandidatesSync）：对双流覆盖的
    // 规则，候选必须与"单跑一遍 v15"逐字节相同，否则择优会因候选来源而漂移。
    const body = new TextEncoder().encode('the quick brown fox jumps over the lazy dog. '.repeat(600))
    const parts = [body.subarray(0, 12000), body.subarray(12000)]
    for (const spec of [{ id: ID.TEXT_V3, s: 1, r: 1 }, { id: ID.GRAD_V3, s: 4, r: 64 }, { id: ID.TEXT, s: 1, r: 1 }]) {
      const cand = groupV15CandidatesSync(parts, spec, [0, 12000])
      assert.ok(cand && cand.alt, `候选必须存在 (${spec.id})`)
      fastDeepEqual(cand!.alt, encodeTerrainGroup(parts, spec, undefined, undefined, undefined, [0, 12000], 'v15'),
        `候选必须与单跑 v15 逐字节相同 (${spec.id})`)
    }
  }
  // P3-1：单遍双算术编码器必须与"跑两遍 encodeCM"逐字节相同。
  {
    const sample = new Uint8Array(3000)
    for (let i = 0; i < sample.length; i++) sample[i] = (i * 37 + (i >> 3)) & 255
    for (const [profile, s, r] of [['text', 1, 1], ['bin', 1, 1], ['res2d', 4, 64]] as const) {
      const dual = encodeCMDual(sample, profile as Profile, s, r, 'v15', 0)
      const ref13 = encodeCM(sample, profile as Profile, s, r, undefined, 0, undefined, undefined, 'v13', 0)
      const ref15 = encodeCM(sample, profile as Profile, s, r, undefined, 0, undefined, undefined, 'v15', 0)
      fastDeepEqual(dual.base, ref13, `双流 v13 流必须与单跑一致 (${profile})`)
      fastDeepEqual(dual.alt, ref15, `双流 v15 流必须与单跑一致 (${profile})`)
      // 两条流都能自解码
      fastDeepEqual(decodeCMapm(dual.alt, sample.length, profile as Profile, s, r, undefined, 'v15', 0), sample)
    }
  }
  // P7-0：旧 v1 容器里 STORE 段的长度校验。
  // 手工拼一个 v1 容器（头 = UCZ + version=1 + varint(n) + varint(cnt)，
  // 段 = id, [s,r], varint(rawLen), varint(pl), payload），所有数值 < 128
  // 所以 varint 就是单字节。
  {
    const v1 = (rawLen: number, body: number[]) => Uint8Array.from([
      0x55, 0x43, 0x5a, 0x01, rawLen, 0x01, 0x00, rawLen, body.length, ...body,
    ])
    fastDeepEqual([...decompress(v1(4, [1, 2, 3, 4]))], [1, 2, 3, 4], 'v1 STORE 正常载荷必须能解')
    assert.throws(() => decompress(v1(4, [1, 2])), /corrupt v1 store payload/, 'v1 STORE 截短必须报错')
  }
  // P7-0 / P9-4.1：a2 的精确门控。
  //   * bin 上启用；res 上启用（1D 残差是正收益，P7-0 找回 1,722 B）；
  //   * res2d 上禁用（mr / x-ray 的 MED 行预测，P5 实测 mr −13,923 B）；
  //   * raw text 默认保留 a2；WORD-PRE 默认关闭，显式 textOn=false 关闭全部 text；
  //     实际使用的新语义以 v19 明示，v15 / v17 / v18 按版本分流。
  //   * D16 / WIDE_GRAD 虽然内层同样是 ('res', 2, 1)，但必须按 **spec.id** 关掉
  //     （xray2m 上差 945 B、整份 x-ray 4,479 B）。
  //
  // 这条测试守的是**接线可达性**，不是"某个 profile 一定要开 a2"：
  // 所以 text 要按旋钮的两个位置分别断言，旋钮本身被误删/写反时两侧都会失败。
  {
    const body = new Uint8Array(6000)
    for (let i = 0; i < body.length; i++) body[i] = (i * 37 + (i >> 3)) & 255
    const enc = (prof: Profile, s: number, r: number) =>
      encodeCM(body, prof, s, r, undefined, 0, undefined, undefined, 'v15', 0)
    const sweep = () => {
      const on = { res2d: enc('res2d', 4, 64), res: enc('res', 2, 1), text: enc('text', 1, 1), bin: enc('bin', 1, 1),
        d16: encodeTerrainGroup([body], { id: ID.D16, s: 1, r: 1 }, undefined, undefined, undefined, [0]).length,
        wg: encodeTerrainGroup([body], { id: ID.WIDE_GRAD, s: 1, r: 512 }, undefined, undefined, undefined, [0]).length }
      apm2Tuning.on = false
      const off = { res2d: enc('res2d', 4, 64), res: enc('res', 2, 1), text: enc('text', 1, 1), bin: enc('bin', 1, 1),
        d16: encodeTerrainGroup([body], { id: ID.D16, s: 1, r: 1 }, undefined, undefined, undefined, [0]).length,
        wg: encodeTerrainGroup([body], { id: ID.WIDE_GRAD, s: 1, r: 512 }, undefined, undefined, undefined, [0]).length }
      apm2Tuning.on = true
      return { on, off }
    }
    const keepText = a2Tuning.textOn
    try {
      // ---- 位置 1：text 开 a2（P7 行为）----
      a2Tuning.textOn = true
      {
        const { on, off } = sweep()
        fastDeepEqual(on.res2d, off.res2d, 'res2d 不得启用 a2（否则 mr 会回退）')
        assert.notDeepEqual(on.res, off.res, 'res 上 a2 必须生效（P7-0 找回 1,722 B）')
        assert.notDeepEqual(on.text, off.text, 'a2Tuning.textOn=true 时 text 上 a2 必须生效')
        assert.notDeepEqual(on.bin, off.bin, 'bin 上 a2 必须生效')
        assert.equal(on.d16, off.d16, 'D16 必须按 spec.id 关掉 a2')
        assert.equal(on.wg, off.wg, 'WIDE_GRAD 必须按 spec.id 关掉 a2')
      }
      // ---- 位置 2：text 关 a2（P9-4.1 默认）----
      a2Tuning.textOn = false
      {
        const { on, off } = sweep()
        fastDeepEqual(on.text, off.text, 'a2Tuning.textOn=false 时 text 上必须完全不启用 a2')
        // 关掉 text 不得连带影响其它 profile 的接线。
        assert.notDeepEqual(on.res, off.res, '关掉 text 的 a2 不得影响 res')
        assert.notDeepEqual(on.bin, off.bin, '关掉 text 的 a2 不得影响 bin')
        fastDeepEqual(on.res2d, off.res2d, 'res2d 仍不得启用 a2')
      }
      // 两个位置必须产出**不同**的 text 载荷，否则旋钮根本没接到 a2Eligible 上。
      a2Tuning.textOn = true
      const textEnabled = enc('text', 1, 1)
      a2Tuning.textOn = false
      const textDisabled = enc('text', 1, 1)
      assert.notDeepEqual(textEnabled, textDisabled, 'a2Tuning.textOn 旋钮必须真的改变 text 载荷')
    } finally {
      a2Tuning.textOn = keepText
      apm2Tuning.on = true
    }
  }
  // P5-4：LZ-PRE 是实测证伪的预变换，但它仍被分组级 A/B 引用，必须严格可逆。
  // （P5-2 的 WORD-PRE v2 双层词表与分块路径从未被 src/ 调用，已随 P37.12 删除。）
  {
    const sample = new TextEncoder().encode('the quick brown fox jumps over the lazy dog. '.repeat(400))
    const lz = lzPreFwd(sample)
    fastDeepEqual(lzPreInv(lz.body, sample.length, lz.esc), sample, 'LZ-PRE 必须可逆')
    const esc = Uint8Array.from({ length: 4096 }, (_, i) => (i % 7 === 0 ? 0x9c : (i * 31) & 127))
    const lz2 = lzPreFwd(esc)
    fastDeepEqual(lzPreInv(lz2.body, esc.length, lz2.esc), esc, 'LZ-PRE 必须正确处理转义字节')
  }
  // P3-2：词元预坍缩必须严格可逆，且解码只依赖词典头。
  {
    const text = new TextEncoder().encode('<aaa><bbb>x</aaa><aaa><bbb>y</aaa>'.repeat(200) + '\u00ff\u0080')
    const pre = wordPreFwd(text)
    assert.ok(pre && pre.dict.length > 0, '应能选出词元')
    fastDeepEqual(wordPreInv(pre!.header, pre!.body, text.length), text, '词元坍缩必须可逆')
    // 词典头本身可独立解析：把同一个头换到别处仍能解
    const pre2 = wordPreFwd(text)!
    fastDeepEqual(wordPreInv(pre2.header, pre2.body, text.length), text)
    // 没有可用词元的输入返回 null
    const rand = new Uint8Array(512)
    for (let i = 0; i < rand.length; i++) rand[i] = (i * 173 + 91) & 255
    const dict = buildTokenDict(rand, 120)
    assert.equal(dict.length, 0, '随机数据不该选出词元')
  }
  await testManifoldUniversality()
  await testStrictProfileInvariance()
  await testConcurrencyAndChecksum()
  await testDefaultProfileSurvivesPermutation(); await testScientificInstruments(); await testEdgeCases()
  console.log('codec tests passed')
}
test().catch(e => { console.error(e); process.exitCode = 1 })
