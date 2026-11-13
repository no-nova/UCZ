import assert from 'node:assert/strict'
import { fastDeepEqual } from './fast-equal'
import { Worker } from 'node:worker_threads'
import { screenWordPreCandidates, ID, planHeader, decompress, compressCachedPlansForProbe, type PlanSegment } from '../src/lib/codec'
import { encodeCM, withCMProbe } from '../src/lib/coder'
import { wordPreFwdSampled, collapseWithDict } from '../src/lib/wordpre'
import { encodeGroupForJob } from '../src/lib/codec-jobs'
import { PARALLEL_WORKER_CODE } from '../src/lib/parallel-worker-code'
const eq=(a:Uint8Array,b:Uint8Array)=>fastDeepEqual(Buffer.from(a),Buffer.from(b))
const sentence=new TextEncoder().encode('alpha beta gamma delta="text"\n')
const text=(n:number)=>Uint8Array.from({length:n},(_,i)=>sentence[i%sentence.length])

export function testP131Gate() {
  const data=text(sentence.length*1200),pre=wordPreFwdSampled(data)!,kernels=['v15','v20'] as const
  assert.ok(pre&&pre.body.length/data.length<=0.85)
  const got=screenWordPreCandidates(data,pre,kernels,[1])
  const prefix=data.subarray(0,196608),tokens=collapseWithDict(prefix,pre.dict)!
  const raw=withCMProbe(()=>encodeCM(prefix,'text',1,1,undefined,0,undefined,undefined,'v20',0)).length
  const wp=withCMProbe(()=>encodeCM(tokens,'text',1,1,undefined,0,undefined,undefined,'v20',0,true)).length
  fastDeepEqual(got.wordPreGate!.plainBytes,[null,raw])
  fastDeepEqual(got.wordPreGate!.bodyBytes,[null,wp])
  assert.ok(wp<raw*0.99);fastDeepEqual(got.selected,[1]);assert.equal(got.fullBytes,data.length)
  assert.equal(got.trials[0].bytes,null,'do not try or schedule WP-v15 after a decisive raw-v20 choice')
  // Synthetic metadata perturbation ONLY; this padded header is never emitted
  // or decoded. Admission must not confuse a one-time dictionary with a sample.
  const padded=screenWordPreCandidates(data,{...pre,header:new Uint8Array(128*1024)},kernels,[1])
  fastDeepEqual(padded.trials,got.trials);fastDeepEqual(padded.selected,got.selected)
  assert.equal(padded.wordPreGate!.dictionaryBytes,128*1024)
  const oldKernel=screenWordPreCandidates(data,pre,['v15'],[0])
  fastDeepEqual(oldKernel.selected,[0]);assert.equal(oldKernel.trials[0].kernel,'v15')
  fastDeepEqual(screenWordPreCandidates(data,null,kernels,[1]).selected,[])
  fastDeepEqual(screenWordPreCandidates(data,pre,kernels,[]).selected,[])
  fastDeepEqual(screenWordPreCandidates(data,{...pre,body:new Uint8Array(data.length)},kernels,[1]).selected,[])
  fastDeepEqual(screenWordPreCandidates(data.subarray(0,32767),pre,kernels,[1]).selected,[])
  console.log('P13.1 exact P12 body-only prefix CM gate, dictionary invariance, inherited kernel, v15-only/null/collapse/length guards PASS')
}

export async function testP131Worker() {
  const data=text(262144),spec={id:ID.TEXT_V3,s:1,r:1}
  const ends=Array.from({length:data.length/512},(_,i)=>(i+1)*512)
  const local=encodeGroupForJob([data],spec,[0],ends)
  const screen=local.cand!.screening!,gate=screen.find(s=>s.kind==='wordpre')!
  assert.equal(gate.wordPreGate!.policy,'p12-contiguous-body')
  assert.equal(gate.wordPreGate!.rawPrefixBytes,196608)
  fastDeepEqual(gate.wordPreGate!.eligible,screen.find(s=>s.kind==='raw')!.selected)
  assert.ok(local.cand!.wordPre||local.cand!.wordPreV20,'fixture must actually produce a WORD-PRE candidate')
  const sab=new SharedArrayBuffer(data.length);new Uint8Array(sab).set(data)
  const worker=new Worker(PARALLEL_WORKER_CODE,{eval:true,workerData:{sab}})
  try {
    const reply:any=await new Promise((resolve,reject)=>{
      worker.once('error',reject);worker.once('message',m=>m.error?reject(Error(m.error)):resolve(m))
      worker.postMessage({kind:'encodeGroup',parts:[[0,data.length]],spec,positions:[0],ends})
    })
    fastDeepEqual(reply,local,'real worker must preserve gate/candidates/flags/costs byte-for-byte')
    const picks:PlanSegment[]=[{start:0,end:data.length,cls:'text',spec}]
    // Use the actual worker response through production restoration/selection;
    // no second full local/worker encode to manufacture integration evidence.
    const [actual]=await compressCachedPlansForProbe(data,[picks],{runJobs:async jobs=>{
      assert.equal(jobs.length,1);assert.equal(jobs[0].kind,'encodeGroup')
      if(jobs[0].kind==='encodeGroup'){fastDeepEqual(jobs[0].ends,ends);fastDeepEqual(jobs[0].positions,[0])}
      return [reply]
    }})
    assert.equal(actual.guardStats!.workerFallbacks,0);eq(decompress(actual.container),data)
    const baseHeader=planHeader(data.length,picks,[{spec,members:[0],payload:local.bytes,modelFlags:local.modelFlags}])
    assert.ok(actual.container.length<=baseHeader.length+local.bytes.length,'actual full base remains the safety fallback')
    assert.ok(reply.cand)
    for(const [payload,flags] of [[reply.cand.wordPre,reply.cand.wordPreFlags],[reply.cand.wordPreV20,reply.cand.wordPreV20Flags]] as const)if(payload) {
      const h=planHeader(data.length,picks,[{spec,members:[0],payload,modelFlags:flags,v15:true,wordPre:true}])
      eq(decompress(Uint8Array.from([...h,...payload])),data)
    }
    console.log(JSON.stringify({case:'P13.1 real 256KiB TEXT worker + production restoration + complete UCZ guard',
      selectedKernels:gate.selected.map(i=>gate.trials[i].kernel),gate:gate.wordPreGate,
      bytes:actual.container.length,roundtrip:true,workerFallbacks:actual.guardStats!.workerFallbacks}))
  } finally {await worker.terminate()}
}
