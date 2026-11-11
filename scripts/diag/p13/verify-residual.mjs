// Read-only provenance/patch verification. Does NOT re-encode any input.
// --current additionally requires that the recorded production lib is current.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
const sha=x=>createHash('sha256').update(x).digest('hex')
const load=p=>JSON.parse(readFileSync(p,'utf8'))
const folder='scripts/diag/p13-results/residual'
const scripts=['scripts/diag/p13/residual-run.mjs','scripts/diag/p13/residual-probe.ts',
  ...readdirSync('scripts/diag/p13/history').map(f=>join('scripts/diag/p13/history',f))]
const scriptHashes=new Set(scripts.map(p=>sha(readFileSync(p))))
const manifests=['scripts/diag/p12-results/slices.json','scripts/diag/p12-impl/slices.json','scripts/diag/p13/slices.json'].flatMap(p=>load(p).samples)
const sources=new Map(),results=new Map()
let passed=0,failed=0
for(const f of readdirSync(folder).filter(f=>f.endsWith('.json')).sort()) {
  const r=load(join(folder,f)),key=`${r.slice}-${r.which}-${r.experiment}`
  assert.equal(f,`${key}.json`);assert.ok(!results.has(key));results.set(key,r)
  assert.match(r.commit,/^[a-f0-9]{40}$/)
  assert.equal(r.sourceSha256,sha(JSON.stringify(r.sourceFiles)))
  assert.equal(r.experimentalSha256,sha(JSON.stringify(r.experimentalFiles)))
  for(const h of [r.sourceSha256,r.experimentalSha256,r.probeSha256,r.runnerSha256,r.bundleSha256,
    ...Object.values(r.sourceFiles),...Object.values(r.experimentalFiles)])assert.match(h,/^[a-f0-9]{64}$/)
  assert.ok(scriptHashes.has(r.probeSha256),`missing archived probe: ${f}`)
  assert.ok(scriptHashes.has(r.runnerSha256),`missing archived runner: ${f}`)
  assert.ok(r.durationMs>0&&r.durationMs<19000)
  if(!sources.has(r.commit))sources.set(r.commit,Object.fromEntries(Object.keys(r.sourceFiles).map(file=>[file,
    execFileSync('git',['show',`${r.commit}:universal-adaptive-compression-system/src/lib/${file}`],{encoding:'utf8',timeout:3000})])))
  const original=sources.get(r.commit),patched={...original}
  assert.deepEqual(Object.fromEntries(Object.entries(original).map(([f,s])=>[f,sha(s)])),r.sourceFiles)
  for(const p of r.patches) {
    assert.equal(patched[p.file].split(p.from).length,2,`non-unique/missing patch anchor: ${f}`)
    patched[p.file]=patched[p.file].replace(p.from,p.to)
  }
  assert.deepEqual(Object.fromEntries(Object.entries(patched).map(([f,s])=>[f,sha(s)])),r.experimentalFiles)
  if(process.argv.includes('--current'))for(const [file,h] of Object.entries(r.sourceFiles))assert.equal(sha(readFileSync(join('src/lib',file))),h)
  if(r.status==='PASS') {
    passed++
    assert.deepEqual(JSON.parse(r.stdout.trim()),r.result)
    assert.equal(r.stderr,'');assert.equal(r.error,undefined)
    const x=r.result
    assert.deepEqual(x.input,manifests.find(s=>s.name===r.slice))
    assert.ok(x.input.bytes>0&&x.input.bytes<=512*1024)
    assert.equal(x.experiment,r.experiment);assert.equal(x.payloadRoundtrip,true)
    assert.equal(x.productionCompatible,r.experiment==='none')
    assert.match(x.scope,/no production container emitted/)
    assert.ok(Number.isSafeInteger(x.payloadBytes)&&x.payloadBytes>0)
    assert.match(x.payloadSha256,/^[a-f0-9]{64}$/)
    assert.ok(x.encodeMs>=0&&x.decodeMs>=0)
  } else {
    failed++;assert.equal(r.status,'FAIL')
    assert.ok(['sao-mid-256-tg28-none','sao-mid-128-tg28-none'].includes(key))
    assert.match(r.error,/ETIMEDOUT/);assert.equal(r.result,undefined);assert.equal(r.stdout,'')
  }
}
assert.equal(results.size,21);assert.equal(passed,19);assert.equal(failed,2)
const expected={
 'mr-mid-wide6-none':49237,'mr-mid-wide6-res-match':49087,'mr-mid-wide6-res-mix':48965,'mr-mid-wide6-res-both':48897,
 'mr-mid-wide9-ged':52559,'mr-mid-wide9-ged-both':52236,
 'x-ray-mid-wide7-none':115212,'x-ray-mid-wide7-res-match':115206,'x-ray-mid-wide7-res-mix':115223,'x-ray-mid-wide7-res-both':115217,
 'x-ray-mid-wide9-ged':116471,'x-ray-mid-wide9-ged-both':116467,
 'sao-mid-256-tg4-none':160441,'sao-mid-256-tg4-tg-mix':157549,'sao-mid-256-tg4-tg-both':157549,
 'sao-mid-64-tg28-none':36575,'sao-mid-64-tg28-tg-mix':36513,'sao-mid-64-tg4-none':42885,'sao-mid-64-tg4-tg-mix':42501,
}
for(const [key,n] of Object.entries(expected))assert.equal(results.get(key)?.result?.payloadBytes,n)
assert.equal(load('scripts/diag/baseline.json').total.bestUcz,40297869)
console.log(JSON.stringify({receipts:results.size,recordedPayloadRoundtrips:passed,retainedTimeouts:failed,
  exactSourceAndPatchHashes:true,archivedHarnessHashes:true,currentLibBound:process.argv.includes('--current'),
  productionKernelSemanticsChanged:false,reencodedInputs:0,fullFileClaims:false}))
