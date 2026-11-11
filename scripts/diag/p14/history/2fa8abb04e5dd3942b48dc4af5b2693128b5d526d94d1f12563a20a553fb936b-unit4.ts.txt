// Unit 4: actual v20 CM; predictive diagnostics use pre-update probabilities.
import { encodeCM,decodeCM,p14,setNoMht8,cmTableShape } from '@lib/coder'
import { analyze } from '@lib/analyze'
import { load,eq,sha,done,entropy } from './common'
const [name,variant]=process.argv.slice(2),{entry,data}=load(name)
if(variant==='structure') {
 const hist=new Uint32Array(256),distance=new Uint32Array(257),last=new Map<number,number>()
 let ascii=0,zero=0,verified4GramRepeats=0
 for(let i=0;i<data.length;i++) {
  const b=data[i];hist[b]++;if(b===0)zero++;if(b===9||b===10||b===13||(b>=32&&b<127))ascii++
  if(i>=3) {
   const x=(data[i-3]|data[i-2]<<8|data[i-1]<<16|b<<24)>>>0
   if(data[i-3]===data[i-2]&&data[i-2]===data[i-1]&&data[i-1]===b)continue
   const p=last.get(x);if(p!==undefined&&i-p<=256){distance[i-p]++;verified4GramRepeats++}last.set(x,i)
  }
 }
 const a=analyze(data),byClass:Record<string,number>={};for(const s of a.segs)byClass[s.cls]=(byClass[s.cls]??0)+s.end-s.start
 done({unit:4,input:entry,variant,analysisOnly:true,cmCalls:0,asciiFraction:ascii/data.length,zeroFraction:zero/data.length,entropyBitsPerByte:entropy(data),
  delimiterCounts:{tab:hist[9],lf:hist[10],cr:hist[13],zero:hist[0]},analysisInputBytesByClass:byClass,
  nonUniform4GramNearestRepeatCounts:verified4GramRepeats,repeatDistance43to55:[...distance.slice(43,56)],
  topDistances:[...distance.entries()].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([distance,count])=>({distance,count})),
  scope:'nearest repeated nonuniform four-byte strings, not a proved record parser or full-file record-size distribution'})
}else {
 const isText=['text','profile-text','text-class'].includes(variant)||['webster','dickens','reymont','nci','xml'].includes(entry.file)
 const profile=isText?'text':'bin',instrumented=variant.startsWith('profile')
 const stats:any={nBits:0,contexts:[],matchByteStates:[0,0,0,0],nearMatchBytes:0,farMatchBytes:0,maxAbsWeight:0}
 const tags:Uint32Array[]=[],seen:Uint8Array[]=[]
 if(instrumented)p14.learnHook=(m:any,y:number)=>{
  if(!stats.contexts.length)for(let i=0;i<m.nctx;i++) {
   stats.contexts.push({index:i,lossBits:0,firstHalfLossBits:0,secondHalfLossBits:0,coldVisits:0,saturatedVisits:0,bit0TrackedSlotRevisits:0,bit0HashAliases:0})
   tags.push(new Uint32Array(m.tables[i].length));seen.push(new Uint8Array(m.tables[i].length))
  }
  stats.nBits++
  for(let i=0;i<m.nctx;i++) {
   const st=stats.contexts[i],k=m.idx[i],e=m.tables[i][k],p=Math.max(1,Math.min(65534,e>>>16))/65535
   const loss=-Math.log2(y?p:1-p);st.lossBits+=loss
   if(m.pos<data.length/2)st.firstHalfLossBits+=loss;else st.secondHalfLossBits+=loss
   const n=e&255;if(n===0)st.coldVisits++;if(n===m.limit)st.saturatedVisits++
   if(m.bit===0) {
    const cm=Math.imul(m.c0,0x9e3779b1);let h=Math.imul(m.hashes[i]^cm,0x85ebca6b);h=(h^(h>>>15))>>>0
    if(seen[i][k]){st.bit0TrackedSlotRevisits++;if(tags[i][k]!==h)st.bit0HashAliases++}
    seen[i][k]=1;tags[i][k]=h
   }
  }
  if(m.bit===0){stats.matchByteStates[m.mlen===0?0:m.mlen<6?1:m.mlen<16?2:3]++;if(m.mlen>0){if(m.pos-m.mptr<=64)stats.nearMatchBytes++;else stats.farMatchBytes++}}
  if(m.pos===data.length-1&&m.bit===7) {
   stats.modelGeometry=m.geometry;stats.countLimit=m.limit
   for(const w of m.weights)stats.maxAbsWeight=Math.max(stats.maxAbsWeight,Math.abs(w))
   stats.weights=[...m.weights];stats.secondaryWeightsRange=m.weights2?[Math.min(...m.weights2),Math.max(...m.weights2)]:null
  }
 }
 if(variant==='no-mht8')setNoMht8(true)
 const t=performance.now(),payload=encodeCM(data,profile,1,1,undefined,0,undefined,undefined,'v20'),encodeMs=performance.now()-t
 p14.learnHook=null
 const d=performance.now(),out=decodeCM(payload,data.length,profile,1,1,undefined,'v20');eq(out,data)
 if(instrumented)for(const c of stats.contexts){c.bitsPerByte=c.lossBits/data.length;c.coldFraction=c.coldVisits/stats.nBits;c.saturatedFraction=c.saturatedVisits/stats.nBits;c.sampledSlotAliasFraction=c.bit0TrackedSlotRevisits?c.bit0HashAliases/c.bit0TrackedSlotRevisits:0}
 done({unit:4,input:entry,variant,profile,kernel:'v20',payloadBytes:payload.length,payloadSha256:sha(payload),roundtrip:true,
  productionCompatible:['control','text','profile','profile-text'].includes(variant),instrumented,
  ...(instrumented?{stats,statsWarning:'individual pre-update expert log-loss is not additive mixer cost; slot alias metric samples bit0 only; no long-stream aging inference'}:{}),
  tableShapesMetadataOnly:[data.length,512*1024,4*1024*1024,8*1024*1024].map(n=>cmTableShape(n)),
  encodeMs:Math.round(encodeMs),decodeMs:Math.round(performance.now()-d),scope:'fixed 256KiB v20 CM payload, cold stream; not >=8MiB model aging/performance evidence'})
}
