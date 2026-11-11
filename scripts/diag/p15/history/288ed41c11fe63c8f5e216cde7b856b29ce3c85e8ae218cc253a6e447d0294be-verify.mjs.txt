import {readFileSync,readdirSync,existsSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
const sha=x=>createHash('sha256').update(x).digest('hex')
const history='scripts/diag/p15/history',root='scripts/diag/p15-results'
const source=Object.fromEntries(readdirSync('src/lib').filter(x=>x.endsWith('.ts')).sort().map(x=>[x,sha(readFileSync(`src/lib/${x}`))]))
assert.equal(sha(JSON.stringify(source)),'539d10e904c8d677273b8f6d8755ba30c7bc53d44351766500e6a7bccea5ea65')
const counts={},failures=[];let receipts=0,archives=0
for(const f of readdirSync(history)){assert.equal(sha(readFileSync(`${history}/${f}`)),f.slice(0,64));archives++}
for(const unit of ['unit1','unit2','unit3','unit4']){
 counts[unit]={PASS:0,FAIL:0}
 for(const f of readdirSync(`${root}/${unit}`).filter(f=>f.endsWith('.json'))){
  const r=JSON.parse(readFileSync(`${root}/${unit}/${f}`));receipts++
  assert.equal(r.unit,unit);assert.ok(r.status==='PASS'||r.status==='FAIL');counts[unit][r.status]++
  assert.equal(r.sourceSha256,sha(JSON.stringify(source)));assert.deepEqual(r.sourceFiles,source)
  assert.equal(r.productionSourceModified,false);assert.equal(r.fullCorpusEncoded,false);assert.ok(r.bytes<=262144);assert.equal(r.maxCMBytes,524288)
  for(const [name,h] of [...Object.entries(r.sourceFiles),...Object.entries(r.scripts)])assert.ok(existsSync(`${history}/${h}-${name}.txt`),`missing archive ${name} ${h}`)
  if(r.status==='PASS'){assert.ok(r.result);assert.equal(r.result.fullFileMeasured,false);assert.equal(r.result.productionSourceModified,false)}
  else failures.push({unit,file:f,timedOut:r.timedOut??false,error:r.error??null})
 }
}
assert.equal(failures.length,2)
assert.ok(failures.some(x=>x.file.includes('dual-boundary')&&!x.timedOut))
assert.ok(failures.some(x=>x.file.includes('x-ray-mid--adaptive--262144')&&x.timedOut))
const baseline=JSON.parse(readFileSync('scripts/diag/baseline.json'));assert.equal(baseline.total.bestUcz,40075423)
const out={status:'PASS',scope:'receipt schema, source/archive hashes and stated bounds; does not rerun experiments or independently validate compression',receipts,counts,failures,archives,productionFingerprint:sha(JSON.stringify(source)),baselineBytes:40075423}
writeFileSync(`${root}/summary.json`,JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out))
