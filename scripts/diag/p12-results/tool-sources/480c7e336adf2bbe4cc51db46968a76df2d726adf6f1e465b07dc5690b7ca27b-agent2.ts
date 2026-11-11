import assert from 'node:assert/strict'
import {input,same,sha,done,entropy,cat,varint} from './common'
import {encodeCM,decodeCM,a2Suppress,withCMBlockSize} from '../../../src/lib/coder'
import {encodeTerrainGroup,decodeTerrainGroup,ID} from '../../../src/lib/codec'
import {d16Fwd,d16Inv,medFwd,medInv,deltaFwd} from '../../../src/lib/transforms'
import {detectWide16Lag,detectLagCandidates} from '../../../src/lib/analyze'
const {name,variant,data,meta}=input(),t=performance.now()
function lanes(d:Uint8Array,w:number){return Array.from({length:w},(_,c)=>Uint8Array.from(d.filter((_,i)=>i%w===c)))}
function interleave(cols:Uint8Array[]){const n=cols.reduce((n,c)=>n+c.length,0),o=new Uint8Array(n);for(let i=0;i<n;i++)o[i]=cols[i%cols.length][Math.floor(i/cols.length)];return o}
function med(a:number,b:number,c:number){return c>=Math.max(a,b)?Math.min(a,b):c<=Math.min(a,b)?Math.max(a,b):a+b-c}
function med16(d:Uint8Array,r:number,inverse=false){const o=new Uint8Array(d.length),src=inverse?o:d,get=(i:number)=>i<0?0:src[i]|(src[i+1]<<8);for(let i=0;i+1<d.length;i+=2){const p=med(get(i-2),get(i-r),get(i-r-2)),v=d[i]|(d[i+1]<<8),x=(inverse?v+p:v-p)&65535;o[i]=x&255;o[i+1]=x>>>8}if(d.length&1)o[d.length-1]=d[d.length-1];return o}
function columnsStats(d:Uint8Array,w:number){return lanes(d,w).map((c,i)=>({column:i,n:c.length,rawH:entropy(c),deltaH:entropy(deltaFwd(c,1)),firstBytes:[...c.subarray(0,6)]}))}
function tgGroups(p:Uint8Array){let off=0,start=0;const g:any[]=[];while(off<p.length){const a=off,span=p[off++],mode=p[off++];let n=0,m=1,b;do{b=p[off++];n+=(b&127)*m;m*=128}while(b>=128);assert.ok(span>0&&start+span<=28&&off+n<=p.length);g.push({start,span,mode:mode&127,reverse:!!(mode&128),payloadBytes:n,headerBytes:off-a});start+=span;off+=n}assert.equal(start,28);return g}
function colDelta(d:Uint8Array,mask:number,inverse=false){const o=new Uint8Array(d.length);for(let i=0;i<d.length;i++){const prev=i>=28?(inverse?o[i-28]:d[i-28]):0;o[i]=(mask&(1<<(i%28)))?(inverse?d[i]+prev:d[i]-prev)&255:d[i]}return o}
function fieldDelta(d:Uint8Array,mask:number,inverse=false){const o=new Uint8Array(d),read=(s:Uint8Array,i:number)=>(s[i]|s[i+1]<<8|s[i+2]<<16|s[i+3]<<24)>>>0;for(let i=0;i+3<d.length;i+=4){if(!(mask&(1<<((i%28)/4))))continue;const pred=i>=28?read(inverse?o:d,i-28):0;const v=(inverse?read(d,i)+pred:read(d,i)-pred)>>>0;o[i]=v&255;o[i+1]=v>>>8;o[i+2]=v>>>16;o[i+3]=v>>>24}return o}
if(variant==='stats'){
 const cols=columnsStats(data,meta.file==='sao'?28:2),lag=meta.file==='sao'?0:detectWide16Lag(data)
 const diff=d16Fwd(data,1,1),residual=columnsStats(diff,2)
 done({input:meta,variant,short:{columns:cols,wide16Lag:lag,byteLagCandidates:detectLagCandidates(data,2),residual},roundtrip:true,encodeMs:performance.now()-t,scope:'descriptive entropy/lag scan only, no full-file scan or compressed-size claim'})
}else if(variant.startsWith('tg-')){
 let transformed=data,mask=0,side=0
 if(variant==='tg-adaptive'){
  const train=data.subarray(0,Math.floor(data.length/4/28)*28),stats=columnsStats(train,28)
  for(const c of stats)if(c.deltaH<c.rawH)mask|=1<<c.column
  transformed=colDelta(data,mask);same(colDelta(transformed,mask,true),data);side=4
 }else if(variant==='tg-delta32'){
  const train=data.subarray(0,Math.floor(data.length/4/28)*28),diff=fieldDelta(train,127)
  const a=lanes(train,28),b=lanes(diff,28)
  for(let f=0;f<7;f++){let x=0,y=0;for(let k=0;k<4;k++){x+=entropy(a[4*f+k]);y+=entropy(b[4*f+k])}if(y<x)mask|=1<<f}
  transformed=fieldDelta(data,mask);same(fieldDelta(transformed,mask,true),data);side=1
 }else assert.equal(variant,'tg-base')
 const spec={id:ID.TRANSPOSE_GROUP_V3,s:28,r:1},p=encodeTerrainGroup([transformed],spec,undefined,undefined,undefined,[meta.offset],'v15')
 const encodeMs=performance.now()-t,back=decodeTerrainGroup(p,[data.length],spec,undefined,[meta.offset],'v15')[0]
 same(back,transformed);same(variant==='tg-adaptive'?colDelta(back,mask,true):variant==='tg-delta32'?fieldDelta(back,mask,true):back,data)
 done({input:meta,variant,payloadBytes:p.length,bytes:p.length+side,sideBytes:side,payloadSha256:sha(p),roundtrip:true,encodeMs,short:{mask,groups:tgGroups(p)},scope:'actual TG3 group payload; adaptive oracle also charges mask bytes; no UCZ outer/version cost'})
}else{
 const lag=detectWide16Lag(data),isMed=variant.startsWith('med16')||variant==='byte-med'
 assert.ok(!isMed||lag>0,'No repeatable row width; do not invent one')
 const residual=variant==='byte-med'?medFwd(data,2,lag):isMed?med16(data,lag):d16Fwd(data,1,1)
 const inv=(d:Uint8Array)=>variant==='byte-med'?medInv(d,2,lag):isMed?med16(d,lag,true):d16Inv(d,1,1)
 same(inv(residual),data)
 const split=variant.endsWith('-split'),stacked=variant.endsWith('-stacked')
 assert.ok(['d16','d16-split','d16-stacked','byte-med','med16','med16-split'].includes(variant))
 const columns=lanes(residual,2),streams=split?columns:[stacked?cat(columns):residual],encoded:Uint8Array[]=[],decoded:Uint8Array[]=[]
 a2Suppress.depth++
 try{withCMBlockSize(data.length,()=>{
  for(const s of streams){const phase=split||stacked?1:2,row=isMed?(split?lag/2:lag):1,profile=isMed?'res2d':'res';const p=encodeCM(s,profile,phase,row,undefined,0,undefined,undefined,'v15');encoded.push(p);decoded.push(decodeCM(p,s.length,profile,phase,row,undefined,'v15'))}
 })}finally{a2Suppress.depth--}
 const recovered=split?interleave(decoded):stacked?interleave([decoded[0].subarray(0,columns[0].length),decoded[0].subarray(columns[0].length)]):decoded[0]
 same(inv(recovered),data)
 // Two physical streams need one mode byte + a self-delimiting first payload length;
 // decoded stream lengths derive from the original length. Extra format ID not priced.
 const payloadBytes=encoded.reduce((n,p)=>n+p.length,0),sideBytes=split?1+varint(encoded[0].length).length:stacked?1:0
 done({input:meta,variant,payloadBytes,bytes:payloadBytes+sideBytes,sideBytes,payloadSha256:sha(cat(encoded)),roundtrip:true,encodeDecodeMs:performance.now()-t,short:{lag,streamBytes:encoded.map(p=>p.length),residualEntropy:columns.map(entropy)},scope:'v15 residual CM with row A2 suppressed; two-stream framing charged; no new UCZ ID/header; true16bit MED is research-only'})
}
