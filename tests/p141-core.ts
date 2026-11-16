import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { ID, planHeader, encodeTerrainGroup, decompress, contextSpecAllowed, contextGroupCandidatesSync, compressCachedPlansForProbe, refineContextCandidates, type Spec, type PlanSegment } from '@lib/codec'
import { encodeCM, withContainerModel, V20_FLAG_CM, V20_FLAG_BIN_RECOVERY } from '@lib/coder'
import { payloadModelFlags, markPayloadModel } from '@lib/payload-model'
import { V21_FLAG_CONTEXTS, GROUP_CONTEXT_MASK, GROUP_CONTEXT_SHIFT, CONTEXT_CODES, contextUpgradeWins, type CMContext } from '@lib/context-policy'
import { PARALLEL_WORKER_CODE } from '@lib/parallel-worker-code'
import { loadSlice, sha } from '../scripts/diag/p141/input'
import { formatExtra, screen, proposals } from './p141-extra'

const [which,name,mode,requested]=process.argv.slice(2)
const frame=(data:Uint8Array,payload:Uint8Array,spec:Spec,context?:CMContext,wordPre=false)=>{
 const header=planHeader(data.length,[{start:0,end:data.length,cls:'binary',spec}],[{spec,members:[0],payload,v15:true,wordPre,context}])
 const container=new Uint8Array(header.length+payload.length);container.set(header);container.set(payload,header.length)
 assert.deepEqual(decompress(container),data)
 return container
}
function variable(data:Uint8Array,st:{p:number}) {let n=0,m=1,b;do{b=data[st.p++];n+=(b&127)*m;m*=128}while(b&128);return n}
function varbytes(n:number) {const a=[];do{const b=n%128;n=Math.floor(n/128);a.push(b|(n?128:0))}while(n);return a}
function firstRule(header:Uint8Array) {
 const st={p:header[3]>=19?6:4};variable(header,st);variable(header,st);variable(header,st)
 const id=variable(header,st),s=variable(header,st),start=st.p,rRaw=variable(header,st),end=st.p
 return {id,s,rRaw,start,end}
}
function wire() {
 for(const [context,spec,wp] of [
  ['bin-stride4',{id:ID.BIN_V3,s:1,r:1},false],['wide-geom',{id:ID.WIDE_GRAD,s:6,r:8192},false],
  ['wp-token3',{id:ID.TEXT_V3,s:1,r:1},true],['wp-merge',{id:ID.TEXT_V3,s:1,r:1},true],
 ] as const) {
  const payload=markPayloadModel(new Uint8Array(5),V21_FLAG_CONTEXTS|V20_FLAG_CM|V20_FLAG_BIN_RECOVERY)
  const h=Uint8Array.from(planHeader(64,[{start:0,end:64,cls:'binary',spec}],[{spec,members:[0],payload,v15:true,wordPre:wp,context}]))
  assert.equal(h[3],21);const rule=firstRule(h)
  assert.equal(rule.rRaw&0x3fff,spec.r);assert.equal((rule.rRaw&GROUP_CONTEXT_MASK)>>>GROUP_CONTEXT_SHIFT,CONTEXT_CODES[context])
  assert.equal(!!(rule.rRaw&0x4000),wp);assert.ok(rule.rRaw&0x8000);assert.ok(rule.rRaw&0x10000)
  assert.ok((h[4]|h[5]<<8)&V20_FLAG_BIN_RECOVERY)
 }
 const data=Uint8Array.from({length:512},(_,i)=>(i*7+(i%4))&255),spec={id:ID.BIN_V3,s:1,r:1}
 const payload=encodeTerrainGroup([data],spec,undefined,undefined,undefined,[0],'v20',{context:'bin-stride4'})
 const c=frame(data,payload,spec,'bin-stride4'),rule=firstRule(c)
 const bad=c.slice();bad[3]=20;assert.throws(()=>decompress(bad),/配置/)
 for(const r of [rule.rRaw&~0x10000,rule.rRaw&~0x8000,rule.rRaw|0x4000,rule.rRaw&~GROUP_CONTEXT_MASK,rule.rRaw|0x100000]) {
  const v=varbytes(r);assert.equal(v.length,rule.end-rule.start)
  const corrupt=c.slice();corrupt.set(v,rule.start);assert.throws(()=>decompress(corrupt),/上下文|标志|标记|APM/)
 }
 for(const code of [3,5,7]) {
  const r=(rule.rRaw&~GROUP_CONTEXT_MASK)|(code<<GROUP_CONTEXT_SHIFT),v=varbytes(r)
  assert.equal(v.length,rule.end-rule.start)
  const corrupt=c.slice();corrupt.set(v,rule.start);assert.throws(()=>decompress(corrupt),/上下文|组标记/)
 }
 const missing=c.slice();missing[5]&=~0x40;assert.throws(()=>decompress(missing),/配置/)
 assert.throws(()=>withContainerModel(20,V21_FLAG_CONTEXTS|V20_FLAG_CM,()=>0),/配置/)
 assert.throws(()=>withContainerModel(21,V20_FLAG_CM,()=>0),/配置/)
 assert.throws(()=>encodeCM(data,'bin',1,1,undefined,0,undefined,undefined,'v15',0,false,{context:'bin-stride4'}),/上下文/)
 // BCJ_V3 s=2 现在是合法规则（9.H 的实际编码路径），不再抛异常：
 // 用真实分组做一次端到端框架校验，顺带保证 v20 的 BCJ 上下文可解码。
 const bcjSpec={id:ID.BCJ_V3,s:2,r:1}
 const bcjPayload=encodeTerrainGroup([data],bcjSpec,undefined,undefined,undefined,[0],'v20',{context:'bin-stride4'})
 frame(data,bcjPayload,bcjSpec,'bin-stride4')
 assert.equal(contextSpecAllowed('bin-stride4',{id:ID.STORE,s:1,r:1}),false)
 for(const id of [ID.BIN,ID.BIN_V2,ID.BIN_V3]) {
  const bin={id,s:1,r:1};assert.equal(contextSpecAllowed('bin-stride4',bin),true)
  for(const parts of [[data],[data.subarray(0,123),data.subarray(123,377),data.subarray(377)]]) {
   const p=encodeTerrainGroup(parts,bin,undefined,undefined,undefined,parts.map(()=>0),'v20',{context:'bin-stride4'})
   frame(data,p,bin,'bin-stride4')
  }
 }
 const text=Uint8Array.from({length:512},(_,i)=>65+i%20),oldSpec={id:ID.TEXT_V3,s:1,r:1}
 const old=encodeTerrainGroup([text],oldSpec,undefined,undefined,undefined,[512],'v15')
 const header=planHeader(1024,[{start:0,end:512,cls:'binary',spec},{start:512,end:1024,cls:'text',spec:oldSpec}],
  [{spec,members:[0],payload,v15:true,context:'bin-stride4'},{spec:oldSpec,members:[1],payload:old,v15:true}])
 assert.deepEqual(decompress(Uint8Array.from([...header,...payload,...old])),Uint8Array.from([...data,...text]))
 assert.equal(contextUpgradeWins(100,120,100,119),false)
 assert.equal(contextUpgradeWins(100,120,99,120),false)
 assert.equal(contextUpgradeWins(100,120,99,119),true)
 console.log(JSON.stringify({case:'v21 wire',roundtrip:true,mixedLegacyV15:true,r8192Preserved:true,oldV20RejectsNewFlags:true,reservedModesRejected:true,bcjAndStoreExcluded:true,strictEqualityRetainsBase:true,maxInputBytes:1024}))
}
function kernel() {
 const {data,input}=loadSlice(name,requested?Number(requested):undefined)
 const context=mode as CMContext
 const spec={id:context==='wide-geom'?ID.WIDE_GRAD:context.startsWith('wp-')?ID.TEXT_V3:ID.BIN_V3,s:context==='wide-geom'?(input.file==='mr'?6:7):1,r:context==='wide-geom'?(input.file==='mr'?1024:3800):1}
 const start=performance.now(),cand=contextGroupCandidatesSync([data],spec,[0],undefined,false)
 assert.ok(!cand.error,cand.error);assert.ok(cand.control,'candidate must pass original admission')
 const trial=cand.trials.find(t=>t.context===context);assert.ok(trial)
 const base=frame(data,cand.control.payload,spec,undefined,cand.wordPre),container=frame(data,trial.payload,spec,context,cand.wordPre)
 const original=readFileSync('scripts/diag/p14-results/summary.json','utf8')
 const ledger=JSON.parse(original)
 const u=context==='wide-geom'?'unit2':context.startsWith('wp-')?'unit1':input.file==='osdb'?'unit4':'unit3'
 const v=context==='wide-geom'?'geom':context==='bin-stride4'?'stride4':context
 const evidence=ledger.evidence.map((e:any)=>e.path).filter((p:string)=>p.includes(`/${u}/`))
 const auditRecords=evidence.map((path:string)=>JSON.parse(readFileSync(path,'utf8')))
 const matching=(variant:string)=>auditRecords.find((r:any)=>r.status==='PASS'&&r.slice===name&&r.variant===variant&&r.result?.payloadSha256)
 const audited=matching(v),controlAudit=matching('control')
 const auditedPayloadParity=input.bytes===input.parentWindowBytes&&!!audited
 if(auditedPayloadParity) {
  const body=cand.wordPre?trial.payload.subarray(4):trial.payload
  assert.equal(body.length,audited.result.payloadBytes);assert.equal(sha(body),audited.result.payloadSha256,'new marked kernel must reproduce audited positive bytes')
  assert.ok(controlAudit)
  const control=cand.wordPre?cand.control.payload.subarray(4):cand.control.payload
  assert.equal(control.length,controlAudit.result.payloadBytes);assert.equal(sha(control),controlAudit.result.payloadSha256,'complete standard control must reproduce independently archived old v20')
 }
 assert.ok(container.length<base.length,'new candidate must shrink the complete control container')
 console.log(JSON.stringify({case:'marked production candidate, forced layout (NOT adaptive)',input,context,spec,baseBytes:base.length,containerBytes:container.length,savedBytes:base.length-container.length,version:container[3],roundtrip:true,decodedSha256:sha(decompress(container)),auditedPayloadParity,auditedControlParity:auditedPayloadParity&&!!controlAudit,elapsedMs:Math.round(performance.now()-start),fullFileMeasured:false}))
}
async function guard() {
 const data=Uint8Array.from({length:16384},(_,i)=>(i>>>2)%251),spec={id:ID.BIN_V3,s:1,r:1}
 const picks:PlanSegment[]=[{start:0,end:data.length,cls:'binary',spec}]
 const [base]=await compressCachedPlansForProbe(data,[picks],{serial:true})
 const copied=base.container.slice(),normal=await refineContextCandidates(data,base,{serial:true})
 assert.deepEqual(base.container,copied);assert.deepEqual(decompress(normal.container),data)
 assert.ok(normal.container.length<=base.container.length)
 // A lying/equal-sized candidate must never replace the actual baseline.
 const basePayload=base.container.slice(base.overhead)
 const equal=await refineContextCandidates(data,base,{runJobs:async()=>[{kind:'contextGroup',candidates:{spec,rawBytes:data.length,wordPre:false,control:{payload:basePayload,flags:V20_FLAG_CM},trials:[{context:'bin-stride4',payload:basePayload.slice(),flags:V20_FLAG_CM|V21_FLAG_CONTEXTS}],controlReused:false,fullCandidateInputBytes:data.length}}]})
 assert.deepEqual(equal.container,base.container);assert.equal(equal.contextComparison?.accepted,false)
 const bcj={id:ID.BCJ_V3,s:2,r:1},[b]=await compressCachedPlansForProbe(data,[[{...picks[0],spec:bcj}]],{serial:true})
 let dispatched=false
 const kept=await refineContextCandidates(data,b,{runJobs:async()=>{dispatched=true;throw Error('must not dispatch BCJ')}})
 assert.equal(dispatched,false);assert.deepEqual(kept.container,b.container);assert.deepEqual(decompress(kept.container),data)
 const failed=await refineContextCandidates(data,base,{runJobs:async()=>[{kind:'contextGroup',candidates:{spec,rawBytes:data.length,wordPre:false,control:null,trials:[],controlReused:false,fullCandidateInputBytes:0,error:'injected candidate failure'}}]})
 assert.deepEqual(failed.container,base.container);assert.equal(failed.contextComparison?.accepted,false)
 assert.equal(failed.contextComparison?.groups[0].error,'injected candidate failure')
 const both=Uint8Array.from([...data,...data]),wide={id:ID.WIDE_GRAD,s:6,r:1024},grad={id:ID.GRAD_V3,s:2,r:1024}
 const [reserved]=await compressCachedPlansForProbe(both,[[{start:0,end:data.length,cls:'smooth',spec:grad},{start:data.length,end:both.length,cls:'smooth',spec:wide}]],{serial:true})
 let reservationChecked=false
 const collision=await refineContextCandidates(both,reserved,{runJobs:async jobs=>{
  assert.equal(jobs.length,3)
  assert.deepEqual(jobs.map(j=>j.kind==='contextGroup'?j.spec.s:null),[7,8,6],'a proposal must not steal the existing WIDE6 key')
  reservationChecked=true
  return jobs.map(j=>{
   if(j.kind!=='contextGroup')throw Error('unexpected job')
   return {kind:'contextGroup' as const,candidates:{spec:j.spec,rawBytes:j.parts.reduce((n,[a,b])=>n+b-a,0),wordPre:false,control:null,trials:[],controlReused:false,fullCandidateInputBytes:0,skipped:'test-only empty reply'}}
  })
 }})
 assert.ok(reservationChecked);assert.deepEqual(collision.container,reserved.container);assert.deepEqual(decompress(collision.container),both)
 console.log(JSON.stringify({case:'full-container guard',inputBytes:data.length,baselineBytes:base.container.length,candidateBytes:normal.container.length,roundtrip:true,baseBufferUnchanged:true,equalityRejected:true,bcjExcluded:true,candidateErrorRetainsBase:true,targetRuleReserved:true,comparison:normal.contextComparison}))
}
async function worker() {
 const wp=mode==='wp',input=wp?loadSlice(name,requested?Number(requested):65536):undefined
 const data=input?.data??Uint8Array.from({length:32768},(_,i)=>(i>>>2)%251),spec={id:wp?ID.TEXT_V3:mode==='bin5'?ID.BIN:mode==='bin19'?ID.BIN_V2:ID.BIN_V3,s:1,r:1}
 const payload=encodeTerrainGroup([data],spec,undefined,undefined,undefined,[0],'v20')
 const retained={payload,flags:payloadModelFlags(payload),wordPre:false},local=contextGroupCandidatesSync([data],spec,[0],retained)
 assert.ok(local.control);assert.ok(local.control.flags&V20_FLAG_CM,'control must be actual v20, including legacy single-part BIN19')
 if(!wp) {
  const standard=encodeCM(data,'bin',1,1,undefined,0,undefined,undefined,'v20')
  assert.deepEqual(local.control.payload,standard)
 } else assert.equal(local.wordPre,true)
 frame(data,local.control.payload,spec,undefined,local.wordPre)
 const sab=new SharedArrayBuffer(data.length);new Uint8Array(sab).set(data)
 const w=new Worker(PARALLEL_WORKER_CODE,{eval:true,workerData:{sab}})
 try {
  const remote:any=await new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',r=>r.error?reject(Error(r.error)):resolve(r));w.postMessage({kind:'contextGroup',parts:[[0,data.length]],spec,positions:[0],retained})})
  assert.equal(remote.kind,'contextGroup');assert.deepEqual(remote.candidates,local)
  for(const t of remote.candidates.trials){markPayloadModel(t.payload,t.flags);frame(data,t.payload,spec,t.context,remote.candidates.wordPre)}
 }finally{await w.terminate()}
 console.log(JSON.stringify({case:'actual generated worker',spec,input:input?.input,inputBytes:data.length,roundtrip:true,candidateBytesFlagsAndScreenParity:true,actualStandardV20ControlParity:wp?undefined:true,wordPre:local.wordPre,controlFlags:local.control.flags,retainedControlReused:local.controlReused}))
}
async function compat() {
 // Reuse the immutable corpus baseline containers produced by the old source.
 const files=readdirSync('.diag-state/p141-baselines').filter(f=>f.endsWith('.json'))
 assert.ok(files.length)
 for(const file of files) {
  const r=JSON.parse(readFileSync(`.diag-state/p141-baselines/${file}`,'utf8'))
  const c=readFileSync(`.diag-state/p141-baselines/${file.replace(/\.json$/,'.ucz')}`)
  assert.equal(sha(c),r.sha256);assert.equal(sha(decompress(c)),r.input.sha256)
 }
 const frozen=JSON.parse(readFileSync('tests/p7-v15-fixtures.json','utf8'))
 for(const f of frozen.cases) {
  const c=Buffer.from(f.p7ContainerBase64,'base64');assert.equal(sha(c),f.p7ContainerSha256)
  assert.equal(sha(decompress(c)),frozen.input.sha256)
 }
 const wp=JSON.parse(readFileSync('tests/legacy-wordpre-fixtures.json','utf8'))
 for(const f of wp.fixtures) {
  const c=Buffer.from(f.base64,'base64');assert.equal(sha(c),f.sha256)
  assert.deepEqual(decompress(c),new TextEncoder().encode(wp.text))
 }
 console.log(JSON.stringify({case:'legacy actual baseline containers decode',independentOldAdaptiveContainers:files.length,frozenV15V17Containers:frozen.cases.length+wp.fixtures.length,roundtrip:true,fullFileMeasured:false}))
}
const cases:Record<string,()=>void|Promise<void>>={wire,kernel,guard,worker,compat,proposals,'format-extra':formatExtra,screen:()=>screen(name,mode,requested)}
Promise.resolve().then(()=>cases[which]()).catch(e=>{console.error(e);process.exitCode=1})
