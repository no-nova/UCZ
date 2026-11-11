// Research-only REC2 frame. Not a UCZ ID and not used by production.
import assert from 'node:assert/strict'
import { encodeCM, decodeCM } from '@stock/coder'
import { entropy, cat, eq, ms, sha } from './common'
export interface Rec2 { a:number;b:number;op:number }
export const opNames=['++','+-','-+','--','xor']
function predict(x:number,y:number,op:number){return op===0?x+y:op===1?x-y:op===2?y-x:op===3?-x-y:x^y}
function residual(x:number,a:number,b:number,op:number){return op===4?x^a^b:(x-predict(a,b,op))&255}
function sample(data:Uint8Array,p:Rec2,start:number,n:number,h=new Uint32Array(256)){
 h.fill(0);let close=0
 for(let i=start;i<start+n;i++){const r=residual(data[i],data[i-p.a],data[i-p.b],p.op);h[r]++;if(r<=1)close++}
 let H=0;for(const f of h)if(f)H-=f/n*Math.log2(f/n)
 return {entropy:H,zeroFraction:h[0]/n,oneFraction:h[1]/n,le1Fraction:close/n}
}
export function detectRec2(data:Uint8Array){
 const start=performance.now(),rawEntropy=entropy(data.subarray(0,Math.min(2048,data.length)))
 if(data.length<4224||rawEntropy<=7.5)return {eligible:false,accepted:false,rawEntropy,reason:data.length<4224?'insufficient-independent-windows':'raw-entropy-gate',searchPairs:0,searchCandidates:0,detectMs:ms(performance.now()-start)}
 const n=2048,trainStart=63,holdoutStart=data.length-n,h=new Uint32Array(256)
 let best:({params:Rec2;fit:ReturnType<typeof sample>})|undefined,searchCandidates=0
 for(let b=2;b<=63;b++)for(let a=1;a<b;a++)for(let op=0;op<5;op++){
  const params={a,b,op},fit=sample(data,params,trainStart,n,h);searchCandidates++
  if(!best||fit.entropy<best.fit.entropy)best={params,fit}
 }
 assert.ok(best)
 const passes=(s:ReturnType<typeof sample>)=>s.le1Fraction>0.8||s.entropy<5
 const fitPass=passes(best.fit),holdout=sample(data,best.params,holdoutStart,n,h),holdoutPass=passes(holdout)
 return {eligible:true,accepted:fitPass&&holdoutPass,rawEntropy,params:best.params,operation:opNames[best.params.op],train:{start:trainStart,bytes:n,...best.fit},holdout:{start:holdoutStart,bytes:n,...holdout},fitPass,holdoutPass,searchPairs:1953,searchCandidates,detectMs:ms(performance.now()-start),reason:!fitPass?'no-concentrated-training-residual':!holdoutPass?'independent-holdout-rejected':'candidate-proposed-not-adopted'}
}
export function forwardRec2(data:Uint8Array,p:Rec2){
 assert.ok(Number.isSafeInteger(p.a)&&p.a>=1&&p.a<p.b&&p.b<=63&&p.op>=0&&p.op<5&&data.length>=p.b)
 const out=new Uint8Array(data.length-p.b)
 for(let i=p.b;i<data.length;i++)out[i-p.b]=residual(data[i],data[i-p.a],data[i-p.b],p.op)
 return out
}
export function inverseRec2(res:Uint8Array,seeds:Uint8Array,p:Rec2){
 assert.equal(seeds.length,p.b);const out=new Uint8Array(res.length+p.b);out.set(seeds)
 for(let i=p.b;i<out.length;i++)out[i]=p.op===4?res[i-p.b]^out[i-p.a]^out[i-p.b]:(res[i-p.b]+predict(out[i-p.a],out[i-p.b],p.op))&255
 return out
}
export function encodeRec2(data:Uint8Array,p:Rec2){
 const t=performance.now(),r=forwardRec2(data,p),transformMs=ms(performance.now()-t),e=performance.now()
 // O0 has only 1 adaptive table and is enough for Bernoulli residuals.
 const payload=encodeCM(r,'o0'),encodeMs=ms(performance.now()-e),header=new Uint8Array(16),v=new DataView(header.buffer)
 header.set([80,49,53,82,0,p.op,p.a,p.b]);v.setUint32(8,data.length,true);v.setUint32(12,payload.length,true)
 const frame=cat(header,data.subarray(0,p.b),payload)
 return {frame,details:{headerBytes:16,seedBytes:p.b,payloadBytes:payload.length,frameBytes:frame.length,residualBytes:r.length,residualEntropy:entropy(r),residualSha256:sha(r),zeroFraction:r.filter(v=>v===0).length/r.length,oneFraction:r.filter(v=>v===1).length/r.length,transformMs,encodeMs}}
}
export function decodeRec2(frame:Uint8Array){
 assert.ok(frame.length>=16);assert.deepEqual([...frame.subarray(0,5)],[80,49,53,82,0])
 const v=new DataView(frame.buffer,frame.byteOffset,frame.byteLength),p={op:frame[5],a:frame[6],b:frame[7]},n=v.getUint32(8,true),pl=v.getUint32(12,true)
 assert.ok(p.a>=1&&p.a<p.b&&p.b<=63&&p.op<5&&n>=p.b&&n<=262144)
 assert.equal(frame.length,16+p.b+pl)
 const seeds=frame.subarray(16,16+p.b),r=decodeCM(frame.subarray(16+p.b),n-p.b,'o0')
 return inverseRec2(r,seeds,p)
}
export function verifyRec2Frame(data:Uint8Array,p:Rec2){const {frame,details}=encodeRec2(data,p),t=performance.now(),out=decodeRec2(frame);eq(out,data);return {frame,details:{...details,decodeMs:ms(performance.now()-t),frameSha256:sha(frame),decodedSha256:sha(out),roundtrip:true}}}
