import assert from 'node:assert/strict'
import {input,same,sha,done,entropy} from './common'
import {encodeCM,decodeCM} from '../../../src/lib/coder'
import {bcjFwd,bcjInv,deltaFwd,deltaInv} from '../../../src/lib/transforms'
import {encodeTerrainGroup,decodeTerrainGroup,candidatesFor,ID} from '../../../src/lib/codec'
import {analyze,detectRecordStride,detectAnchors} from '../../../src/lib/analyze'
const {name,variant,data,meta}=input(),t=performance.now()
function u32(d:Uint8Array,i:number){return(d[i]|d[i+1]<<8|d[i+2]<<16|d[i+3]<<24)>>>0}
function put32(d:Uint8Array,i:number,x:number){d[i]=x;d[i+1]=x>>>8;d[i+2]=x>>>16;d[i+3]=x>>>24}
function extendedBCJ(d:Uint8Array,inverse=false){const o=new Uint8Array(d);for(let i=0;i<o.length;i++){
 const len=o[i]===0xe8||o[i]===0xe9?5:o[i]===0x0f&&o[i+1]>=0x80&&o[i+1]<=0x8f?6:0
 if(!len||i+len>o.length)continue
 const j=i+len-4,pc=(meta.offset+i+len)>>>0,v=u32(o,j);put32(o,j,(inverse?v-pc:v+pc)>>>0);i+=len-1
 }return o}
function alpha(d:Uint8Array,all:boolean,inverse=false){const o=new Uint8Array(d);assert.equal(meta.offset%4,0)
 for(let i=0;i+3<o.length;i+=4){const w=u32(o,i),op=w>>>26;if(all?op<0x30:op!==0x30&&op!==0x34)continue
  const pc=(meta.offset+i+4)/4,x=w&0x1fffff,v=(inverse?x-pc:x+pc)&0x1fffff;put32(o,i,((w&0xffe00000)|v)>>>0)
 }return o}
function structure(){
 const a=analyze(data),byClass:Record<string,number>={},period=detectRecordStride(data),op=new Uint32Array(64)
 for(let i=0;i+3<data.length;i+=4)op[u32(data,i)>>>26]++
 let e8e9=0,jcc=0;for(let i=0;i+4<data.length;i++){if(data[i]===0xe8||data[i]===0xe9){e8e9++;i+=4}else if(i+5<data.length&&data[i]===15&&data[i+1]>=128&&data[i+1]<=143){jcc++;i+=5}}
 for(const s of a.segs)byClass[s.cls]=(byClass[s.cls]??0)+s.end-s.start
 const segments=a.segs.slice().sort((a,b)=>(b.end-b.start)-(a.end-a.start)).slice(0,8).map(s=>{
  const d=data.subarray(s.start,s.end),sample=d.subarray(Math.max(0,Math.floor((d.length-16000)/2)),Math.min(d.length,Math.floor(Math.max(0,d.length-16000)/2)+16000))
  return {...s,candidateSpecs:candidatesFor(d,s.cls,s.bestS,sample),anchors:detectAnchors(d,s.cls)}
 })
 const lagStats=[4,8,64,512,4096,8192,16384].map(lag=>{let same=0;for(let i=lag;i<data.length;i++)if(data[i]===data[i-lag])same++;return {lag,equality:same/(data.length-lag),deltaH:entropy(deltaFwd(data,lag))}})
 return {recordStride:period,segments:a.segs.length,byClass,largestSegments:segments,asciiFraction:data.reduce((n,b)=>n+((b>=32&&b<127)||b===9||b===10||b===13?1:0),0)/data.length,zeroFraction:data.reduce((n,b)=>n+(b===0?1:0),0)/data.length,h0:entropy(data),lagStats,byteScannerCounts:{e8e9,jcc},alphaOpcodes:[...op.entries()].filter(([,n])=>n).sort((a,b)=>b[1]-a[1]),alphaBranchWords:[...op.slice(48)].reduce((a,b)=>a+b,0)}
}
if(variant==='stats')done({input:meta,variant,roundtrip:null,short:structure(),scope:'bounded input metadata/candidate eligibility scan only; no chooser, no encoding, no final group inference'})
else if(['tg4','tg8','sub-anchor-zero','sub-transpose'].includes(variant)){
 const width=variant==='tg4'?4:variant==='tg8'?8:detectRecordStride(data)
 const spec=variant==='sub-anchor-zero'?{id:ID.SUB_ANCHOR_V3,s:0,r:136}:variant==='sub-transpose'?{id:ID.SUB_TRANSPOSE,s:width,r:2}:{id:ID.TRANSPOSE_GROUP_V3,s:width,r:1}
 assert.ok(spec.id===ID.SUB_ANCHOR_V3||width>1,'No detected record stride')
 const p=encodeTerrainGroup([data],spec,undefined,undefined,undefined,[meta.offset],'v15')
 same(decodeTerrainGroup(p,[data.length],spec,undefined,[meta.offset],'v15')[0],data)
 done({input:meta,variant,payloadBytes:p.length,payloadSha256:sha(p),roundtrip:true,encodeDecodeMs:performance.now()-t,short:{spec},scope:'actual existing terrain group payload including internal framing, not adaptive chooser or UCZ container'})
}else{
 const f=(d:Uint8Array,inverse=false)=>variant==='base'?new Uint8Array(d):variant==='bcj'?(inverse?bcjInv(d,meta.offset):bcjFwd(d,meta.offset)):variant==='bcj-jcc'?extendedBCJ(d,inverse):variant==='alpha-br'?alpha(d,false,inverse):variant==='alpha-all'?alpha(d,true,inverse):variant==='page-delta'?(inverse?deltaInv(d,4096):deltaFwd(d,4096)):(()=>{throw Error('Unknown variant')})()
 const tr=f(data);same(f(tr,true),data)
 const p=encodeCM(tr,'bin',1,1,undefined,0,undefined,undefined,'v15'),encodeMs=performance.now()-t
 same(f(decodeCM(p,tr.length,'bin',1,1,undefined,'v15'),true),data)
 done({input:meta,variant,payloadBytes:p.length,payloadSha256:sha(p),roundtrip:true,encodeMs,short:{changedBytes:tr.reduce((n,b,i)=>n+(b!==data[i]?1:0),0)},scope:'v15 BIN payload after reversible research transform; no new UCZ transform ID or outer header'})
}
