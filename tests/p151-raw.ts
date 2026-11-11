import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { loadSlice, sha } from '../scripts/diag/p141/input'
import { ID, compressAdaptive, contextGroupCandidatesSync, decodeTerrainGroup, decompress, encodeTerrainGroup, planHeader, type Spec } from '../src/lib/codec'
import { encodeCM, decodeCM, V20_FLAG_CM, withCMProbe } from '../src/lib/coder'
import { groupKernelSample } from '../src/lib/group-policy'
import { selectionHeaderBytes } from '../src/lib/codec'
import { payloadModelFlags, markPayloadModel } from '../src/lib/payload-model'
import { V21_FLAG_CONTEXTS } from '../src/lib/context-policy'
import { PARALLEL_WORKER_CODE } from '../src/lib/parallel-worker-code'
const [mode,name='webster-mid',b='65536']=process.argv.slice(2)
const {data,input}=loadSlice(name,Number(b))
const frame=(p:Uint8Array,sp:Spec,ctx?:'text-sparse5')=>{
 const seg={start:0,end:data.length,cls:'text' as const,spec:sp},header=planHeader(data.length,[seg],[{spec:sp,members:[0],payload:p,v15:true,context:ctx}])
 const c=Uint8Array.from([...header,...p]);assert.deepEqual(decompress(c),data);return c
}
async function main(){
 if(mode==='wire') {
  const n=1024,d=data.subarray(0,n)
  for(const id of [ID.TEXT,ID.TEXT_V2,ID.TEXT_V3]) {
   const sp={id,s:1,r:1},p=encodeTerrainGroup([d.subarray(0,333),d.subarray(333)],sp,undefined,undefined,undefined,[0,333],'v20',{context:'text-sparse5'})
   assert.deepEqual(new Uint8Array(Buffer.concat(decodeTerrainGroup(p,[333,n-333],sp,undefined,[0,333],'v20',false,{context:'text-sparse5'}))),d)
   const h=planHeader(n,[{start:0,end:n,cls:'text',spec:sp}],[{spec:sp,members:[0],payload:p,v15:true,context:'text-sparse5'}]);const c=Uint8Array.from([...h,...p])
   assert.equal(c[3],21);assert.deepEqual(decompress(c),d)
   assert.throws(()=>decodeTerrainGroup(p,[n],sp,undefined,[0],'v20',true,{context:'text-sparse5'}))
   assert.throws(()=>encodeCM(d,'bin',1,1,undefined,0,undefined,undefined,'v20',0,false,{context:'text-sparse5'}))
  }
  console.log(JSON.stringify({mode,inputBytes:n,ids:[4,18,23],roundtrip:true,invalidProfileRejected:true}));return
 }
 if(mode==='forced') {
  const spec={id:ID.TEXT_V3,s:1,r:1};const p=encodeCM(data,'text',1,1,undefined,0,undefined,undefined,'v20'),q=encodeCM(data,'text',1,1,undefined,0,undefined,undefined,'v20',0,false,{context:'text-sparse5'})
  assert.deepEqual(decodeCM(q,data.length,'text',1,1,undefined,'v20',0,false,{context:'text-sparse5'}),data)
  const base=frame(p,spec),alt=frame(q,spec,'text-sparse5')
  console.log(JSON.stringify({mode,input,base:base.length,alt:alt.length,saved:base.length-alt.length,basePayload:p.length,altPayload:q.length,altSha256:sha(q),forced:true}));return
 }
 if(mode==='adaptive'){
  const out=await compressAdaptive(data,undefined,{serial:true});assert.deepEqual(decompress(out.container),data)
  console.log(JSON.stringify({mode,input,container:out.container.length,roundtrip:true,contexts:out.contextComparison}));return
 }
 if(mode==='screen'){
  const spec={id:ID.TEXT_V3,s:1,r:1},sample=groupKernelSample([data],[0],4), joined=Buffer.concat(sample.parts),probe=new Uint8Array(joined)
  const enc=(context?:'text-sparse5')=>withCMProbe(()=>encodeCM(probe,'text',1,1,undefined,0,undefined,undefined,'v20',0,false,{context}))
  const base=enc(),alt=enc('text-sparse5'),cost=(p:Uint8Array,context?:'text-sparse5')=>p.length+selectionHeaderBytes(spec,sample.bytes,p.length,payloadModelFlags(p),true,false,context)
  const retainedPayload=encodeCM(data,'text',1,1,undefined,0,undefined,undefined,'v20')
  const result=contextGroupCandidatesSync([data],spec,[0],{payload:retainedPayload,flags:payloadModelFlags(retainedPayload),wordPre:false},true,true)
  assert.ok(!result.error,result.error);assert.ok(result.screen);assert.equal(result.screen.controlBytes,cost(base));assert.equal(result.screen.trials[0].bytes,cost(alt,'text-sparse5'))
  if(result.control)assert.equal(result.controlReused,true)
  for(const t of result.trials)frame(t.payload,spec,'text-sparse5')
  console.log(JSON.stringify({mode,input,screen:result.screen,controlReused:result.controlReused,roundtrip:true,independentScreenParity:true}));return
 }
 if(mode==='worker'){
  const spec={id:ID.TEXT_V3,s:1,r:1},p=encodeCM(data,'text',1,1,undefined,0,undefined,undefined,'v20'),retained={payload:p,flags:payloadModelFlags(p),wordPre:false}
  const local=contextGroupCandidatesSync([data],spec,[0],retained,true,true),sab=new SharedArrayBuffer(data.length);new Uint8Array(sab).set(data)
  const w=new Worker(PARALLEL_WORKER_CODE,{eval:true,workerData:{sab}})
  try{const remote:any=await new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',r=>r.error?reject(Error(r.error)):resolve(r));w.postMessage({kind:'contextGroup',parts:[[0,data.length]],spec,positions:[0],retained,rawText:true})});assert.deepEqual(remote.candidates,local)
    assert.equal(local.controlReused,true);for(const t of local.trials){markPayloadModel(t.payload,t.flags);assert.ok(t.flags&V20_FLAG_CM);assert.ok(t.flags&V21_FLAG_CONTEXTS);frame(t.payload,spec,'text-sparse5')}
  }finally{await w.terminate()}
  console.log(JSON.stringify({mode,input,workerParity:true,controlReused:local.controlReused}));return
 }
 throw Error('unknown case')
}
main().catch(e=>{console.error(e);process.exitCode=1})
