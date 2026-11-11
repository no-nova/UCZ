import assert from 'node:assert/strict'
import { ID, planHeader, encodeTerrainGroup, decompress, contextGroupCandidatesSync, contextProposalsForGroup, type Spec } from '@lib/codec'
import { encodeCM, a2Tuning, withCMBlockSize, V20_FLAG_CM } from '@lib/coder'
import { payloadModelFlags, markPayloadModel } from '@lib/payload-model'
import { V21_FLAG_CONTEXTS, contextUpgradeWins, type CMContext } from '@lib/context-policy'
import { wordPreFwdSampled } from '@lib/wordpre'
import { loadSlice, sha } from '../scripts/diag/p141/input'

function container(parts:Uint8Array[],payload:Uint8Array,spec:Spec,context?:CMContext,wordPre=false) {
 let start=0
 const segs=parts.map(p=>{const s={start,end:start+p.length,cls:'binary' as const,spec};start+=p.length;return s})
 const header=planHeader(start,segs,[{spec,members:parts.map((_,i)=>i),payload,v15:true,wordPre,context}])
 const raw=new Uint8Array(start);let offset=0;for(const p of parts){raw.set(p,offset);offset+=p.length}
 const out=new Uint8Array(header.length+payload.length);out.set(header);out.set(payload,header.length)
 const decoded=decompress(out);assert.deepEqual(decoded,raw);assert.equal(sha(decoded),sha(raw))
 return out
}
function highPlane(p:Uint8Array) {let pos=0,n=0,m=1,b:number;do{b=p[pos++];n+=(b&127)*m;m*=128}while(b&128);return p.subarray(pos,pos+n)}

export function formatExtra() {
 let roundtrips=0
 for(const length of [1,7,11]) {
  const data=Uint8Array.from({length},(_,i)=>i*19),spec={id:ID.BIN,s:1,r:1}
  const p=encodeTerrainGroup([data],spec,undefined,undefined,undefined,[0],'v20',{context:'bin-stride4'})
  container([data],p,spec,'bin-stride4');roundtrips++
 }
 const wide=Uint8Array.from({length:24576},(_,i)=>((i>>>1)*13+(i>>>13)*3+(i%2?127:0))&255)
 for(const s of [6,7,8]) {
  const spec={id:ID.WIDE_GRAD,s,r:8192},parts=[wide.subarray(0,8192),wide.subarray(8192)]
  const p=encodeTerrainGroup(parts,spec,undefined,undefined,undefined,[0,8192],'v20',{context:'wide-geom'})
  const control=encodeTerrainGroup(parts,spec,undefined,undefined,undefined,[0,8192],'v20')
  assert.deepEqual(highPlane(p),highPlane(control),'P2 must leave the high plane byte-identical')
  container(parts,p,spec,'wide-geom');roundtrips++
 }
 const sentence=new TextEncoder().encode('alpha beta gamma delta="text"\n'),raw=Uint8Array.from({length:32768},(_,i)=>sentence[i%sentence.length])
 const pre=wordPreFwdSampled(raw)!;assert.ok(pre)
 const body=new Uint8Array(pre.header.length+pre.body.length);body.set(pre.header);body.set(pre.body,pre.header.length)
 const saved={...a2Tuning},flags:number[]=[]
 try {
  for(const [textOn,wordPreTextOff] of [[true,false],[false,false],[true,true]]) {
   for(const context of ['wp-token3','wp-merge'] as const) {
    Object.assign(a2Tuning,{textOn,wordPreTextOff})
    const cm=withCMBlockSize(raw.length,()=>encodeCM(body,'text',1,1,undefined,0,undefined,undefined,'v20',0,true,{context}))
    const p=markPayloadModel(new Uint8Array(cm.length+4),payloadModelFlags(cm));p.set(cm,4)
    new DataView(p.buffer).setUint32(0,body.length,true);flags.push(payloadModelFlags(p))
    Object.assign(a2Tuning,{textOn:!textOn,wordPreTextOff:!wordPreTextOff})
    container([raw],p,{id:ID.TEXT_V3,s:1,r:1},context,true);roundtrips++
   }
  }
 } finally {Object.assign(a2Tuning,saved)}
 assert.notEqual(flags[0],flags[2]);assert.notEqual(flags[0],flags[4])
 const spec={id:ID.BIN_V3,s:1,r:1},segs=[{start:0,end:16384,cls:'binary' as const,spec}]
 const oldHeader=planHeader(16384,segs,[{spec,members:[0],payload:{length:100},modelFlags:0}])
 const newHeader=planHeader(16384,segs,[{spec,members:[0],payload:{length:99},modelFlags:V20_FLAG_CM|V21_FLAG_CONTEXTS,v15:true,context:'bin-stride4'}])
 assert.ok(newHeader.length+99>=oldHeader.length+100)
 assert.equal(contextUpgradeWins(100,oldHeader.length+100,99,newHeader.length+99),false,'1 B payload win must not hide a more expensive complete header')
 console.log(JSON.stringify({case:'additional format and flag fixtures',roundtrips,maxInputBytes:32768,shortMissingHistoryZero:true,wide6Through8R8192Seams:true,wideHighPlaneUnchanged:true,wpTextOnAndBothLegacyOffPolicies:true,wpFlags:flags,headerOnlyLossRejected:{baseHeaderBytes:oldHeader.length,candidateHeaderBytes:newHeader.length}}))
}

