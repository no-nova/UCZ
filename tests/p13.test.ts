import assert from 'node:assert/strict'
import { fastDeepEqual } from './fast-equal'
import { Worker } from 'node:worker_threads'
import { groupKernelSample, clearProbeWinners, GROUP_KERNEL_MIN_BYTES, GROUP_KERNEL_PROBE_BYTES } from '../src/lib/group-policy'
import { ID, groupV15CandidatesSync, encodeTerrainGroup, planHeader, decompress, planTuning, compressCachedPlansForProbe, compressGuardedPlanForProbe, evaluatePlan, type PlanSegment } from '../src/lib/codec'
import { encodeGroupForJob } from '../src/lib/codec-jobs'
import { PARALLEL_WORKER_CODE } from '../src/lib/parallel-worker-code'
const eq=(a:Uint8Array,b:Uint8Array)=>fastDeepEqual(Buffer.from(a),Buffer.from(b))
function binary(n=GROUP_KERNEL_MIN_BYTES) {
  let seed=123456789
  const d=new Uint8Array(n)
  for(let i=0;i<n;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;d[i]=(i%64<56?i%17:seed>>>24)}
  return d
}
function frame(data:Uint8Array,payload:Uint8Array,apm:boolean,spec={id:ID.BIN_V3 as number,s:1,r:1},wordPre=false) {
  const h=Uint8Array.from(planHeader(data.length,[{start:0,end:data.length,cls:'binary',spec}],[{spec,members:[0],payload,v15:apm,wordPre}]))
  const c=new Uint8Array(h.length+payload.length);c.set(h);c.set(payload,h.length);eq(decompress(c),data);return c
}
export function testPolicy() {
  fastDeepEqual(clearProbeWinners([100000,100151]),[0])
  fastDeepEqual(clearProbeWinners([100000,100150]),[0,1])
  fastDeepEqual(clearProbeWinners([100,100,null,NaN,Infinity,-1,0]),[0,1])
  fastDeepEqual(clearProbeWinners([null,9]),[1])
  const data=Uint8Array.from({length:512*1024},(_,i)=>i%251)
  const parts=[data.subarray(0,110003),data.subarray(110003,300004),data.subarray(300004)]
  const positions=[37,2000037,9000037],sample=groupKernelSample(parts,positions,4)
  assert.ok(sample.bytes<=GROUP_KERNEL_PROBE_BYTES&&sample.bytes>GROUP_KERNEL_PROBE_BYTES-32)
  assert.equal(sample.parts.length,sample.positions.length)
  for(let i=0;i<sample.parts.length;i++) {
    const pi=parts.findIndex((p,j)=>sample.positions[i]>=positions[j]&&sample.positions[i]+sample.parts[i].length<=positions[j]+p.length)
    assert.ok(pi>=0);const offset=sample.positions[i]-positions[pi]
    assert.equal(offset%4,0);assert.equal(sample.parts[i].length%4,0)
    eq(sample.parts[i],parts[pi].subarray(offset,offset+sample.parts[i].length))
  }
  fastDeepEqual(groupKernelSample(parts,positions,4),sample)
  const small=groupKernelSample([data.subarray(0,123)],[99]);assert.equal(small.bytes,123);assert.equal(small.positions[0],99)
  assert.throws(()=>groupKernelSample(parts,positions,0),/预算/)
  console.log('P13 sample budget/seams/absolute positions/alignment and 0.15% ambiguity policy PASS')
}
export function testScreen() {
  const data=binary(),spec={id:ID.BIN_V3,s:1,r:1},save={...planTuning}
  try {
    planTuning.groupKernelScreen=true
    const c=groupV15CandidatesSync([data],spec,[0])!
    assert.equal(c.screening!.length,1)
    const s=c.screening![0];assert.equal(s.sampleBytes,GROUP_KERNEL_PROBE_BYTES)
    fastDeepEqual(s.selected,clearProbeWinners(s.trials.map(t=>t.bytes)))
    assert.equal(s.fullBytes,data.length*s.selected.length)
    assert.equal(+!!c.alt + +!!c.v20,s.selected.length)
    const base=frame(data,encodeTerrainGroup([data],spec),false)
    const choices=[base];if(c.alt)choices.push(frame(data,c.alt,true));if(c.v20)choices.push(frame(data,c.v20,true))
    assert.ok(Math.min(...choices.map(x=>x.length))<=base.length)
    // Every retained stream is the actual standalone kernel, never relabeled.
    for(const [k,p] of [['v15',c.alt],['v20',c.v20]] as const)if(p)eq(p,encodeTerrainGroup([data],spec,undefined,undefined,undefined,[0],k))
    console.log(JSON.stringify({case:'P13 real 256KiB candidate screening',screening:c.screening,fullCandidates:s.selected.length,containerBytes:Math.min(...choices.map(x=>x.length)),roundtrip:true}))
  }finally{Object.assign(planTuning,save)}
}
export async function testWorkerScreen() {
  const data=binary(),spec={id:ID.BIN_V3,s:1,r:1},local=encodeGroupForJob([data],spec,[0],[data.length])
  assert.ok(local.cand?.screening?.length)
  const sab=new SharedArrayBuffer(data.length);new Uint8Array(sab).set(data)
  const worker=new Worker(PARALLEL_WORKER_CODE,{eval:true,workerData:{sab}})
  try {
    const reply=await new Promise<any>((resolve,reject)=>{worker.once('error',reject);worker.once('message',m=>m.error?reject(Error(m.error)):resolve(m));worker.postMessage({kind:'encodeGroup',parts:[[0,data.length]],spec,positions:[0],ends:[data.length]})})
    fastDeepEqual(reply,local)
  }finally{await worker.terminate()}
  console.log('P13 real worker 256KiB screen/candidate bytes/flags/cost parity PASS')
}

