import assert from 'node:assert/strict'
import {loadSlice} from '../scripts/diag/p141/input'
import {ID,encodeTerrainGroup,type Spec} from '../src/lib/codec'
import {groupKernelSample} from '../src/lib/group-policy'
import {withCMProbe,V20_FLAG_CM} from '../src/lib/coder'
import {payloadModelFlags} from '../src/lib/payload-model'
// Bounded audit of the 0.9985 legacy-upgrade pre-screen: for groups whose v20
// sample looks worse than 0.9985, does the FULL v20 payload still shrink?
// Measurement only; no production threshold is changed by this test.
const [name='x-ray-mid']=process.argv.slice(2)
const {data}=loadSlice(name)
const n=Math.min(Number(process.argv[3]??16384),data.length)
const part=data.subarray(0,n)
const ALL:Spec[]=[
 {id:ID.DELTA,s:4,r:1},{id:ID.DELTA_V3,s:4,r:1},{id:ID.TRANSPOSE,s:8,r:1},
 {id:ID.TRANSPOSE_GROUP,s:8,r:1},{id:ID.TRANSPOSE_2D,s:8,r:1},{id:ID.GRAD_V3,s:2,r:8192},
 {id:ID.SUB_TRANSPOSE,s:8,r:1},{id:ID.SUB_TRANSPOSE_V3,s:8,r:1},
]
// One case per process keeps every run inside the 17 s child budget.
const pick=Number(process.argv[4]??-1),cases=pick>=0?[ALL[pick]]:ALL
const rows:any[]=[]
for(const spec of cases){
 const sample=groupKernelSample([part],[0],spec.s>=2&&spec.id!==ID.GRAD_V3?spec.s:1,12*1024)
 const oldKernel=withCMProbe(()=>encodeTerrainGroup(sample.parts,spec,undefined,undefined,undefined,sample.positions,false))
 const v20=withCMProbe(()=>encodeTerrainGroup(sample.parts,spec,undefined,undefined,undefined,sample.positions,'v20'))
 const passesScreen=v20.length<oldKernel.length*0.9985
 const fullOld=withCMProbe(()=>encodeTerrainGroup([part],spec,undefined,undefined,undefined,[0],false))
 const fullV20=withCMProbe(()=>encodeTerrainGroup([part],spec,undefined,undefined,undefined,[0],'v20'))
 const fullWins=fullV20.length<fullOld.length&&(payloadModelFlags(fullV20)&V20_FLAG_CM)!==0
 rows.push({spec:`${spec.id}/${spec.s}/${spec.r}`,sampleOld:oldKernel.length,sampleV20:v20.length,samplePasses:passesScreen,
  fullOld:fullOld.length,fullV20:fullV20.length,fullWins,missedByScreen:!passesScreen&&fullWins,
  sampleDeltaPct:+((v20.length/oldKernel.length-1)*100).toFixed(3),fullDeltaPct:+((fullV20.length/fullOld.length-1)*100).toFixed(3)})
}
assert.ok(rows.length===cases.length)
const missed=rows.filter(r=>r.missedByScreen),wouldGain=missed.reduce((n,r)=>n+(r.fullOld-r.fullV20),0)
console.log(JSON.stringify({input:name,n,caseIndex:pick,rows,missedByScreen:missed.length,missedGainBytes:wouldGain,
 scope:'64 KiB bounded slice, 192 KiB sample budget never reached; not a full-file measurement'}))
