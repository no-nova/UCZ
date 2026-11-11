import assert from 'node:assert/strict'
import { encodeCM as stockEncode, decodeCM as stockDecode, withCMBlockSize as stockScope, a2Tuning as stockA2 } from '@stock/coder'
import { planHeader, decompress as stockDecompress, contextGroupCandidatesSync } from '@stock/codec'
import { payloadModelFlags as stockFlags } from '@stock/payload-model'
import { encodeCM, decodeCM, encodeCMContextDual, p15, withCMBlockSize, a2Tuning } from '@lib/coder'
import { payloadModelFlags } from '@lib/payload-model'
import { deltaFwd, deltaInv } from '@lib/transforms'
import { encodePeeledTranspose, decodePeeledTranspose, inspectPeeledTranspose } from '@lib/sub-peel'
import { encodeTerrainGroup, decodeTerrainGroup, ID } from '@lib/codec'
import { wordPreFwdSampled, wordPreInv } from '@stock/wordpre'
import { load, eq, sha, ms, cat, entropy, done, synthetic } from './common'
const [name,variant,b='65536',o='0']=process.argv.slice(2),{data,input}=load(name,Number(b),Number(o)),start=performance.now()
function stockEnc(d:Uint8Array,context?:'bin-stride4'|'wp-token3',wp=false){return stockScope(data.length,()=>stockEncode(d,wp?'text':'bin',1,1,undefined,0,undefined,undefined,'v20',0,wp,context?{context}:undefined))}
function stockDec(p:Uint8Array,n:number,context?:'bin-stride4'|'wp-token3',wp=false){return stockScope(data.length,()=>stockDecode(p,n,wp?'text':'bin',1,1,undefined,'v20',0,wp,context?{context}:undefined))}
function binFrame(d:Uint8Array,p:Uint8Array,context?:'bin-stride4'){
 const spec={id:24,s:1,r:1},h=Uint8Array.from(planHeader(d.length,[{start:0,end:d.length,cls:'binary',spec}],[{spec,members:[0],payload:p,v15:true,context}]))
 const c=cat(h,p);eq(stockDecompress(c),d);return {containerBytes:c.length,headerBytes:h.length,containerSha256:sha(c)}
}
function binPair(d:Uint8Array,frames=false){
 const rows:any[]=[]
 for(const context of [undefined,'bin-stride4'] as const){const t=performance.now(),p=stockEnc(d,context),encodeMs=ms(performance.now()-t),dt=performance.now();eq(stockDec(p,d.length,context),d)
  rows.push({context:context??'v20-control',inputBytes:d.length,inputSha256:sha(d),payloadBytes:p.length,payloadSha256:sha(p),encodeMs,decodeMs:ms(performance.now()-dt),roundtrip:true,...(frames?binFrame(d,p,context):{})})}
 return rows
}
if(variant==='raw') {
 const rows=binPair(data,true);done({unit:1,input,variant,rows,savedBytes:rows[0].containerBytes-rows[1].containerBytes,scope:'actual production v20/v21 forced identity-BIN containers; NOT adaptive'})
}else if(variant==='delta1'||variant==='delta4'){
 const stride=Number(variant.at(-1)),transformed=deltaFwd(data,stride);eq(deltaInv(transformed,stride),data)
 const rows:any[]=[]
 for(const mode of ['actual-res-v20','bin-v20','bin-stride4'] as const){const profile=mode==='actual-res-v20'?'res':'bin',s=profile==='res'?stride:1,options=mode==='bin-stride4'?{context:'bin-stride4' as const}:undefined,t=performance.now()
  const p=withCMBlockSize(data.length,()=>encodeCM(transformed,profile,s,1,undefined,0,undefined,undefined,'v20',0,false,options)),encodeMs=ms(performance.now()-t),dt=performance.now()
  const r=withCMBlockSize(data.length,()=>decodeCM(p,data.length,profile,s,1,undefined,'v20',0,false,options));eq(r,transformed);eq(deltaInv(r,stride),data)
  rows.push({mode,profile,s,payloadBytes:p.length,payloadSha256:sha(p),encodeMs,decodeMs:ms(performance.now()-dt),roundtrip:true})}
 done({unit:1,input,variant,transformedSha256:sha(transformed),entropy:entropy(transformed),rows,contextOnlySavedBytes:rows[1].payloadBytes-rows[2].payloadBytes,vsActualResSavedBytes:rows[0].payloadBytes-rows[2].payloadBytes,scope:'fixed DELTA residual; production DELTA uses res, not bin. Payload only; new profile/framing not implemented'})
}else if(/^sub8-(v13|v20|stride4)$/.test(variant)){
 const kernel=variant==='sub8-v13'?'v13':'v20';p15.binStride=variant==='sub8-stride4'
 const parts=[data.subarray(0,Math.floor(data.length/2)),data.subarray(Math.floor(data.length/2))],t=performance.now()
 const p=encodePeeledTranspose(parts,8,'bin',kernel),encodeMs=ms(performance.now()-t),dt=performance.now(),out=decodePeeledTranspose(p,parts.map(p=>p.length),8,'bin',kernel)
 eq(cat(...out),data)
 done({unit:1,input,variant,kernel,payloadBytes:p.length,payloadSha256:sha(p),subFrameIncluded:true,layout:inspectPeeledTranspose(p,8),encodeMs,decodeMs:ms(performance.now()-dt),roundtrip:true,scope:'real SUB transpose with fixed width8 and two members; inner planner may change; v13-to-v20 and H8 deltas must be separated; experimental, not UCZ'})
}else if(/^tg4-(v13|v20|stride4)$/.test(variant)){
 const kernel=variant==='tg4-v13'?'v13':'v20';p15.binStride=variant==='tg4-stride4';const spec={id:ID.TRANSPOSE_GROUP_V3,s:4,r:1},t=performance.now()
 const p=encodeTerrainGroup([data],spec,undefined,undefined,undefined,[0],kernel),encodeMs=ms(performance.now()-t),dt=performance.now(),out=decodeTerrainGroup(p,[data.length],spec,undefined,[0],kernel)
 eq(cat(...out),data)
 done({unit:1,input,variant,kernel,payloadBytes:p.length,payloadSha256:sha(p),subFrameIncluded:true,encodeMs,decodeMs:ms(performance.now()-dt),roundtrip:true,scope:'actual TG3 width4 bounded planner, inner bin geomStride retained except experimental H8; not adaptive or deployable UCZ'})
}else if(variant==='screen-existing'){
 assert.equal(data.length,262144)
 const t=performance.now(),r=contextGroupCandidatesSync([data],{id:24,s:1,r:1},[0],undefined,true)
 assert.ok(!r.error,r.error)
 const control=r.control?{payloadBytes:r.control.payload.length,payloadSha256:sha(r.control.payload),...binFrame(data,r.control.payload)}:null
 const trials=r.trials.map(x=>({context:x.context,payloadBytes:x.payload.length,payloadSha256:sha(x.payload),...binFrame(data,x.payload,'bin-stride4')}))
 done({unit:1,input,variant,screen:r.screen,skipped:r.skipped,control,trials,fullCandidateInputBytes:r.fullCandidateInputBytes,elapsedMs:ms(performance.now()-t),roundtrip:!!trials.length,scope:'actual P14.1 group candidate screen (head/middle/tail joined, not a prefix for BIN), followed by any admitted full forced BIN candidates; NOT adaptive'})
}else if(variant.startsWith('screen-')){
 assert.equal(data.length,262144)
 const ranges=variant==='screen-prefix'?[[0,196608]]:variant==='screen-scatter'?[[0,65536],[98304,65536],[196608,65536]]:variant==='screen-full'?[[0,262144]]:null;assert.ok(ranges)
 const windows=ranges.map(([at,len])=>({offset:at,bytes:len,rows:binPair(data.subarray(at,at+len),true)}))
 const control=windows.reduce((n,w)=>n+w.rows[0].containerBytes,0),candidate=windows.reduce((n,w)=>n+w.rows[1].containerBytes,0)
 done({unit:1,input,variant,windows,controlBytes:control,candidateBytes:candidate,savedBytes:control-candidate,improvement:(control-candidate)/control,gate015pct:candidate<control*0.9985,relaxedStrictGate:candidate<control,roundtrip:true,scope:'prefix / three independently reset 64KiB sample containers / full forced BIN. Stratified cost is a screening proxy, not the full joined group cost; not adaptive'})
}else if(variant==='dual-bin'||variant==='dual-wp'||variant==='dual-boundary'){
 const boundary=variant==='dual-boundary',wp=variant==='dual-wp',context=wp?'wp-token3':'bin-stride4'
 let cmInput=data,pre:ReturnType<typeof wordPreFwdSampled>=null
 if(wp){pre=wordPreFwdSampled(data,262144);assert.ok(pre);eq(wordPreInv(pre.header,pre.body,data.length),data);cmInput=cat(pre.header,pre.body)}
 function pair(d:Uint8Array,c:'bin-stride4'|'wp-token3'){
  const words=c==='wp-token3',base=stockScope(data.length,()=>stockEncode(d,words?'text':'bin',1,1,undefined,0,undefined,undefined,'v20',0,words)),alt=stockScope(data.length,()=>stockEncode(d,words?'text':'bin',1,1,undefined,0,undefined,undefined,'v20',0,words,{context:c}))
  return {base,alt}
 }
 function shared(d:Uint8Array,c:'bin-stride4'|'wp-token3'){return withCMBlockSize(data.length,()=>encodeCMContextDual(d,c))}
 function verify(a:ReturnType<typeof pair>,d:ReturnType<typeof shared>,raw:Uint8Array,c:'bin-stride4'|'wp-token3',decode=true){
  eq(a.base,d.base);eq(a.alt,d.alt);assert.equal(stockFlags(a.base),payloadModelFlags(d.base));assert.equal(stockFlags(a.alt),payloadModelFlags(d.alt))
  if(decode){const words=c==='wp-token3';eq(stockScope(data.length,()=>stockDecode(d.base,raw.length,words?'text':'bin',1,1,undefined,'v20',0,words)),raw);eq(stockScope(data.length,()=>stockDecode(d.alt,raw.length,words?'text':'bin',1,1,undefined,'v20',0,words,{context:c})),raw)}
 }
 if(boundary){
  const cases:any[]=[]
  for(const textOn of [true,false])for(const c of ['bin-stride4','wp-token3'] as const)for(const n of [0,1,2,3,4,7,8,11,12,15,16,31,32,63,127,255,1024]){
   stockA2.textOn=a2Tuning.textOn=textOn;const x=synthetic('random',Math.max(1,n)).subarray(0,n),a=pair(x,c),d=shared(x,c);verify(a,d,x,c);cases.push({n,c,textOn,baseBytes:d.base.length,altBytes:d.alt.length})}
  stockA2.textOn=a2Tuning.textOn=true
  done({unit:1,input,variant,cases,caseCount:cases.length,bothStreamsByteIdentical:true,flagsIdentical:true,roundtrip:true,scope:'synthetic edge lengths with text a2 on/off; independent production decoders'})
 }else{
  // Warm both distinct code paths before timings. Repetitions alternate AB/BA;
  // all independent calls are the unpatched production module.
  const warm=cmInput.subarray(0,Math.min(8192,cmInput.length));verify(pair(warm,context),shared(warm,context),warm,context,false)
  const repeats:any[]=[];let sharing:any
  for(let i=0;i<3;i++){
   let a:ReturnType<typeof pair>,d:ReturnType<typeof shared>,separateMs:number,dualMs:number,t:number
   if(i%2===0){t=performance.now();a=pair(cmInput,context);separateMs=ms(performance.now()-t);t=performance.now();d=shared(cmInput,context);dualMs=ms(performance.now()-t)}
   else{t=performance.now();d=shared(cmInput,context);dualMs=ms(performance.now()-t);t=performance.now();a=pair(cmInput,context);separateMs=ms(performance.now()-t)}
   verify(a,d,cmInput,context,i===0);sharing=d.sharing
   repeats.push({order:i%2===0?'independent-then-dual':'dual-then-independent',separateMs,dualMs,savedMs:ms(separateMs-dualMs),reductionPct:100*(1-dualMs/separateMs),baseBytes:d.base.length,altBytes:d.alt.length,baseSha256:sha(d.base),altSha256:sha(d.alt),bothStreamsByteIdentical:true,flagsIdentical:true})
  }
  const separateMs=repeats.reduce((n,r)=>n+r.separateMs,0),dualMs=repeats.reduce((n,r)=>n+r.dualMs,0)
  done({unit:1,input,variant,context,cmInputBytes:cmInput.length,cmInputSha256:sha(cmInput),dictionaryBytes:pre?.header.length??0,repeats,aggregate:{separateMs:ms(separateMs),dualMs:ms(dualMs),reductionPct:100*(1-dualMs/separateMs)},sharing,roundtrip:true,totalWorkMs:ms(performance.now()-start),scope:'warm alternating-order serial Arena microbenchmark, both streams match unmodified production, includes allocations; not full-file throughput or measured RSS'})
 }
}else throw Error(`unknown unit1 variant ${variant}`)