export function screen(name:string,mode:string,requested?:string) {
 const {data,input}=loadSlice(name,requested?Number(requested):undefined)
 assert.ok(data.length>=262144,'this shard exercises the actual large-group screen')
 const context=mode as CMContext,spec={id:context==='wide-geom'?ID.WIDE_GRAD:context.startsWith('wp-')?ID.TEXT_V3:ID.BIN_V3,s:context==='wide-geom'?(input.file==='mr'?6:7):1,r:context==='wide-geom'?(input.file==='mr'?1024:3800):1}
 const result=contextGroupCandidatesSync([data],spec,[0])
 assert.ok(!result.error,result.error);assert.ok(result.screen,result.skipped)
 assert.ok(result.screen.rawBytes<=192*1024);assert.ok(result.screen.selected.length<=1)
 assert.deepEqual(result.trials.map(t=>t.context),result.screen.selected)
 assert.equal(result.fullCandidateInputBytes,input.bytes*result.trials.length)
 if(!result.screen.selected.length){assert.equal(result.control,null);assert.equal(result.skipped,'probe-not-better')}
 const sizes=[]
 for(const trial of result.trials) {
  assert.ok(result.control)
  const baseline=container([data],result.control.payload,spec,undefined,result.wordPre)
  const candidate=container([data],trial.payload,spec,trial.context,result.wordPre)
  sizes.push({context:trial.context,baseBytes:baseline.length,candidateBytes:candidate.length,savedBytes:baseline.length-candidate.length})
 }
 console.log(JSON.stringify({case:'production bounded screen + full candidates (NOT adaptive)',input,screen:result.screen,admission:result.admission,fullCandidateInputBytes:result.fullCandidateInputBytes,controlReused:result.controlReused,skipped:result.skipped,roundtrips:sizes.length*2,sizes,fullFileMeasured:false}))
}

export function proposals() {
 const textTrial={spec:{id:ID.TEXT_V3,s:1,r:1},label:'CM-TEXT3',ratio:0.5,sampleLen:1024,payloadSize:512}
 const text={rawLen:65536,cls:'text' as const,trials:[textTrial]}
 const row={rawLen:65536,cls:'smooth' as const,trials:[]}
 const rowSpec={id:ID.GRAD_V3,s:2,r:1024}
 const candidates=contextProposalsForGroup(rowSpec,[row])
 assert.deepEqual(candidates.map(p=>p.spec),[6,7,8].map(s=>({id:ID.WIDE_GRAD,s,r:1024})))
 assert.ok(candidates.every(p=>p.reason==='existing-16bit-row-geometry'))
 for(const [spec,members] of [
  [{...rowSpec,s:4},[row]], [{...rowSpec,r:8193},[row]], [{...rowSpec,r:1023},[row]],
  [rowSpec,[{...row,rawLen:16383}]], [rowSpec,[{...row,rawLen:65535}]],
  [rowSpec,[{...row,rawLen:262144}]],
 ] as const)assert.deepEqual(contextProposalsForGroup(spec,members),[])
 const anchor={id:ID.SUB_ANCHOR_V3,s:60,r:62}
 assert.deepEqual(contextProposalsForGroup(anchor,[text]),[{spec:{id:ID.TEXT_V3,s:1,r:1},reason:'existing-text-v3-trial'}])
 assert.deepEqual(contextProposalsForGroup(anchor,[{...text,trials:[]}]),[])
 assert.deepEqual(contextProposalsForGroup(anchor,[{...text,cls:'binary'}]),[])
 assert.deepEqual(contextProposalsForGroup(anchor,[text,{...text,trials:[]}]),[])
 assert.deepEqual(contextProposalsForGroup(anchor,[{...text,rawLen:32767}]),[])
 for(const id of [ID.BCJ,ID.BCJ_V2,ID.BCJ_V3,ID.DELTA_V3,ID.STORE,ID.TRANSPOSE_GROUP_V3]) {
  assert.deepEqual(contextProposalsForGroup({id,s:1,r:1},[text]),[])
 }
 const large={...row,rawLen:262144}
 assert.equal(contextProposalsForGroup({id:ID.WIDE_GRAD,s:6,r:8192},[large]).length,1)
 assert.equal(contextProposalsForGroup({id:ID.BIN,s:1,r:1},[large]).length,1)
 console.log(JSON.stringify({case:'narrow proposal eligibility',metadataOnly:true,binTransformsAndBcjExcluded:true,onlyPriorTextV3Trials:true,allMembersMustQualify:true,oldWideThresholdNotChanged:true,short2ByteGeometryOnly:true,noThreeFullLargeAlternatives:true}))
}
