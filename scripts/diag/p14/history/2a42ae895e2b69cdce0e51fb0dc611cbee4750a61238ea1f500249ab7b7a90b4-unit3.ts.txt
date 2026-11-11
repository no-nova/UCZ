// Unit 3: real forced BIN3/BCJ25-v20 windows and bounded analysis (not final group attribution).
import { encodeTerrainGroup,decodeTerrainGroup,ID } from '@lib/codec'
import { analyze,analyzeTuning,BLOCK } from '@lib/analyze'
import { load,eq,sha,done,entropy } from './common'
const [name,variant]=process.argv.slice(2),{entry,data}=load(name)
if(variant==='inspect') {
 const a=analyze(data),old={...analyzeTuning}
 let unsmoothed:any
 try {analyzeTuning.majorityFilter=false;analyzeTuning.minRunBlocks=0;unsmoothed=analyze(data)}finally{Object.assign(analyzeTuning,old)}
 const byClass:Record<string,number>={},fragmented:Record<string,number>={}
 for(const s of a.segs){byClass[s.cls]=(byClass[s.cls]??0)+s.end-s.start;fragmented[s.cls]=(fragmented[s.cls]??0)+1}
 const opcode=new Uint32Array(64)
 for(let i=0;i+3<data.length;i+=4)opcode[data[i+3]>>>2]++
 const phaseEntropy=Array.from({length:4},(_,p)=>entropy(Uint8Array.from(data.filter((_,i)=>i%4===p))))
 const lagAgreement=Object.fromEntries([1,2,4,8,12,16,28,48].map(k=>{let hit=0;for(let i=k;i<data.length;i++)if(data[i]===data[i-k])hit++;return[k,hit/(data.length-k)]}))
 const suspicious=a.segs.filter(s=>{
  const blocks=a.blocks.slice(s.b0,s.b1);return blocks.some(b=>b.h0>7.5)&&blocks.some(b=>b.h0<5.5)
 }).map(s=>({start:s.start,end:s.end,cls:s.cls,bytes:s.end-s.start}))
 done({unit:3,input:entry,variant,analysisOnly:true,cmCalls:0,blockBytes:BLOCK,segments:a.segs.length,unsmoothedSegments:unsmoothed.segs.length,
  byClassInputBytes:byClass,segmentsPerClass:fragmented,entropyBitsPerByte:entropy(data),phaseEntropy,lagAgreement,
  topLittleEndianHigh6BitOpcodes:[...opcode.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12).map(([op,count])=>({op,count})),
  mixedLowHighEntropySegments:suspicious,segmentDirectory:a.segs,
  scope:'256KiB bounded analysis-derived labels ONLY; no adaptive chooser, no actual final group or compressed-byte attribution'})
}else {
 const spec={id:variant.startsWith('bcj2')?ID.BCJ_V3:ID.BIN_V3,s:variant.startsWith('bcj2')?2:1,r:1}
 const t=performance.now(),payload=encodeTerrainGroup([data],spec,undefined,undefined,undefined,[0],'v20'),encodeMs=performance.now()-t
 const d=performance.now(),[out]=decodeTerrainGroup(payload,[data.length],spec,undefined,[0],'v20');eq(out,data)
 done({unit:3,input:entry,variant,spec,positionOrigin:0,kernel:'v20',payloadBytes:payload.length,payloadSha256:sha(payload),roundtrip:true,
  productionCompatible:['control','bcj2'].includes(variant),encodeMs:Math.round(encodeMs),decodeMs:Math.round(performance.now()-d),
  scope:'forced complete v20 group payload of a fixed 256KiB window; no full-file routing or UCZ header'})
}
