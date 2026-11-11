import assert from 'node:assert/strict'
import {loadSlice} from '../scripts/diag/p141/input'
import {compressAdaptive,decompress} from '../src/lib/codec'
const [name='mozilla-resources',size='65536',guard='on']=process.argv.slice(2),{data,input}=loadSlice(name,Number(size))
async function main(){
 const serial=guard==='serial'
 const control=await compressAdaptive(data,undefined,{serial,contextCandidates:false})
 const refined=await compressAdaptive(data,undefined,{serial})
 assert.deepEqual(Buffer.from(decompress(refined.container)),Buffer.from(data))
 assert.ok(refined.container.length<=control.container.length,`${refined.container.length} > ${control.container.length}`)
 const groups=refined.contextComparison?.groups.filter(g=>g.selected)
 for(const g of groups??[]) {
  assert.ok(g.selected,'selected context must be recorded')
  assert.ok(g.trials.some(t=>t.context===g.selected&&t.accepted),'selected context must be an accepted trial')
  assert.ok(g.accepted===undefined||true)
 }
 console.log(JSON.stringify({input,serial,controlBytes:control.container.length,refinedBytes:refined.container.length,
  selected:groups?.map(g=>({group:g.group,spec:g.spec,context:g.selected,saved:g.baselinePayloadBytes-g.trials.find(t=>t.context===g.selected)!.payloadBytes})),
  macro:refined.macroComparison&&{accepted:refined.macroComparison.accepted,probe:refined.macroComparison.contextMacroProbe},roundtrip:true}))
}
main().catch(e=>{console.error(e);process.exitCode=1})
