// Metadata-only verification: no encoding, decoding, or corpus reads.
// --save creates one immutable summary; --verify compares it byte-for-byte as data.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const sha=x=>createHash('sha256').update(x).digest('hex')
const json=p=>JSON.parse(readFileSync(p,'utf8'))
const root='scripts/diag/p141-results',history='scripts/diag/p141/history'
const matrix=json('scripts/diag/p141/cases.json'),manifest=json('scripts/diag/p14/slices.json')
const self='scripts/diag/p141/verify.mjs',selfBytes=readFileSync(self),selfSha=sha(selfBytes),selfArchive=`${history}/${selfSha}-${basename(self)}.txt`
if(!existsSync(selfArchive))writeFileSync(selfArchive,selfBytes,{flag:'wx'})
const archiveNames=new Set(readdirSync(history))
for(const file of archiveNames) {
 const match=/^([a-f0-9]{64})-.+\.txt$/.exec(file);assert.ok(match,`bad archive name: ${file}`)
 assert.equal(sha(readFileSync(`${history}/${file}`)),match[1],`archive checksum: ${file}`)
}
const sourceFiles=Object.fromEntries(readdirSync('src/lib').filter(f=>f.endsWith('.ts')).sort().map(f=>[f,sha(readFileSync(`src/lib/${f}`))]))
const sourceSha256=sha(JSON.stringify(sourceFiles))
const paths=[...readdirSync(root).filter(p=>p.endsWith('.json')&&p!=='summary.json').map(p=>`${root}/${p}`),
 ...readdirSync(`${root}/checks`).filter(p=>p.endsWith('.json')).map(p=>`${root}/checks/${p}`)].sort()
const records=paths.map(path=>({path,sha256:sha(readFileSync(path)),record:json(path)}))
for(const {path,record:r} of records) {
 assert.ok(['P14.1-bounded-implementation-test','P14.1-bounded-project-check'].includes(r.kind),path)
 assert.ok(['PASS','FAIL'].includes(r.status));assert.equal(r.fullCorpusEncoded,false);assert.equal(r.baselinePromoted,false)
 assert.ok(Number.isFinite(r.durationMs)&&r.durationMs<19000,`${path}: hard command budget`)
 assert.equal(sha(JSON.stringify(r.sourceFiles)),r.sourceSha256,`${path}: source fingerprint`)
 for(const [file,hash] of Object.entries(r.sourceFiles))assert.ok(archiveNames.has(`${hash}-${basename(file)}.txt`),`${path}: missing source ${file}`)
 for(const [file,hash] of Object.entries(r.scripts))assert.ok(archiveNames.has(`${hash}-${basename(file)}.txt`),`${path}: missing script ${file}`)
 if(r.status==='PASS')assert.equal(r.exitCode??r.code,0,`${path}: exit status`)
 if(r.kind==='P14.1-bounded-implementation-test') {
  assert.equal(r.maxRawSliceBytes,262144)
  assert.ok(r.requestedBytes===null||(r.requestedBytes>0&&r.requestedBytes<=262144))
  const input=r.result?.input
  if(input) {
   const parent=manifest.samples.find(s=>s.name===input.name);assert.ok(parent,path)
   assert.ok(input.bytes>0&&input.bytes<=parent.bytes&&input.bytes<=262144)
   assert.equal(input.offset,parent.offset);assert.equal(input.file,parent.file)
   assert.equal(input.parentWindowBytes,parent.bytes);assert.equal(input.parentWindowSha256,parent.sha256)
   assert.match(input.sha256,/^[a-f0-9]{64}$/)
   if(input.bytes===parent.bytes)assert.equal(input.sha256,parent.sha256)
  }
 }
}
const failures=records.filter(x=>x.record.status==='FAIL')
const expectedFailures=[
 'adaptive-mozilla-code-old-1794223825278.json',
 'adaptive-mozilla-resources-current-1794223962975.json',
 'adaptive-mr-mid-current-1794224056580.json',
 'adaptive-mr-mid-old-1794224075783.json',
 'adaptive-mr-mid-old-parallel-1794224138527.json',
 'adaptive-xml-mid-current-1794224184313.json',
].sort()
assert.deepEqual(failures.map(x=>basename(x.path)).sort(),expectedFailures,'keep all six historical failures/timeouts; do not hide a new failure')
const impl=records.filter(x=>x.record.kind==='P14.1-bounded-implementation-test')
const old=impl.filter(x=>x.record.sourceRef===matrix.baselineRef)
assert.ok(old.length)
// Verify every archived old-source module independently against the actual Git
// object, not the current implementation with its feature toggle switched off.
const referenceFiles=Object.fromEntries(Object.keys(old[0].record.sourceFiles).sort().map(file=>[file,
 sha(execFileSync('git',['show',`${matrix.baselineRef}:universal-adaptive-compression-system/src/lib/${file}`],{maxBuffer:4*1024*1024}))]))
