// Deterministic derivation from immutable receipts; no CM and no input reads.
import assert from 'node:assert/strict'
import { readFileSync,readdirSync,writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const sha=x=>createHash('sha256').update(x).digest('hex')
export function buildSummary() {
 const receipts=[]
 for(const unit of ['unit1','unit2','unit3','unit4'])for(const f of readdirSync(`scripts/diag/p14-results/${unit}`).filter(f=>f.endsWith('.json')).sort()) {
  const path=`scripts/diag/p14-results/${unit}/${f}`,bytes=readFileSync(path)
  receipts.push({...JSON.parse(bytes),path,receiptSha256:sha(bytes)})
 }
 const encoded=receipts.filter(r=>r.status==='PASS'&&r.result.payloadBytes!==undefined),distinct=new Map()
 for(const r of encoded) {
  const key=`${r.unit}/${r.slice}/${r.variant}`,old=distinct.get(key)
  if(old)assert.equal(r.result.payloadSha256,old.result.payloadSha256,'same case reruns must be bit-identical')
  else distinct.set(key,r)
 }
 const get=(r,v)=>distinct.get(`${r.unit}/${r.slice}/${v}`)
 const comparisons=[]
 for(const r of distinct.values()) {
  let control
  if(r.unit==='unit1')control=['control','raw'].includes(r.variant)?null:r.variant==='text-class'?'raw':'control'
  if(r.unit==='unit2')control=['control','wide3','tg-control','tg-flat'].includes(r.variant)?null:r.variant==='wide3-geom'?'wide3':r.variant==='tg-side'?'tg-control':r.variant==='tg-flat-side'?'tg-flat':'control'
  if(r.unit==='unit3')control=['control','bcj2'].includes(r.variant)?null:r.variant.startsWith('bcj2-')?'bcj2':'control'
  if(r.unit==='unit4')control=['control','text','profile','profile-text'].includes(r.variant)?null:'control'
  if(!control)continue
  const b=get(r,control);assert.ok(b,`${r.path}: missing control ${control}`)
  const x=r.result,savedBytes=b.result.payloadBytes-x.payloadBytes
  let bestKnownOldPayloadBytes=b.result.payloadBytes,overhead=0
  if(r.unit==='unit1') {
   overhead=x.wordPreLengthPrefixBytes
   const wp=get(r,'control'),raw=get(r,'raw')
   bestKnownOldPayloadBytes=Math.min(wp?wp.result.payloadBytes+4:Infinity,raw?raw.result.payloadBytes:Infinity)
  }else if(r.unit==='unit2') {
   bestKnownOldPayloadBytes=Math.min(...['control','wide3','tg-control'].map(v=>get(r,v)?.result.payloadBytes??Infinity))
  }
  comparisons.push({unit:r.unit,slice:r.slice,file:x.input.file,variant:r.variant,control,
   rawWindowBytes:x.input.bytes,controlPayloadBytes:b.result.payloadBytes,experimentPayloadBytes:x.payloadBytes,
   savedBytes,relativeReductionPct:savedBytes/b.result.payloadBytes*100,
   bestKnownTestedOldPayloadBytes:bestKnownOldPayloadBytes,experimentIncludingKnownWrapperBytes:x.payloadBytes+overhead,
   improvementOverBestKnownTestedOldPayloadBytes:bestKnownOldPayloadBytes-(x.payloadBytes+overhead),
   mechanicalWholeFileSavingsDecimalKB:savedBytes*x.input.corpusBytes/x.input.bytes/1000,
   savingsBytesPerRawMiB:savedBytes*1048576/x.input.bytes,
   extrapolationIsMeasured:false,applicableFullFileGroupCoverage:null,
   extrapolationAssumption:'Every raw byte behaves like this fixed cold window with this forced layout and CM table size; eligibility, full model warmup, framing and routing are NOT proved. Do not sum alternate windows/variants.',
   controlReceipt:b.path,experimentReceipt:r.path})
 }
 const ranges=[]
 const groups=[['unit3','mozilla','stride4','mozilla-code'],['unit3','mozilla','stride4','mozilla-resources'],['unit3','mozilla','opcode','mozilla-code'],['unit3','mozilla','opcode','mozilla-resources'],
  ['unit4','osdb','stride4','osdb-'],['unit2','mr','geom','mr-'],['unit2','x-ray','geom','x-ray-'],['unit1','xml','wp-token3','xml-'],['unit1','xml','wp-merge','xml-'],['unit1','nci','wp-merge','nci-']]
 for(const [unit,file,variant,prefix] of groups) {
  const rows=comparisons.filter(r=>r.unit===unit&&r.file===file&&r.variant===variant&&r.slice.startsWith(prefix))
  if(rows.length)ranges.push({unit,file,variant,cohort:prefix,windows:rows.map(r=>({slice:r.slice,savedBytes:r.savedBytes})),
   mechanicalWholeFileSavingsKBMin:Math.min(...rows.map(r=>r.mechanicalWholeFileSavingsDecimalKB)),
   mechanicalWholeFileSavingsKBMax:Math.max(...rows.map(r=>r.mechanicalWholeFileSavingsDecimalKB)),
   fullFileEstimateVerified:false,cohortCoverageBytes:null})
 }
 return {kind:'derived-audit-summary-not-a-corpus-measurement',generatorSha256:sha(readFileSync(new URL('./summary.mjs',import.meta.url))),
  baselineBytes:40233692,corpusInputBytes:211938580,targets:{cubrimUserApproximateBytes:40058000,approximateGapBytes:175692,strict40MMinimumSavingsBytes:233693,zpaqUserApproximateDecimalBytes:38830000,approximateZpaqGapBytes:1403692,externallyBenchmarkedHere:false},
  counts:{receipts:receipts.length,pass:receipts.filter(r=>r.status==='PASS').length,encodedRoundtrips:encoded.length,distinctEncodedCases:distinct.size,
   analysisOrPlan:receipts.filter(r=>r.status==='PASS'&&r.result.payloadBytes===undefined).length,retainedFailures:receipts.filter(r=>r.status==='FAIL').length},
  maxReceiptMs:Math.max(...receipts.map(r=>r.durationMs)),sourceSha256:receipts[0].sourceSha256,
  evidence:receipts.map(r=>({path:r.path,sha256:r.receiptSha256,status:r.status})),comparisons,ranges,
  benchmarkLimitations:['fixed windows, not population samples','forced layouts and slice-local dictionaries','CM21 cold tables vs full CM22/23/24 and long-distance matches','parallel process timings are not comparable throughput','no actual user final-group directory supplied','new model payloads require a distinct wire semantic marker'],
  fullFileGainClaimed:false,productionCompressionLogicChanged:false,baselineUpdatedByAudit:false}
}
if(import.meta.url&&process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const result=buildSummary()
 if(process.argv.includes('--save')) {
  const path='scripts/diag/p14-results/summary.json';writeFileSync(path,JSON.stringify(result,null,2)+'\n',{flag:'wx'})
  console.log(JSON.stringify({path,counts:result.counts,comparisons:result.comparisons.length,ranges:result.ranges,maxReceiptMs:result.maxReceiptMs}))
 }else console.log(JSON.stringify(result,null,2))
}
