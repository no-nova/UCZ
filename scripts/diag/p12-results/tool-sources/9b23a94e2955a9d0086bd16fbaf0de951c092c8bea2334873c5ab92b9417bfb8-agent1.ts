import {input,same,sha,done} from './common'
import {encodeCM,decodeCM,apmTuning,mixer2Tuning,match3Tuning} from '../../../src/lib/coder'
const {name,variant,data,meta}=input()
const profile=(meta.file==='xml'||meta.file==='nci'||meta.file==='samba')?'text':'bin'
if(variant==='a1-ms')apmTuning.ctx=2
if(variant==='mixer2-off')mixer2Tuning.on=false
if(variant==='gap2')match3Tuning.gapResume=true
const nctx=9,loss=new Float64Array(nctx),sum=new Float64Array(nctx),square=new Float64Array(nctx),cross=new Float64Array(4)
const pairs=[[3,4],[4,5],[6,7],[5,8]],prob=new Float64Array(nctx)
let bitCount=0,matchBits=0,wrongMatchBits=0,matchLoss=0,plainLoss=0,checks=0,hashReject=0
if(variant==='attrib'){
 ;(globalThis as any).__P12_BIT=(m:any,y:number,p:number,mi:number,expect:number)=>{
  bitCount++;const bitLoss=-Math.log2((y?p:4096-p)/4096)
  if(mi>=0){matchBits++;wrongMatchBits+=expect!==y?1:0;matchLoss+=bitLoss}else plainLoss+=bitLoss
  for(let i=0;i<nctx;i++){
   const q=Math.max(1,Math.min(65535,m.tables[i][m.idx[i]]>>>16))/65536
   prob[i]=q;loss[i]-=Math.log2(y?q:1-q);sum[i]+=q;square[i]+=q*q
  }
  for(let k=0;k<pairs.length;k++)cross[k]+=prob[pairs[k][0]]*prob[pairs[k][1]]
 }
 ;(globalThis as any).__P12_MATCH4=(l:number,min:number)=>{checks++;if(l<min)hashReject++}
}
const costs=new Float32Array(data.length),t=performance.now()
const packed=encodeCM(data,profile,1,1,costs,0,undefined,undefined,'v15')
const encodeMs=performance.now()-t
;(globalThis as any).__P12_BIT=null;(globalThis as any).__P12_MATCH4=null
same(decodeCM(packed,data.length,profile,1,1,undefined,'v15'),data)
const correlations=pairs.map(([a,b],i)=>({a,b,pearson:(cross[i]-sum[a]*sum[b]/Math.max(1,bitCount))/Math.sqrt(Math.max(1e-30,(square[a]-sum[a]**2/Math.max(1,bitCount))*(square[b]-sum[b]**2/Math.max(1,bitCount))))}))
done({input:meta,profile,variant,payloadBytes:packed.length,payloadSha256:sha(packed),codedBits:costs.reduce((a,b)=>a+b,0),encodeMs,roundtrip:true,
 attribution:variant==='attrib'?{bitCount,contextIndependentLossBits:[...loss],correlations,matchBits,wrongMatchBits,matchLoss,plainLoss,lookup4:checks,lookup4Rejected:hashReject}:null,
 scope:'raw v15 CM micro-oracle; no UCZ container or new format emitted; context loss/correlation is descriptive, not additive causal attribution'})
