import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { PARALLEL_WORKER_CODE } from '../src/lib/parallel-worker-code'
import { loadSlice,sha } from '../scripts/diag/p141/input'
import { ID, encodeTerrainGroup, decodeTerrainGroup, planHeader, decompress, contextGroupCandidatesSync } from '../src/lib/codec'
import { payloadModelFlags } from '../src/lib/payload-model'
import { V21_FLAG_CONTEXTS } from '../src/lib/context-policy'
const [name='mozilla-resources',b='32768']=process.argv.slice(2),{data,input}=loadSlice(name,Number(b))
const parts=[data.subarray(0,Math.floor(data.length/8)*4),data.subarray(Math.floor(data.length/8)*4)],pos=[0,parts[0].length],spec={id:ID.TRANSPOSE_GROUP_V3,s:4,r:1}
const p=encodeTerrainGroup(parts,spec,undefined,undefined,undefined,pos,'v20'),q=encodeTerrainGroup(parts,spec,undefined,undefined,undefined,pos,'v20',{context:'bin-stride4'})
assert.ok(payloadModelFlags(q)&V21_FLAG_CONTEXTS,'must actually encode a BIN substream')
assert.deepEqual(decodeTerrainGroup(q,parts.map(x=>x.length),spec,undefined,pos,'v20',false,{context:'bin-stride4'}).map(x=>Array.from(x)),parts.map(x=>Array.from(x)))
const frame=(x:Uint8Array,ctx?:'bin-stride4')=>{const h=planHeader(data.length,parts.map((part,i)=>({start:pos[i],end:pos[i]+part.length,cls:'binary' as const,spec})),[{spec,members:[0,1],payload:x,v15:true,context:ctx}]);const c=new Uint8Array(h.length+x.length);c.set(h);c.set(x,h.length);assert.deepEqual(decompress(c),data);return c}
const old=frame(p),alt=frame(q,'bin-stride4')
const offer=contextGroupCandidatesSync(parts,spec,pos,{payload:p,flags:payloadModelFlags(p),wordPre:false},false)
assert.ok(!offer.error,offer.error);assert.ok(offer.controlReused);assert.equal(sha(offer.trials[0].payload),sha(q))
async function verifyWorker() {
 const sab=new SharedArrayBuffer(data.length);new Uint8Array(sab).set(data)
 const w=new Worker(PARALLEL_WORKER_CODE,{eval:true,workerData:{sab}})
 try {
  const retained={payload:p,flags:payloadModelFlags(p),wordPre:false}
  const local=contextGroupCandidatesSync(parts,spec,pos,retained,true)
  const remote:any=await new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',r=>r.error?reject(Error(r.error)):resolve(r));w.postMessage({kind:'contextGroup',parts:[[0,pos[1]],[pos[1],data.length]],spec,positions:pos,retained})})
  assert.deepEqual(remote.candidates,local)
 } finally {await w.terminate()}
 console.log(JSON.stringify({input,old:old.length,alt:alt.length,oldPayload:p.length,altPayload:q.length,oldSha256:sha(p),altSha256:sha(q),roundtrip:true,workerParity:true,retainedControlReused:true,forced:true}))
}
verifyWorker().catch(e=>{console.error(e);process.exitCode=1})