for(const x of old)assert.deepEqual(x.record.sourceFiles,referenceFiles,x.path)
const oldSourceSha256=sha(JSON.stringify(referenceFiles))
const timestamp=x=>Number(/-(\d+)\.json$/.exec(x.path)?.[1]??0)
function latest(predicate,label) {
 const found=records.filter(x=>predicate(x.record)).sort((a,b)=>timestamp(a)-timestamp(b)).at(-1)
 assert.ok(found,`missing ${label}`);assert.equal(found.record.status,'PASS',`latest ${label} must pass`)
 return found
}
function adaptive(slice,bytes,mode) {
 return latest(r=>r.case==='adaptive'&&r.slice===slice&&r.mode===mode
  &&(r.result?.input?.bytes??r.requestedBytes??262144)===bytes
  &&r.sourceSha256===(mode==='old'?oldSourceSha256:sourceSha256),`${slice}/${bytes}/${mode}`)
}
function endpoint({slice,bytes,requireDrop},offRequired) {
 const old=adaptive(slice,bytes,'old'),current=adaptive(slice,bytes,'current'),a=old.record.result,b=current.record.result
 assert.deepEqual(b.input,a.input)
 for(const r of [a,b]) {assert.equal(r.roundtrip,true);assert.equal(r.decodedSha256,r.input.sha256);assert.equal(r.fullFileMeasured,false)}
 assert.equal(b.baselineSource,matrix.baselineRef);assert.equal(b.baselineBytes,a.containerBytes)
 assert.equal(b.contexts.baselineBytes,a.containerBytes);assert.equal(b.contexts.candidateBytes,b.containerBytes)
 assert.ok(!b.contexts.error);assert.ok(b.contexts.groups.every(g=>!g.error))
 assert.ok(b.containerBytes<=a.containerBytes)
 if(requireDrop)assert.ok(b.containerBytes<a.containerBytes,`${slice}: required actual adaptive improvement`)
 assert.equal(b.savedBytes,a.containerBytes-b.containerBytes)
 let off
 if(offRequired) {
  off=adaptive(slice,bytes,'off');const o=off.record.result
  assert.deepEqual(o.input,a.input);assert.equal(o.containerBytes,a.containerBytes);assert.equal(o.containerSha256,a.containerSha256)
  assert.equal(o.roundtrip,true);assert.equal(o.decodedSha256,a.input.sha256)
 }
 if(slice==='ooffice-code') {
  assert.ok(b.finalSpecs.includes('25/2/1'));assert.equal(b.containerSha256,a.containerSha256);assert.equal(b.contexts.groups.length,0)
 }
 return {slice,inputBytes:bytes,inputSha256:a.input.sha256,baselineBytes:a.containerBytes,currentBytes:b.containerBytes,savedBytes:b.savedBytes,
  finalSpecs:b.finalSpecs,version:b.version,roundtripAndSha:true,baselineOffByteIdentity:offRequired?true:null,
  receipts:{old:old.path,current:current.path,...(off?{off:off.path}:{})}}
}
const endpoints=matrix.cases.map(c=>endpoint(c,true))
const additional=matrix.additionalCases.map(c=>endpoint(c,false))
const natural=matrix.naturalLanguageGuards.map(slice=>{
 const row=endpoint({slice,bytes:65536,requireDrop:false},false)
 const a=adaptive(slice,65536,'old').record.result,b=adaptive(slice,65536,'current').record.result
 assert.equal(a.containerSha256,b.containerSha256)
 assert.ok(b.contexts.groups.length)
 for(const g of b.contexts.groups) {
  assert.equal(g.skipped,'P13.1-wordpre-admission');assert.equal(g.fullCandidateInputBytes,0);assert.equal(g.trials.length,0)
  const gate=g.admission;assert.equal(gate.policy,'p12-contiguous-body')
  assert.ok(gate.bodyBytes.some((n,i)=>n!==null&&gate.plainBytes[i]!==null&&n>=gate.plainBytes[i]*0.99))
 }
 return {...row,unchangedContainerSha256:b.containerSha256,originalWordPreGateRejected:true}
})
const requiredCore=['wire','format-extra','guard','proposals','compat']
const core=requiredCore.map(name=>latest(r=>r.case===name&&r.sourceSha256===sourceSha256,name).path)
for(const [slice,mode] of [['mozilla-code','bin-stride4'],['mr-mid','wide-geom'],['xml-mid','wp-token3'],['xml-mid','wp-merge']]) {
 const hit=latest(r=>r.case==='kernel'&&r.slice===slice&&r.mode===mode&&r.sourceSha256===sourceSha256&&r.result?.input.bytes===262144,`${mode} audited kernel/control`)
 assert.equal(hit.record.result.auditedPayloadParity,true);assert.equal(hit.record.result.auditedControlParity,true);core.push(hit.path)
}
const p1Screen=latest(r=>r.case==='screen'&&r.slice==='mozilla-code'&&r.sourceSha256===sourceSha256,'P1 actual large screen')
assert.ok(p1Screen.record.result.screen.rawBytes<=196608);assert.equal(p1Screen.record.result.fullCandidateInputBytes,262144);core.push(p1Screen.path)
for(const [slice,mode] of [['synthetic','bin19'],['xml-mid','wp']]) {
 const hit=latest(r=>r.case==='worker'&&r.slice===slice&&r.mode===mode&&r.sourceSha256===sourceSha256,`${mode} actual worker`)
 assert.equal(hit.record.result.candidateBytesFlagsAndScreenParity,true);core.push(hit.path)
}
const parallel=adaptive('mr-mid',65536,'current-parallel')
assert.equal(parallel.record.result.containerSha256,adaptive('mr-mid',65536,'current').record.result.containerSha256)
assert.equal(parallel.record.result.serialContainerByteIdentity,true);assert.ok(parallel.record.result.contexts.workerJobs>0)
assert.equal(parallel.record.result.contexts.workerFallbacks,0)
const requiredChecks=['worker','types','diag-types','build','ui','metadata','legacy','p131-gate','p131-worker']
const checks=requiredChecks.map(name=>{
 const hit=latest(r=>r.kind==='P14.1-bounded-project-check'&&r.name===name&&r.sourceSha256===sourceSha256,name)
 return {name,path:hit.path,durationMs:hit.record.durationMs,status:hit.record.status}
})
const lock=json('scripts/diag/baseline.json')
assert.equal(lock.files.reduce((n,f)=>n+f.bestUcz,0),40233692);assert.equal(lock.total.bestUcz,40233692)
execFileSync('git',['diff','--exit-code','2f6267a','--','scripts/diag/p14','scripts/diag/p14-results','docs/audits/P14_AUDIT.md'],{stdio:'pipe'})
execFileSync('git',['diff','--exit-code','ef06e60','--','scripts/diag/baseline.json','scripts/diag/baselines/p131-local-report.json'],{stdio:'pipe'})
const evidence=records.map(({path,sha256,record:r})=>({path,sha256,status:r.status,kind:r.kind,sourceSha256:r.sourceSha256}))
const summary={kind:'P14.1 implementation verification',status:'PASS',sourceCommit:execFileSync('git',['log','-1','--format=%H','--','src/lib'],{encoding:'utf8'}).trim(),
 sourceSha256,sourceFiles,independentBaselineRef:matrix.baselineRef,independentBaselineSourceSha256:oldSourceSha256,
 verifierSha256:selfSha,matrixSha256:sha(readFileSync('scripts/diag/p141/cases.json')),
 counts:{implementationReceipts:impl.length,implementationPass:impl.filter(x=>x.record.status==='PASS').length,implementationFail:impl.filter(x=>x.record.status==='FAIL').length,
  projectCheckReceipts:records.length-impl.length,totalReceipts:records.length,pass:records.length-failures.length,fail:failures.length,
  timeout:failures.filter(x=>(x.record.error??'').includes('ETIMEDOUT')||x.record.timedOut).length,
  requiredAdaptiveEndpoints:endpoints.length,baselineOffIdentities:endpoints.filter(x=>x.baselineOffByteIdentity).length,
  additionalAdaptiveEndpoints:additional.length,naturalLanguageGuards:natural.length,sourceArchivesVerified:archiveNames.size},
 endpoints,additional,naturalLanguageGuards:natural,coreChecks:core,
 actualParallelEndpoint:{path:parallel.path,contextWorkerJobs:parallel.record.result.contexts.workerJobs,workerFallbacks:0,byteIdenticalToSerial:true},checks,
 historicalFailures:failures.map(x=>({path:x.path,error:x.record.error??(x.record.result?.savedBytes===0?'original winner-only eligibility missed the requested gain':'BIN19 identity-join error caught by the floor/test'),sourceSha256:x.record.sourceSha256})),
 historicalP14AuditUnchanged:true,baselineLockUnchanged:true,baselinePromoted:false,baselineTotalBytes:40233692,
 fullCorpusEncoded:false,fullFileAcceptance:false,fullCorpusTargetMeasured:false,
 targets:[{strictLessThanBytes:40058000,minimumRequiredSavingsBytes:175693,attained:null},{strictLessThanBytes:40000000,minimumRequiredSavingsBytes:233693,attained:null}],
 fullLegacyCodecSuiteRun:false,maxRawInputPerSliceBytes:262144,outerCommandLimitSeconds:19,evidence}
const target=`${root}/summary.json`
if(process.argv.includes('--save'))writeFileSync(target,JSON.stringify(summary,null,2)+'\n',{flag:'wx'})
if(process.argv.includes('--verify'))assert.deepEqual(json(target),summary,'saved summary must match every archived receipt and current production source')
console.log(JSON.stringify({status:'PASS',sourceSha256,counts:summary.counts,endpoints,additional,checks:checks.map(c=>({name:c.name,status:c.status})),fullFileAcceptance:false,baselinePromoted:false,summary:process.argv.includes('--save')||process.argv.includes('--verify')?target:undefined},null,2))
