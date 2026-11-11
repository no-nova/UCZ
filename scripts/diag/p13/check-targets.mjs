#!/usr/bin/env node
// Read-only P13 local acceptance. No encoding and no baseline updates.
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const baseline=JSON.parse(readFileSync(new URL('../baseline.json',import.meta.url),'utf8'))
const reported=JSON.parse(readFileSync(new URL('../baselines/p12-d9b84df-local-report.json',import.meta.url),'utf8'))
const referenceEncMs=Math.round(reported.rows.reduce((n,r)=>n+r.reportedEncSeconds,0)*1000)
const targetEncMs=referenceEncMs*65/100

// Exported for synthetic-metadata tests. Tests are never measurement evidence.
export function assessTargets(rows,meta,confirmComparable=false) {
  const issues=[],regressions=[],seen=new Set(),sources=new Set()
  if(baseline.total.bestUcz!==baseline.files.reduce((n,r)=>n+r.bestUcz,0)||referenceEncMs!==2137200)issues.push('P13 locked reference differs')
  if(meta?.kind!=='p13-local-full-file-validation'||meta?.parallelFiles!==1)issues.push('missing/invalid local run metadata')
  if(!/^[a-f0-9]{64}$/.test(meta?.source?.sha256??''))issues.push('missing run source SHA')
  if(!Number.isSafeInteger(meta?.requestedWorkers)||meta.requestedWorkers<1)issues.push('invalid requested workers')
  let totalBytes=0,encodeRowSumMs=0,decodeRowSumMs=0
  for(const r of rows) {
    const b=baseline.files.find(b=>b.file===r?.file)
    if(!b){issues.push(`unknown file: ${r?.file}`);continue}
    if(seen.has(r.file)){issues.push(`duplicate: ${r.file}`);continue}seen.add(r.file)
    if(r.verified!==true||r.size!==b.size||r.sha256!==b.sha256)issues.push(`unverified/input mismatch: ${r.file}`)
    if(!Number.isSafeInteger(r.ucz)||r.ucz<=0||r.ucz>r.size||!Number.isFinite(r.pct))issues.push(`invalid bytes: ${r.file}`)
    else {totalBytes+=r.ucz;if(r.ucz>b.bestUcz)regressions.push({file:r.file,bytes:r.ucz-b.bestUcz})}
    if(r.sourceUnchanged!==true||r.source?.sha256!==meta?.source?.sha256)issues.push(`changed/mixed/unknown source: ${r.file}`)
    sources.add(r.source?.sha256)
    if(!Number.isFinite(r.encMs)||r.encMs<0||!Number.isFinite(r.decMs)||r.decMs<0)issues.push(`invalid timing: ${r.file}`)
    else {encodeRowSumMs+=r.encMs;decodeRowSumMs+=r.decMs}
  }
  const missing=baseline.files.filter(b=>!seen.has(b.file)).map(b=>b.file)
  if(missing.length)issues.push(`missing: ${missing.join(', ')}`)
  if(rows.length!==12||seen.size!==12||sources.size!==1)issues.push('not twelve unique same-source results')
  const valid=issues.length===0,perFileNoRegression=valid&&regressions.length===0
  const under40M=valid&&totalBytes<40000000,numericTimingGoal=valid&&encodeRowSumMs<=targetEncMs
  // Historical report lacks machine/Node/raw JSON. Numeric comparison alone
  // cannot establish same-protocol speedup; only an explicit local assertion can.
  const timingComparable=(confirmComparable||meta?.timingComparableConfirmed===true)
    &&meta?.requestedWorkers===16&&meta?.parallelFiles===1
  const accepted=perFileNoRegression&&under40M&&numericTimingGoal&&timingComparable
  return {status:!valid?'INVALID':!perFileNoRegression?'REGRESSION':!under40M||!numericTimingGoal?'TARGETS_NOT_MET':!timingComparable?'TIMING_UNCONFIRMED':'PASS',
    accepted,coverage:seen.size,issues,regressions,sourceSha256:meta?.source?.sha256??null,
    bytes:{lockedBaseline:baseline.total.bestUcz,total:valid?totalBytes:null,strictUpperExclusive:40000000,perFileNoRegression,under40M},
    timing:{referenceKind:'user-reported P12 sum of encode rows; raw machine/Node metadata unavailable',
      referenceEncMs,targetEncMs,encodeRowSumMs:valid?encodeRowSumMs:null,decodeRowSumMs:valid?decodeRowSumMs:null,
      numericReductionPct:valid?(1-encodeRowSumMs/referenceEncMs)*100:null,numericTimingGoal,
      timingComparableConfirmed:timingComparable,requestedWorkers:meta?.requestedWorkers??null,
      note:'Row sums, not batch wall time. Requested workers are not measured active concurrency.'},
    baselineUpdated:false}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2),confirm=args.includes('--confirm-comparable-timing'),paths=args.filter(a=>a!=='--confirm-comparable-timing')
    if(paths.length!==1||paths[0].startsWith('--'))throw Error('Usage: check-targets.mjs <local-result-dir> [--confirm-comparable-timing]')
    const dir=paths[0],meta=JSON.parse(readFileSync(join(dir,'run-source.meta'),'utf8'))
    const rows=readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(readFileSync(join(dir,f),'utf8')))
    const result=assessTargets(rows,meta,confirm)
    console.log(JSON.stringify(result,null,2));process.exitCode=result.accepted?0:1
  } catch(e) {console.error(`P13 target check failed: ${e.message}`);process.exitCode=2}
}
