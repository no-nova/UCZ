import assert from 'node:assert/strict'
import {loadSlice} from '../scripts/diag/p141/input'
import {ID,compressCachedPlansForProbe,refineContextCandidates,decompress} from '../src/lib/codec'
const losing=process.argv[2]==='loss', {data,input}=loadSlice('mozilla-resources',losing?16384:32768),spec=losing?{id:ID.TRANSPOSE,s:4,r:1}:{id:ID.SUB_TRANSPOSE,s:8,r:2}
async function main(){
 const [base]=await compressCachedPlansForProbe(data,[[{start:0,end:data.length,cls:'binary',spec}]],{serial:true})
 const out=await refineContextCandidates(data,base,{serial:true});assert.deepEqual(decompress(out.container),data)
 const row=out.contextComparison?.legacyUpgrades?.find(r=>r.spec.id===spec.id);assert.ok(row);assert.ok(!row.error,row.error)
 if(losing){assert.equal(row.accepted,false);assert.deepEqual(out.container,base.container)}
 assert.ok(out.container.length<=base.container.length)
 if(row.accepted){assert.ok(row.newPayload!<row.oldPayload);assert.ok(row.newContainer!<row.oldContainer)}
 console.log(JSON.stringify({input,base:base.container.length,after:out.container.length,row,roundtrip:true,explicitPlan:true}))
}
main().catch(e=>{console.error(e);process.exitCode=1})