function bcjData() {
  const d=new Uint8Array(32768).fill(0x90)
  for(let i=0;i+7<d.length;i+=8)d.set([0xe8,17,23,31,0x7f,0x90,0x90,0x90],i)
  return d
}
export async function testBcjUpgrade() {
  const data=bcjData()
  for(const id of [ID.BCJ,ID.BCJ_V2,ID.BCJ_V3]) {
    const spec={id,s:1,r:1},c=groupV15CandidatesSync([data],spec,[0])!
    fastDeepEqual(c.variants!.map(v=>v.kernel),['v15','v20'])
    for(const v of c.variants!)frame(data,v.payload,true,v.spec)
    assert.ok(!groupV15CandidatesSync([data],spec,[0],{allowBcjUpgrade:false})!.variants)
    const [result]=await compressCachedPlansForProbe(data,[[{start:0,end:data.length,cls:'binary',spec}]],{serial:true})
    fastDeepEqual(result.segs[0].spec,{id:ID.BCJ_V3,s:2,r:1})
    eq(decompress(result.container),data)
    assert.equal(evaluatePlan(data,[{start:0,end:data.length,cls:'binary',spec}],{alreadyMerged:true}).totalBytes,result.container.length)
  }
  const short=data.subarray(0,32767)
  assert.ok(!groupV15CandidatesSync([short],{id:ID.BCJ,s:1,r:1},[0])!.variants)
  console.log('P13 >=32KiB BCJ/BCJ2/BCJ3 -> BCJ25 v15+v20, exact costs, evaluator, target gate and threshold PASS')
}
export async function testBcjCacheWorker() {
  const body=bcjData(),data=Uint8Array.from([...body,...body.subarray(0,37),...new Uint8Array(19).fill(65)])
  const plans:PlanSegment[][]=[false,true,false].map(occupied=>[
    {start:0,end:body.length,cls:'binary',spec:{id:ID.BCJ,s:1,r:1}},
    {start:body.length,end:body.length+37,cls:'binary',spec:{id:occupied?ID.BCJ_V3:ID.STORE,s:occupied?2:1,r:1}},
    {start:body.length+37,end:data.length,cls:'fill',spec:{id:ID.FILL,s:1,r:1}},
  ])
  const serial=await compressCachedPlansForProbe(data,plans,{serial:true})
  assert.equal(serial[0].segs[0].spec.s,2);assert.equal(serial[1].segs[0].spec.id,ID.BCJ)
  assert.ok(serial[1].guardStats!.reusedGroups>0)
  eq(serial[0].container,serial[2].container)
  const [cold]=await compressCachedPlansForProbe(data,[plans[1]],{serial:true})
  eq(serial[1].container,cold.container);fastDeepEqual(serial[1].blockCost,cold.blockCost)
  const sab=new SharedArrayBuffer(data.length);new Uint8Array(sab).set(data)
  const worker=new Worker(PARALLEL_WORKER_CODE,{eval:true,workerData:{sab}})
  try {
    let admitted=0,blocked=0
    const actual=await compressCachedPlansForProbe(data,plans,{runJobs:async jobs=>{
      const replies=[]
      for(const job of jobs) {
        if(job.kind==='encodeGroup'&&job.spec.id===ID.BCJ){if(job.groupOptions?.allowBcjUpgrade)admitted++;else blocked++}
        replies.push(await new Promise<any>((resolve,reject)=>{
          const fail=(e:Error)=>reject(e);worker.once('error',fail)
          worker.once('message',r=>{worker.off('error',fail);r.error?reject(Error(r.error)):resolve(r)})
          worker.postMessage(job)
        }))
      }
      return replies
    }})
    assert.ok(admitted>=2&&blocked>0);assert.equal(actual[1].guardStats!.workerFallbacks,0)
    for(let i=0;i<plans.length;i++){eq(actual[i].container,serial[i].container);eq(decompress(actual[i].container),data);fastDeepEqual(actual[i].blockCost,serial[i].blockCost)}
  }finally{await worker.terminate()}
  console.log('P13 BCJ cached-alias collision/free-target re-admission and real worker admission/flags/bytes/cost restoration PASS')
}
export async function testFamilyReuse() {
  const data=bcjData(),save={...planTuning}
  Object.assign(planTuning,{orphanConsolidation:false,macroUniformGate:false})
  try {
    const picks:PlanSegment[]=[{start:0,end:16384,cls:'binary',spec:{id:ID.BCJ,s:1,r:1}},
      {start:16384,end:data.length,cls:'binary',spec:{id:ID.BCJ_V2,s:1,r:1}}]
    const result=await compressGuardedPlanForProbe(data,picks,{runJobs:async()=>{throw Error('completed family candidates must NOT be dispatched again')}})
    assert.equal(result.guardStats!.familyTrials,1)
    assert.equal(result.guardStats!.workerJobs,0);assert.equal(result.guardStats!.workerFallbacks,0)
    assert.ok(result.guardStats!.reusedFamilyBases>0)
    assert.ok(result.segs.every(s=>s.spec.id===ID.BCJ_V3&&s.spec.s===2))
    eq(decompress(result.container),data)
  }finally{Object.assign(planTuning,save)}
  console.log('P13 merged BCJ s2 admission and zero redundant worker candidate jobs after family completion PASS')
}

