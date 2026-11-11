// Read-only P13 complete-container and bounded-regression receipt checks.
// --current binds the final replay and fixed test receipts to current src/lib.
// Historical working-source digests are retained, not relabeled as commits.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
const sha=x=>createHash('sha256').update(x).digest('hex'),load=p=>JSON.parse(readFileSync(p,'utf8'))
const root='scripts/diag/p13-results'
const current=Object.fromEntries(readdirSync('src/lib').sort().filter(f=>f.endsWith('.ts')).map(f=>[f,sha(readFileSync(join('src/lib',f)))]))
const manifest=['scripts/diag/p12-results/slices.json','scripts/diag/p12-impl/slices.json'].flatMap(p=>load(p).samples)
const rows=[]
for(const phase of ['audit','screen','bcj','final'])for(const f of readdirSync(join(root,phase)).filter(f=>f.endsWith('.json'))) {
  const r=load(join(root,phase,f));rows.push(r)
  assert.equal(r.sourceSha256,sha(JSON.stringify(r.sourceFiles)))
  for(const h of [r.probeSha256,r.runnerSha256,r.bundleSha256,...Object.values(r.sourceFiles)])assert.match(h,/^[a-f0-9]{64}$/)
  assert.ok(r.durationMs>0&&r.durationMs<19000)
  if(r.status==='FAIL') {
    assert.equal(r.slice,'xray-mid');assert.equal(phase,'audit');assert.equal(r.result,undefined)
    assert.match(r.stderr,/AssertionError/);continue
  }
  assert.equal(r.status,'PASS')
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').at(-1)),r.result)
  const x=r.result
  assert.deepEqual(x.input,manifest.find(s=>s.name===r.slice));assert.ok(x.input.bytes<=512*1024)
  assert.equal(x.roundtrip,true);assert.equal(x.containerRoundtrip,true)
  assert.ok(Number.isSafeInteger(x.bytes)&&x.bytes>0&&x.headerBytes>0)
  assert.match(x.containerSha256,/^[a-f0-9]{64}$/)
  if(phase==='final'&&process.argv.includes('--current'))assert.deepEqual(r.sourceFiles,current)
}
assert.equal(rows.length,15);assert.equal(rows.filter(r=>r.status==='PASS').length,14)
const forced=(slice,c)=>rows.find(r=>r.phase==='audit'&&r.slice===slice&&r.case===c).result
for(const [c,n] of [['bcj1-v15',101991],['bcj1-v20',100154],['bcj2-v15',100314],['bcj2-v20',98479]])assert.equal(forced('ooffice-code',c).bytes,n)
for(const [slice,kind,n] of [['mozilla-code','bin',72080],['samba-c','text',32224],['xml-mid','text',4708]]) {
  const policy=rows.find(r=>r.phase==='screen'&&r.slice===slice&&r.case===`${kind}-policy`).result
  const oracle=rows.find(r=>r.phase==='screen'&&r.slice===slice&&r.case===`${kind}-oracle`).result
  assert.equal(policy.bytes,n);assert.equal(oracle.bytes,n);assert.equal(policy.containerSha256,oracle.containerSha256)
}
const last=rows.find(r=>r.phase==='final').result
assert.equal(last.bytes,98479);assert.equal(last.containerSha256,forced('ooffice-code','bcj2-v20').containerSha256)
assert.deepEqual(last.screening[0].selected,[3]);assert.equal(last.screening[0].sampleBytes,196608)
assert.equal(last.candidates.length,2);assert.equal(last.selected,'bcj2-v20')
const history='scripts/diag/p13/history'
const testHashes=new Set([sha(readFileSync('tests/p13.test.ts')),...readdirSync(history).map(f=>sha(readFileSync(join(history,f))))])
const tests=readdirSync(join(root,'tests')).filter(f=>f.endsWith('.json')).map(f=>load(join(root,'tests',f)))
for(const r of tests) {
  assert.equal(r.sourceSha256,sha(JSON.stringify(r.sourceFiles)))
  assert.ok(r.durationMs>0&&r.durationMs<19000)
  assert.ok(testHashes.has(r.testSha256))
  assert.equal(r.runnerSha256,sha(readFileSync('tests/run-p13.mjs')))
  assert.equal(r.receiptRunnerSha256,sha(readFileSync('scripts/diag/p13/test-run.mjs')))
  if(r.phase==='cache-before') {
    assert.equal(r.status,'FAIL');assert.equal(r.exitCode,1);assert.match(r.stderr,/AssertionError/)
    assert.match(r.stderr,/Buffer\(113\)/);assert.match(r.stderr,/Buffer\(720\)/)
  } else {
    assert.equal(r.status,'PASS');assert.equal(r.exitCode,0);assert.equal(r.stderr,'')
    assert.match(r.stdout,/PASS/)
    if(process.argv.includes('--current'))assert.deepEqual(r.sourceFiles,current)
  }
}
assert.equal(tests.length,6);assert.equal(tests.filter(r=>r.status==='PASS').length,5)
assert.equal(load('scripts/diag/baselines/p12-d9b84df.json').total.bestUcz,40297869)
console.log(JSON.stringify({completeContainerReceipts:15,recordedContainerPasses:14,retainedTypoFailure:1,
  boundedTestReceipts:6,recordedTestPasses:5,retainedPreFixCacheFailure:1,
  finalLibSha256:sha(JSON.stringify(current)),currentFinalLibBound:process.argv.includes('--current'),
  historicalWorkingSourceDigests:'retained, not retroactively commit-bound',reencodedInputs:0}))
