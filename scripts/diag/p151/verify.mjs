import {createHash} from 'node:crypto'
import {readFileSync,readdirSync,existsSync,writeFileSync} from 'node:fs'
import assert from 'node:assert/strict'
const sha=x=>createHash('sha256').update(x).digest('hex'),dir='scripts/diag/p151-results',history='scripts/diag/p151/history'
const source=Object.fromEntries(readdirSync('src/lib').filter(f=>f.endsWith('.ts')).sort().map(f=>[f,sha(readFileSync(`src/lib/${f}`))]))
const fingerprint=sha(JSON.stringify(source)),rows=[]
for(const f of readdirSync(dir).filter(f=>f.endsWith('.json')&&f!=='summary.json')){
 const r=JSON.parse(readFileSync(`${dir}/${f}`));assert.ok(['PASS','FAIL'].includes(r.status));assert.equal(r.sourceSha256,sha(JSON.stringify(r.sourceFiles)))
 for(const [name,h] of Object.entries(r.sourceFiles)){const p=`${history}/${h}-${name}.txt`;assert.ok(existsSync(p),p);assert.equal(sha(readFileSync(p)),h)}
 const p=`${history}/${r.testSha256}-${r.test}.ts.txt`;assert.ok(existsSync(p),p);assert.equal(sha(readFileSync(p)),r.testSha256)
 assert.ok(r.innerBudgetMs<=17000&&r.outerBudgetMs<=19000);rows.push({file:f,status:r.status,timedOut:!!r.timedOut,sourceSha256:r.sourceSha256})
}
const failures=rows.filter(r=>r.status==='FAIL');assert.equal(failures.length,1);assert.ok(failures[0].file.includes('webster-adaptive-256')&&failures[0].timedOut)
// Earlier receipts predate a comment-only correction in codec.ts. Verify the
// archived contents differ only by that exact comment, not production code.
for(const r of rows){
 if(r.sourceSha256===fingerprint)continue
 const receipt=JSON.parse(readFileSync(`${dir}/${r.file}`));
 const oldCodec=readFileSync(`${history}/${receipt.sourceFiles['codec.ts']}-codec.ts.txt`,'utf8')
 const currentCodec=readFileSync('src/lib/codec.ts','utf8')
 assert.equal(oldCodec.replace('上下文模式 1..4（5..7 保留）','上下文模式 1..5（6..7 保留）'),currentCodec)
 for(const [name,h] of Object.entries(receipt.sourceFiles))if(name!=='codec.ts')assert.equal(h,source[name])
}
const summary={status:'PASS',scope:'receipt identity and archived source hashes; does not rerun tests or prove full-file behavior',count:rows.length,passed:rows.length-failures.length,failed:failures.length,failures,sourceFingerprint:fingerprint,archivedFiles:readdirSync(history).length}
writeFileSync(`${dir}/summary.json`,JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary))
