import assert from 'node:assert/strict'
import {loadSlice} from '../scripts/diag/p141/input'
import {ID,compressMacroPlanForProbe,decompress} from '../src/lib/codec'
const [name='samba-mid',size='65536',id='23']=process.argv.slice(2),{data,input}=loadSlice(name,Number(size)),half=data.length>>>1
const picks=[{start:0,end:half,cls:'text' as const,spec:{id:ID.TEXT_V3,s:1,r:1}}, {start:half,end:data.length,cls:'binary' as const,spec:{id:ID.BIN_V3,s:1,r:1}}]
async function main(){
 const result=await compressMacroPlanForProbe(data,picks,{id:Number(id),s:1,r:1},true)
 assert.deepEqual(Buffer.from(decompress(result.container)),Buffer.from(data))
 const comp=result.macroComparison;assert.ok(comp);assert.ok(!comp.error,comp.error);assert.ok(comp.contextMacroProbe, 'missing cross-profile sample');assert.ok(!comp.contextMacroProbe.error,comp.contextMacroProbe.error)
 assert.equal(result.container.length,comp.accepted?comp.candidateBytes:comp.baselineBytes)
 assert.equal(comp.accepted,comp.candidateBytes!<comp.baselineBytes)
 console.log(JSON.stringify({input,comparison:comp,containerBytes:result.container.length,contextComparison:result.contextComparison,roundtrip:true,explicitPlan:true}))
}
main().catch(e=>{console.error(e);process.exitCode=1})