export async function testBcjLargeWorker() {
  const small=bcjData(),data=Uint8Array.from({length:262144},(_,i)=>small[i%small.length]),spec={id:ID.BCJ_V3,s:1,r:1}
  const picks:PlanSegment[]=[{start:0,end:data.length,cls:'binary',spec}]
  const [serial]=await compressCachedPlansForProbe(data,[picks],{serial:true})
  const sab=new SharedArrayBuffer(data.length);new Uint8Array(sab).set(data)
  const worker=new Worker(PARALLEL_WORKER_CODE,{eval:true,workerData:{sab}})
  try {
    const [actual]=await compressCachedPlansForProbe(data,[picks],{runJobs:async jobs=>{
      assert.equal(jobs.length,1)
      const r:any=await new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('message',m=>m.error?reject(Error(m.error)):resolve(m));worker.postMessage(jobs[0])})
      assert.equal(r.cand.screening[0].sampleBytes,196608)
      assert.equal(r.cand.screening[0].trials.length,4)
      assert.ok(r.cand.variants.length>0)
      return [r]
    }})
    assert.equal(actual.guardStats!.workerFallbacks,0);assert.equal(actual.segs[0].spec.s,2)
    eq(actual.container,serial.container);eq(decompress(actual.container),data);fastDeepEqual(actual.blockCost,serial.blockCost)
  }finally{await worker.terminate()}
  console.log('P13 actual 256KiB four-way BCJ sample selection + worker variant metadata + final-container parity PASS')
}


