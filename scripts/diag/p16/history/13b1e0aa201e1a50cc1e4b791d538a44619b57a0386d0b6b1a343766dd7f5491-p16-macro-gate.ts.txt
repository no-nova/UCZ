import assert from 'node:assert/strict'
import {loadSlice} from '../scripts/diag/p141/input'
import {compressAdaptive,decompress} from '../src/lib/codec'
// Does the PRODUCTION adaptive path (real macroUniformGate, real sampling) propose a
// macro candidate at all on a bounded slice, and does the 23/24 arbitration run?
const [name='samba-mid']=process.argv.slice(2),{data,input}=loadSlice(name)
const full=data.subarray(0,Math.min(65536,data.length))
async function main(){
 const on=await compressAdaptive(full,undefined,{serial:true})
 const off=await compressAdaptive(full,undefined,{serial:true,contextCandidates:false})
 assert.deepEqual(Buffer.from(decompress(on.container)),Buffer.from(full))
 assert.ok(on.container.length<=off.container.length,'refinement must never grow the container')
 const m=on.macroComparison
 console.log(JSON.stringify({input,
  baseline:off.container.length,refined:on.container.length,bytes:full.length,delta:on.container.length-off.container.length,
  macro:m?{proposed:true,accepted:m.accepted,baselineBytes:m.baselineBytes,candidateBytes:m.candidateBytes,proposal:m.proposal,screen:m.screen,probe:m.contextMacroProbe,error:m.error}:{proposed:false},
  groups:on.segs.map(s=>({id:s.spec.id,s:s.spec.s,r:s.spec.r,context:s.context,compLen:s.compLen}))}))
}
main().catch(e=>{console.error(e);process.exitCode=1})
