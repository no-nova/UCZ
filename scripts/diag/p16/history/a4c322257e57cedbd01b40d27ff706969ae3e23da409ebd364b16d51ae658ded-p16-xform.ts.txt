import assert from 'node:assert/strict'
import {Worker} from 'node:worker_threads'
import {loadSlice} from '../scripts/diag/p141/input'
import {ID,encodeTerrainGroup,decodeTerrainGroup,planHeader,decompress,contextGroupCandidatesSync,contextSpecAllowed,type Spec} from '../src/lib/codec'
import {PARALLEL_WORKER_CODE} from '../src/lib/parallel-worker-code'
import {payloadModelFlags} from '../src/lib/payload-model'
import type {CMContext} from '../src/lib/context-policy'
const [file='mozilla-resources',idstr='6',sizestr='32768',mode='stream']=process.argv.slice(2),{data,input}=loadSlice(file,Number(sizestr)),id=Number(idstr)
const sp:Spec={id,s:id===ID.TRANSPOSE_2D?8:id===ID.GRAD_V3?2:4,r:id===ID.GRAD_V3?8192:1}
const split=Math.floor(data.length/2),parts=[data.subarray(0,split),data.subarray(split)],lengths=parts.map(x=>x.length),positions=[0,split]
async function main(){
 if(mode==='gates'){
  const n=4096,small=data.subarray(0,n),del:Spec={id:ID.DELTA,s:4,r:1},gparts=[small.subarray(0,n>>1),small.subarray(n>>1)],lens=[n>>1,n-(n>>1)],pos=[0,n>>1]
  for(const ctx of ['xform-bin','xform-bin-stride4'] as const){
   for(const sp2 of [{id:ID.BIN_V3,s:1,r:1},{id:ID.BIN,s:1,r:1},{id:ID.TRANSPOSE,s:4,r:1}] as Spec[]) {
    assert.throws(()=>encodeTerrainGroup(gparts,sp2,undefined,undefined,undefined,pos,'v20',{context:ctx}))
    assert.equal(contextSpecAllowed(ctx,sp2),false)
    assert.throws(()=>encodeTerrainGroup(gparts,sp2,undefined,undefined,undefined,pos,false,{context:ctx}))
   }
   assert.throws(()=>encodeTerrainGroup(gparts,del,undefined,undefined,undefined,pos,'v15',{context:ctx}))
   assert.equal(contextSpecAllowed(ctx,del),true)
   assert.throws(()=>decodeTerrainGroup(new Uint8Array(64),lens,del,undefined,pos,'v20',true,{context:ctx}))
  }
  const p=encodeTerrainGroup(gparts,del,undefined,undefined,undefined,pos,'v20',{context:'xform-bin'})
  const segs=[{start:0,end:n>>1,cls:'binary' as const,spec:del},{start:n>>1,end:n,cls:'binary' as const,spec:del}]
  const h=planHeader(n,segs,[{spec:del,members:[0,1],payload:p,v15:true,context:'xform-bin'}]),c=new Uint8Array(h.length+p.length);c.set(h);c.set(p,h.length)
  assert.equal(c[3],21)
  assert.deepEqual(Buffer.from(decompress(c)),Buffer.from(small))
  for(const v of [14,15,17,19,20]){const b=c.slice();b[3]=v;assert.throws(()=>decompress(b),`v${v} must reject context group`)}
  assert.throws(()=>planHeader(n,segs,[{spec:del,members:[0,1],payload:p,v15:false,context:'xform-bin'}]))
  assert.throws(()=>planHeader(n,segs,[{spec:del,members:[0,1],payload:p,v15:true,context:'xform-bin',wordPre:true}]))
  assert.throws(()=>planHeader(n,segs,[{spec:{id:ID.BIN_V3,s:1,r:1},members:[0,1],payload:p,v15:true,context:'xform-bin'}]))
  assert.throws(()=>decompress(c.slice(0,Math.max(c.length-1,1))))
  console.log(JSON.stringify({mode:'gates',input,ineligibleRejected:true,oldVersionsRejected:true,missingFlagsRejected:true,truncationRejected:true,roundtrip:true}));return
 }
 const rows=[]
 for(const context of ['xform-bin','xform-bin-stride4'] as CMContext[]){
  const payload=encodeTerrainGroup(parts,sp,undefined,undefined,undefined,positions,'v20',{context})
  const out=decodeTerrainGroup(payload,lengths,sp,undefined,positions,'v20',false,{context})
  assert.deepEqual(Buffer.concat(out),Buffer.from(data))
  const segs=parts.map((_,i)=>({start:positions[i],end:positions[i]+lengths[i],cls:'binary' as const,spec:sp}))
  const h=planHeader(data.length,segs,[{spec:sp,members:[0,1],payload,v15:true,context}]),container=new Uint8Array(h.length+payload.length);container.set(h);container.set(payload,h.length)
  assert.equal(container[3],21);assert.deepEqual(Buffer.from(decompress(container)),Buffer.from(data))
  const bad=container.slice();bad[3]=20;assert.throws(()=>decompress(bad));rows.push({context,payloadBytes:payload.length,containerBytes:container.length,flags:payloadModelFlags(payload),roundtrip:true})
 }
 const local=contextGroupCandidatesSync(parts,sp,positions,undefined,true),sab=new SharedArrayBuffer(data.length);new Uint8Array(sab).set(data)
 const worker=new Worker(PARALLEL_WORKER_CODE,{eval:true,workerData:{sab}})
 try{const reply:any=await new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('message',x=>x.error?reject(Error(x.error)):resolve(x));worker.postMessage({kind:'contextGroup',parts:[[0,split],[split,data.length]],spec:sp,positions})});assert.deepEqual(reply.candidates,local)}finally{await worker.terminate()}
 assert.ok(!local.error,local.error);assert.equal(local.trials.length,2)
 console.log(JSON.stringify({input,spec:sp,rows,workerParity:true,candidates:local.trials.map(t=>({context:t.context,bytes:t.payload.length}))}))
}
main().catch(e=>{console.error(e);process.exitCode=1})
