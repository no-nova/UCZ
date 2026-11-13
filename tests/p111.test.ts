import assert from 'node:assert/strict'
import { fastDeepEqual } from './fast-equal'
import {createHash} from 'node:crypto'
import historical from './p111-references.json'
import wordReference from './p111-wordpre-reference.json'
import e24 from './e24-v17-fixture.json'
import {compatibilityInputs,rawCompatibilityInput} from './p111-inputs'
import {compressAdaptive,compressGuardedPlanForProbe,decompress,ID,planHeader,
  withChooseSpecPolicy,parallelReport,type GroupJobRunner} from '../src/lib/codec'
import {cmTableShape,withCMBlockSize,withContainerModel,modelTuning,encodeCM,decodeCM,
  V19_FLAG_MHT4_20} from '../src/lib/coder'
import {payloadModelFlags} from '../src/lib/payload-model'
import {encodeGroupForJob} from '../src/lib/codec-jobs'
import {runParallelJobs,closePool} from '../src/lib/parallel-pool'

const eq=(a:Uint8Array,b:Uint8Array)=>fastDeepEqual(Buffer.from(a),Buffer.from(b))
const sha=(x:Uint8Array)=>createHash('sha256').update(x).digest('hex')
const MiB=1024*1024
/** Independent historical bytes + real current serializer/worker tests.
 * No actual input exceeds 48 KiB. Raw model parents/boundaries are virtual. */
