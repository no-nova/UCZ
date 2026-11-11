// Read-only evidence check: no encoding, no baseline or receipt rewriting.
// --current binds only collision-final (not the old P12.2 receipts) to src/lib.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
const sha=x=>createHash('sha256').update(x).digest('hex')
const load=p=>JSON.parse(readFileSync(p,'utf8'))
const dir='scripts/diag/p12-fix-results'
const before=load(join(dir,'collision-eb71.json')),initial=load(join(dir,'collision-fixed.json')),after=load(join(dir,'collision-final.json'))
for(const r of [before,initial,after]) {
  assert.ok(r.durationMs>0&&r.durationMs<19000)
  assert.equal(r.sourceSha256,sha(JSON.stringify(r.sourceFiles)))
  for(const h of [r.sourceSha256,r.probeSha256,r.runnerSha256,r.bundleSha256,...Object.values(r.sourceFiles)])assert.match(h,/^[0-9a-f]{64}$/)
  assert.equal(r.probeSha256,sha(readFileSync('scripts/diag/p12-fix/probe.ts')))
  assert.equal(r.runnerSha256,sha(readFileSync('scripts/diag/p12-fix/run.mjs')))
  assert.deepEqual(JSON.parse(r.stdout.trim()),r.result)
  assert.equal(r.stderr,'')
  assert.equal(r.result.inputBytes,4133)
  assert.equal(r.result.inputSha256,'4ad3071a2d54f526889b12f5978ba11d879db4cf181b18994357df7dc77357cd')
  assert.deepEqual(r.result.uncontested,before.result.uncontested)
}
assert.equal(before.sourceCommit,'eb71c5c748aced5f8081af9c6e56f9f65e9fe2fd')
assert.equal(before.workingSource,false)
assert.equal(before.sourceSha256,'83a4dc738009fbf917afaf6319ae55f15b7642b012bb05a6302f9097e1ff7f77')
assert.equal(before.exitCode,1);assert.equal(before.status,'FAIL')
assert.equal(before.result.error,'自动转置产生重复的方案规则')
assert.equal(before.result.roundtrip,'not reached')
for(const r of [initial,after]) {
  assert.equal(r.workingSource,true)
  assert.equal(r.exitCode,0);assert.equal(r.status,'PASS');assert.equal(r.result.roundtrip,true)
  assert.equal(r.result.bytes,791)
  assert.equal(r.result.containerSha256,'953066fa0396cf5d611068e1bf5123cc906692e09e821be6015ef2d18ced40b8')
  assert.deepEqual(r.result.finalRules,[{id:30,s:4,r:1},{id:22,s:4,r:1}])
}
assert.deepEqual(initial.result,after.result)
if(process.argv.includes('--current')) {
  const files=Object.fromEntries(readdirSync('src/lib').sort().filter(f=>f.endsWith('.ts')).map(f=>[f,sha(readFileSync(join('src/lib',f)))]))
  assert.deepEqual(files,after.sourceFiles,'final repair receipt differs from current src/lib')
}
const user=load(join(dir,'user-local-partial.json')),base=load('scripts/diag/baselines/p111-a3b6c3d.json')
assert.equal(user.sourceCommit,null);assert.equal(user.sourceSha256,null)
assert.equal(user.rows.length,11);assert.equal(new Set(user.rows.map(r=>r.file)).size,11)
for(const r of user.rows) {
  assert.equal(r.lockedBestUcz,base.files.find(b=>b.file===r.file).bestUcz)
  assert.equal(r.deltaBytes,r.reportedBytes-r.lockedBestUcz)
}
const sum=field=>user.rows.reduce((n,r)=>n+r[field],0)
assert.equal(sum('reportedBytes'),27175039);assert.equal(sum('lockedBestUcz'),28556376)
assert.equal(sum('deltaBytes'),-1381337)
assert.equal(user.sameElevenFileSubset.isFullTwelveFileTotal,false)
assert.equal(user.mozilla.reportedBytes,null)
assert.equal(base.total.bestUcz,41814147)
assert.equal(base.bestUczPolicy.strict,true)
console.log(JSON.stringify({syntheticReceiptsChecked:3,oldReproduction:'expected FAIL (exit 1)',repairedReproductions:'PASS',
  currentLibBound:process.argv.includes('--current'),finalLibSha256:after.sourceSha256,
  historicalPartialEvidence:'11 reported successes, Mozilla failed, source identity unknown; superseded by separately archived local full validation',
  historicalP111ReferenceBytes:41814147,currentLockedBaselineBytes:load("scripts/diag/baseline.json").total.bestUcz,fullCorpusEncodedHere:false},null,2))