export async function testBcjSeams() {
  const body=bcjData(),cut=16387,prefix=17,gap=23,tail=5,store={id:ID.STORE,s:1,r:1},spec={id:ID.BCJ_V3,s:1,r:1}
  // The first part ends in the middle of an E8 immediate. Never transform
  // across that seam, and never reset either part's absolute origin to zero.
  assert.equal(body[cut-3],0xe8)
  const data=new Uint8Array(prefix+body.length+gap+tail).fill(0x47)
  data.set(body.subarray(0,cut),prefix);data.set(body.subarray(cut),prefix+cut+gap)
  const picks:PlanSegment[]=[
    {start:0,end:prefix,cls:'binary',spec:store},
    {start:prefix,end:prefix+cut,cls:'binary',spec},
    {start:prefix+cut,end:prefix+cut+gap,cls:'binary',spec:store},
    {start:prefix+cut+gap,end:data.length-tail,cls:'binary',spec},
    {start:data.length-tail,end:data.length,cls:'binary',spec:store},
  ]
  const parts=[data.subarray(picks[1].start,picks[1].end),data.subarray(picks[3].start,picks[3].end)]
  const candidates=groupV15CandidatesSync(parts,spec,[picks[1].start,picks[3].start])!
  fastDeepEqual(candidates.variants!.map(v=>v.kernel),['v15','v20'])
  const plain=encodeTerrainGroup([data.subarray(0,prefix),data.subarray(prefix+cut,prefix+cut+gap),data.subarray(data.length-tail)],store)
  for(const v of candidates.variants!) {
    const chosen=picks.map((p,i)=>({...p,spec:i===1||i===3?v.spec:store}))
    const header=planHeader(data.length,chosen,[{spec:v.spec,members:[1,3],payload:v.payload,v15:true},{spec:store,members:[0,2,4],payload:plain}])
    eq(decompress(Uint8Array.from([...header,...v.payload,...plain])),data)
  }
  const [serial]=await compressCachedPlansForProbe(data,[picks],{serial:true})
  assert.equal(serial.segs[1].spec.s,2);assert.equal(serial.segs[3].spec.s,2)
  const sab=new SharedArrayBuffer(data.length);new Uint8Array(sab).set(data)
  const worker=new Worker(PARALLEL_WORKER_CODE,{eval:true,workerData:{sab}})
  try {
    const [actual]=await compressCachedPlansForProbe(data,[picks],{runJobs:async jobs=>{
      const replies=[]
      for(const job of jobs) {
        if(job.kind==='encodeGroup'&&job.spec.id===ID.BCJ_V3) {
          fastDeepEqual(job.positions,[prefix,prefix+cut+gap])
          assert.equal(job.groupOptions!.allowBcjUpgrade,true)
        }
        replies.push(await new Promise<any>((resolve,reject)=>{
          const fail=(e:Error)=>reject(e);worker.once('error',fail)
          worker.once('message',m=>{worker.off('error',fail);m.error?reject(Error(m.error)):resolve(m)})
          worker.postMessage(job)
        }))
      }
      return replies
    }})
    assert.equal(actual.guardStats!.workerFallbacks,0)
    eq(actual.container,serial.container);eq(decompress(actual.container),data);fastDeepEqual(actual.blockCost,serial.blockCost)
  }finally{await worker.terminate()}
  console.log('P13 BCJ nonzero origins/discontiguous instruction seam: both kernels, actual worker, final bytes/flags/costs PASS')
}

async function bcjTargetOrder(targetFirst:boolean) {
  const body=bcjData(),other=body.subarray(0,37),data=Uint8Array.from(targetFirst?[...other,...body]:[...body,...other])
  const original={id:ID.BCJ,s:1,r:1},target={id:ID.BCJ_V3,s:2,r:1},store={id:ID.STORE,s:1,r:1}
  const plan=(occupied:boolean):PlanSegment[]=>targetFirst?[
    {start:0,end:37,cls:'binary',spec:occupied?target:store},{start:37,end:data.length,cls:'binary',spec:original},
  ]:[
    {start:0,end:body.length,cls:'binary',spec:original},{start:body.length,end:data.length,cls:'binary',spec:occupied?target:store},
  ]
  const bigIndex=targetFirst?1:0,smallIndex=1-bigIndex
  // Warm the promoted alias, block it, then allow it again. A valid original
  // target keeps ownership regardless of its order in the segment directory.
  const results=await compressCachedPlansForProbe(data,[plan(false),plan(true),plan(false)],{serial:true})
  fastDeepEqual(results[0].segs[bigIndex].spec,target)
  fastDeepEqual(results[1].segs[bigIndex].spec,original)
  fastDeepEqual(results[1].segs[smallIndex].spec,target)
  eq(results[0].container,results[2].container)
  const [cold]=await compressCachedPlansForProbe(data,[plan(true)],{serial:true})
  eq(cold.container,results[1].container);fastDeepEqual(cold.blockCost,results[1].blockCost)
  for(const r of results)eq(decompress(r.container),data)
  console.log(`P13 BCJ original target ${targetFirst?'before':'after'} upgrader: warm alias/block/re-admit and cold parity PASS`)
}
export const testBcjTargetFirst=()=>bcjTargetOrder(true)
export const testBcjTargetLast=()=>bcjTargetOrder(false)
