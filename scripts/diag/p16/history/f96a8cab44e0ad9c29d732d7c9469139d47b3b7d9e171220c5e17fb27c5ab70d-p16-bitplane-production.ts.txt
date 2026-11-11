import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {bitplaneEntropyGate,bitplaneStoreTrigger,bitplaneFullProof,encodeBitplanesBitCM,decodeBitplanes,BITPLANE_BIT_CM,BITPLANE_BYTE_CM,BITPLANE_BIT_ORDERS} from '../src/lib/bitplane'
import {MAX_OUTPUT_BYTES} from '../src/lib/limits'
import {ID,planHeader,decompress,refineBitplane,compressAdaptive,type Compressed} from '../src/lib/codec'
import {V20_FLAG_CM,V20_FLAG_TRANSFORMS} from '../src/lib/coder'
import {V21_FLAG_CONTEXTS} from '../src/lib/context-policy'
import {payloadModelFlags,markPayloadModel} from '../src/lib/payload-model'
const [kind='structured',size='65536']=process.argv.slice(2),n=Number(size);assert.ok(n<=262144&&n>=16384)
const bytes=new Uint8Array(n)
for(let pos=0;pos<n;pos+=32){const digest=createHash('sha256').update(`p16-deterministic-control-${pos/32}`).digest();bytes.set(digest.subarray(0,Math.min(32,n-pos)),pos)}
if(kind==='structured'||kind==='auto'||kind==='store'){
 const state=[0x1a13,0x2b21,0x4c31],degrees=[13,14,15],taps=[1,5,1]
 for(let i=0;i<n;i++)for(let b=0;b<3;b++){const bit=state[b]&1;bytes[i]=(bytes[i]&~(1<<b))|(bit<<b);state[b]=(state[b]>>>1)|(((state[b]^(state[b]>>>taps[b]))&1)<<(degrees[b]-1))}
}
const randomControl=kind==='random'||kind==='auto-random'
async function main(){
 // The legacy statistical screen is retained for diagnostics only.
 const screen=bitplaneFullProof(bytes)
 if(randomControl){
  assert.equal(screen.proof.filter(Boolean).length,0,'random control must not adopt any plane')
  assert.equal(encodeBitplanesBitCM(bytes,screen.proof,screen.coded),null)
  assert.equal(bitplaneStoreTrigger(n,n),true,'STORE dominance triggers the cheap screen')
 } else {
  assert.ok(screen.proof.some(Boolean),'structured stream must offer at least one plane')
 }
 const payload=encodeBitplanesBitCM(bytes,screen.proof,screen.coded)
 if(payload){
  assert.deepEqual(decodeBitplanes(payload,n,BITPLANE_BIT_CM),bytes,'r=2 roundtrip')
  assert.throws(()=>decodeBitplanes(payload.subarray(0,payload.length-1),n,BITPLANE_BIT_CM),'truncation')
  assert.throws(()=>decodeBitplanes(payload,MAX_OUTPUT_BYTES+1,BITPLANE_BIT_CM),'oversized length')
  assert.throws(()=>decodeBitplanes(payload,n,0),'unknown model')
  assert.throws(()=>decodeBitplanes(payload,n,3),'unknown model')
  assert.throws(()=>decodeBitplanes(payload,n,BITPLANE_BYTE_CM),'r=1 must not decode r=2 planes')
  const spec={id:ID.BITPLANE,s:1,r:BITPLANE_BIT_CM}
  markPayloadModel(payload,payloadModelFlags(payload)|V21_FLAG_CONTEXTS|V20_FLAG_CM|V20_FLAG_TRANSFORMS)
  const seg={start:0,end:n,cls:'noise' as const,spec}
  const h=planHeader(n,[seg],[{spec,members:[0],payload,v15:true}])
  const c=new Uint8Array(h.length+payload.length);c.set(h);c.set(payload,h.length)
  assert.equal(c[3],21)
  assert.deepEqual(decompress(c),bytes,'container roundtrip')
  const badMask=c.slice();badMask[h.length]=0;assert.throws(()=>decompress(badMask),'empty mask')
  const oversized=c.slice();oversized.set([255,255,255,255],h.length+1);assert.throws(()=>decompress(oversized),'oversized plane')
  const old=c.slice();old[3]=20;assert.throws(()=>decompress(old),'v20 must reject id33')
  const truncated=c.slice(0,c.length-1);assert.throws(()=>decompress(truncated),'truncated container')
  assert.throws(()=>planHeader(n,[seg],[{spec:{...spec,r:3},members:[0],payload,v15:true}]),'r=3 invalid')
  const base={container:new Uint8Array(n+100),segs:[],blockCost:new Float32Array(1),blockSeg:new Int32Array(1)} as unknown as Compressed
  const refined=refineBitplane(data(bytes),base)
  assert.deepEqual(decompress(refined.container),bytes,'refineBitplane roundtrip')
  assert.ok(refined.container.length<base.container.length,'refineBitplane must strictly shrink')
 }
 function data(x:Uint8Array){return x}
 // STORE-dominance path through the real adaptive entry point.
 const adaptive=await compressAdaptive(bytes,undefined,{serial:true})
 assert.deepEqual(decompress(adaptive.container),bytes,'adaptive roundtrip')
 const plainly=await compressAdaptive(bytes,undefined,{serial:true,contextCandidates:false})
 if(!randomControl)assert.ok(adaptive.container.length<=plainly.container.length,'never worse than the baseline')
 console.log(JSON.stringify({kind,n,proof:screen.proof,payloadBytes:payload?.length??null,
  adaptive:{id:adaptive.segs[0]?.spec.id,r:adaptive.segs[0]?.spec.r,ver:adaptive.container[3],bytes:adaptive.container.length},
  baselineBytes:plainly.container.length,strictlySmaller:adaptive.container.length<plainly.container.length,nonzeroFalsePositive:false}))
}
main().catch(e=>{console.error(e);process.exitCode=1})