export async function testP111(onlyCase?:string){
 const saved={threads:process.env.UCZ_THREADS,parallel:{...parallelReport},model:{...modelTuning}}
 let checks=0
 const rows:{name:string;inputBytes:number;p10Bytes:number;currentBytes:number;sha256:string;version:number}[]=[]
 try{
  assert.equal(historical.references.p10.commit,'d4bf4d836aec2616b53ee79fc1f628f00ab93bce')
  assert.equal(historical.references.p11.commit,'147b778e427fe4b27677d6b9c48b435a0c296e6c')
  const inputs=compatibilityInputs()
  const golden=[...historical.references.p10.containers,...wordReference.references.p10.containers]
  assert.equal(golden.length,inputs.length)
  process.env.UCZ_THREADS='2'
  let workerBatches=0
  const runner:GroupJobRunner=async(jobs,loads,data)=>{
   assert.ok(data.length<=49152)
   const replies=await runParallelJobs(jobs,loads.map(n=>Math.max(n,512*1024)),data)
   assert.ok(replies,'Must exercise real workers, not fallback')
   workerBatches++;return replies
  }
  if(onlyCase)assert.ok(golden.some(g=>g.name===onlyCase),'unknown compatibility case')
  for(const g of golden.filter(g=>!onlyCase||g.name===onlyCase)){
   const c=inputs.find(x=>x.name===g.name)!
   assert.ok(c);assert.equal(c.data.length,g.inputBytes);assert.equal(sha(c.data),g.inputSha256)
   const expected=Buffer.from(g.base64,'base64')
   assert.equal(expected.length,g.bytes);assert.equal(sha(expected),g.sha256)
   eq(decompress(expected),c.data)
   const result=c.picks?await compressGuardedPlanForProbe(c.data,c.picks,{serial:true}):await compressAdaptive(c.data,undefined,{serial:true})
   // P12 changes the encoder (dictionary, transforms, and optional new CM),
   // not the meaning of these frozen historical bytes. Retain their decode
   // proof; test current output per-fixture size/roundtrip and exact worker parity.
   assert.ok(result.container.length<=expected.length,`${g.name}: current writer must not regress this fixture`)
   eq(decompress(result.container),c.data)
   for(const kind of ['orphan','macro'] as const){
    const after=kind==='orphan'?result.orphanComparison:result.macroComparison
    if(!after)continue
    assert.equal(after.error,undefined)
    if(after.candidateBytes!==null){
     assert.notEqual(after.candidateHeaderBytes,null)
     const better=after.candidateBytes<after.baselineBytes
      && (kind==='macro'||after.candidateBytes-after.candidateHeaderBytes!<after.baselineBytes-after.baselineHeaderBytes)
     assert.equal(after.accepted,better,`${g.name}/${kind}/strict complete cost`)
    }else assert.equal(after.accepted,false)
   }
   if(c.picks && c.picks.length>1){
    // Injected runner bypasses the production lazy-pool facade; own its
    // per-file lifecycle just as compressAdaptive does for the real pool.
    try {
     const parallel=await compressGuardedPlanForProbe(c.data,c.picks,{runJobs:runner})
     eq(parallel.container,result.container);fastDeepEqual(parallel.blockCost,result.blockCost)
     assert.equal(parallel.guardStats!.workerFallbacks,0)
    } finally { await closePool() }
   }
   rows.push({name:c.name,inputBytes:c.data.length,p10Bytes:g.bytes,currentBytes:result.container.length,sha256:sha(result.container),version:result.container[3]})
   checks++
  }
  if(onlyCase){console.log(`P11.1/P12 current writer + frozen decode ${onlyCase} PASS (${rows[0].p10Bytes} -> ${rows[0].currentBytes} B)`);return {checks,containers:rows,workerBatches}}
  assert.ok(workerBatches>0)

  // 512 KiB/full chooseSpec rechecks are P10-compatible ONLY for a whole input
  // below 8 MiB. A small segment of a large file must still use the P11 cap.
  const sample=512*1024
  const smallPolicy=withCMBlockSize(16*MiB,()=>withChooseSpecPolicy(8*MiB-1,()=>cmTableShape(sample)))
  const largePolicy=withCMBlockSize(16*MiB,()=>withChooseSpecPolicy(8*MiB,()=>cmTableShape(sample)))
  fastDeepEqual([smallPolicy.cmBits,smallPolicy.mht4Bits,smallPolicy.mht8Bits],[22,20,21])
  fastDeepEqual([largePolicy.cmBits,largePolicy.mht4Bits,largePolicy.mht8Bits],[21,20,20])
  assert.throws(()=>withChooseSpecPolicy(-1,()=>0),/输入长度/)
  assert.throws(()=>withChooseSpecPolicy(8*MiB,()=>{throw Error('restore')}),/restore/)
  assert.equal(cmTableShape(sample).cmBits,22)
  checks++

  // Real raw-model bytes from the independent P10 encoder at two virtual tiers.
  const tiny=rawCompatibilityInput()
  for(const g of historical.references.p10.models){
   assert.equal(sha(tiny),g.inputSha256)
   const shape=withCMBlockSize(g.scope,()=>cmTableShape(tiny.length))
   fastDeepEqual(shape,g.geometry)
   const current=withCMBlockSize(g.scope,()=>encodeCM(tiny,'bin',1,1,undefined,0,undefined,undefined,'v15'))
   const expected=Buffer.from(g.base64,'base64')
   assert.equal(sha(expected),g.sha256);eq(current,expected)
   assert.equal(payloadModelFlags(current),g.flags)
   eq(withContainerModel(18,g.flags,()=>withCMBlockSize(g.scope,()=>decodeCM(expected,tiny.length,'bin',1,1,undefined,'v15'))),tiny)
   checks++
  }
  // Genuine pre-correction v19 stream, not new encode/decode self-validation.
  // Runtime encoder settings intentionally disagree with the archived model.
  Object.assign(modelTuning,{maxTableBits:21,matchTableBits:20})
  for(const g of historical.references.p11.models){
   const expected=Buffer.from(g.base64,'base64')
   assert.equal(sha(expected),g.sha256)
   fastDeepEqual(withContainerModel(19,g.flags,()=>withCMBlockSize(g.scope,()=>cmTableShape(tiny.length))),g.geometry)
   eq(withContainerModel(19,g.flags,()=>withCMBlockSize(g.scope,()=>decodeCM(expected,tiny.length,'bin',1,1,undefined,'v15'))),tiny)
   checks++
  }
  Object.assign(modelTuning,saved.model)
  for(const [scope,flags,old4] of [[512*1024,10,21],[4*MiB,20,22]]){
   assert.equal(withContainerModel(19,flags,()=>withCMBlockSize(scope,()=>cmTableShape(128))).mht4Bits,old4)
   assert.equal(withContainerModel(18,flags,()=>withCMBlockSize(scope,()=>cmTableShape(128))).mht4Bits,20)
  }
  assert.equal(withContainerModel(19,0x300|V19_FLAG_MHT4_20,()=>withCMBlockSize(8*MiB,()=>cmTableShape(128))).mht4Bits,20)
  for(const flags of [0x400,0x800,0x180])assert.throws(()=>withContainerModel(19,flags,()=>0),/v19/)
  checks++

  const spec={id:ID.BIN_V3,s:1,r:1},n=100
  const segs=[{start:0,end:n,cls:'binary' as const,spec}]
  const header=(flags:number)=>planHeader(n,segs,[{spec,members:[0],payload:{length:10},modelFlags:flags}])
  const none=header(0);assert.equal(none[3],13)
  for(const flags of [1,2,4,8,16,32,64,128,10,20,74]){
   const h=header(flags);assert.equal(h[3],18);assert.equal(h[4],flags)
   assert.equal(h.length,none.length+1);fastDeepEqual(h.slice(5),none.slice(4))
  }
  for(const flags of [0x500,0x600,0x700]){
   const h=header(flags);assert.equal(h[3],19);assert.equal(h[4]|h[5]<<8,flags)
   assert.equal(h.length,none.length+2);fastDeepEqual(h.slice(6),none.slice(4))
  }
  checks++

  // P12.0 changes the encoder dictionary and turns token a2 on. Keep the
  // independently archived v17/v18 off-flag stream as a DECODE fixture; the
  // current encoder must emit/roundtrip its own selected payload instead.
  const wpCase=inputs.find(x=>x.name==='guarded-wordpre')!,text={id:ID.TEXT_V3,s:1,r:1}
  const wp=encodeGroupForJob([wpCase.data],text,[0],[wpCase.data.length]).cand!.wordPre!
  assert.ok(wp); assert.equal(payloadModelFlags(wp),0)
  const h=planHeader(wpCase.data.length,[{start:0,end:wpCase.data.length,cls:'text',spec:text}],
   [{spec:text,members:[0],payload:wp,v15:true,wordPre:true}])
  assert.equal(h[3],15)
  const packed=Uint8Array.from([...h,...wp]),mapped=Buffer.from(e24.containerBase64,'base64')
  mapped[3]=18;mapped[4]=64
  eq(decompress(mapped),wpCase.data);eq(decompress(packed),wpCase.data)
  checks++
  console.log(`P11.1 tests passed (${checks} checks; 6 frozen P10 decode/current writer fixtures; <=48 KiB inputs; archived v19 decode; compact v18 writer)`)
  return {checks,maxActualInputBytes:49152,containers:rows,workerBatches,smallPolicy,largePolicy,
   wordPreWriter:{inputBytes:wpCase.data.length,bytes:packed.length,version:packed[3],flags:packed[4],sha256:sha(packed)},
   historicalRawModels:{p10:historical.references.p10.models.map(g=>({scope:g.scope,geometry:g.geometry,flags:g.flags})),p11:historical.references.p11.models.map(g=>({scope:g.scope,geometry:g.geometry,flags:g.flags}))},
   note:'Frozen historical decode, current small-input per-fixture nonregression/worker equality, and virtual policy/model tests only. No P11.1 corpus sizes or throughput measurements.'}
 }finally{
  Object.assign(modelTuning,saved.model);Object.assign(parallelReport,saved.parallel)
  if(saved.threads===undefined)delete process.env.UCZ_THREADS;else process.env.UCZ_THREADS=saved.threads
  await closePool()
 }
}
