import assert from 'node:assert/strict'
import {synthetic,sha} from '../scripts/diag/p15/common'
import {detectRec2,rec2Forward,rec2Inverse} from '../src/lib/rec2'
import {compressAdaptive,decompress,refineRec2,ID,planHeader} from '../src/lib/codec'
import {encodeCM,V20_FLAG_CM,V20_FLAG_TRANSFORMS} from '../src/lib/coder'
import {V21_FLAG_CONTEXTS} from '../src/lib/context-policy'
import {payloadModelFlags,markPayloadModel} from '../src/lib/payload-model'
const [mode='glibc',raw='262144']=process.argv.slice(2),n=Number(raw)
async function main(){
 if(mode==='boundary'){
  let cases=0
  for(let op=0;op<5;op++)for(const [a,b] of [[1,2],[3,31],[1,63],[62,63]])for(const len of [b,b+1,b+17,1024]){
   const data=synthetic('random',len),x=rec2Forward(data,{op,a,b});assert.deepEqual(rec2Inverse(x,len),data)
   for(const [at,val] of [[0,5],[1,0],[2,64]]){const bad=x.slice();bad[at]=val;assert.throws(()=>rec2Inverse(bad,len))}
   assert.throws(()=>rec2Inverse(x.subarray(0,x.length-1),len));assert.throws(()=>rec2Inverse(x,256*1024*1024));cases++
  }
  const data=synthetic('random',128),spec={id:ID.REC2,s:1,r:1},stream=rec2Forward(data,{op:0,a:3,b:31})
  const frame=(raw:Uint8Array)=>{const p=encodeCM(raw,'bin',1,1,undefined,0,undefined,undefined,'v20');markPayloadModel(p,payloadModelFlags(p)|V21_FLAG_CONTEXTS|V20_FLAG_CM|V20_FLAG_TRANSFORMS);const h=planHeader(data.length,[{start:0,end:data.length,cls:'noise',spec}],[{spec,members:[0],payload:p,v15:true}]);const c=new Uint8Array(h.length+p.length);c.set(h);c.set(p,h.length);return c}
  assert.deepEqual(decompress(frame(stream)),data)
  for(const [at,val] of [[0,5],[1,0],[2,64],[2,2]]){const bad=stream.slice();bad[at]=val;assert.throws(()=>decompress(frame(bad)))}
  const old=frame(stream);old[3]=20;assert.throws(()=>decompress(old))
  const flags=frame(stream);flags[5]&=~8;assert.throws(()=>decompress(flags))
  console.log(JSON.stringify({mode,cases,roundtrip:true,malformed:true,malformedUCZ:true,oldVersionRejected:true}));return
 }
 const kind=mode==='glibc'||mode==='auto'?'glibc-low8':mode==='random'?'random':mode==='adversarial'?'rec2-adversarial':`rec2-${mode}`,data=synthetic(kind,n)
 const p=detectRec2(data)
 const base=await compressAdaptive(data,undefined,{serial:true,contextCandidates:false}),after=mode==='auto'?await compressAdaptive(data,undefined,{serial:true}):refineRec2(data,base)
 assert.deepEqual(decompress(after.container),data);assert.ok(after.container.length<=base.container.length)
 if(['glibc','auto','plus','minus','xor'].includes(mode)){assert.ok(p);assert.equal(after.container[3],21);assert.equal(after.rec2Comparison?.accepted,true)}else {assert.equal(p,null);assert.deepEqual(after.container,base.container)}
 console.log(JSON.stringify({mode,n,inputSha256:sha(data),params:p,base:base.container.length,after:after.container.length,comparison:after.rec2Comparison,roundtrip:true,version:after.container[3]}))
}
main().catch(e=>{console.error(e);process.exitCode=1})
