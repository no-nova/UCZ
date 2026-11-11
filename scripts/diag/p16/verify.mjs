import {createHash} from 'node:crypto'
import {readFileSync,readdirSync,existsSync} from 'node:fs'
import assert from 'node:assert/strict'
const hash=x=>createHash('sha256').update(x).digest('hex'),history='scripts/diag/p16/history',root='scripts/diag/p16-results'
let count=0,passes=0,failures=0
for(const file of readdirSync(root).filter(x=>x.endsWith('.json'))){
 const r=JSON.parse(readFileSync(`${root}/${file}`));assert.equal(r.sourceSha256,hash(JSON.stringify(r.sourceFiles)));assert.ok(r.innerBudgetMs<=17000&&r.outerBudgetMs<=19000)
 for(const [name,h] of Object.entries(r.sourceFiles)){const p=`${history}/${h}-${name}.txt`;assert.ok(existsSync(p));assert.equal(hash(readFileSync(p)),h)}
 const p=`${history}/${r.testSha256}-${r.test}.ts.txt`;assert.ok(existsSync(p));assert.equal(hash(readFileSync(p)),r.testSha256)
 if(r.status==='PASS'){assert.ok(r.result);passes++}else{assert.equal(r.status,'FAIL');failures++}count++
}
assert.ok(count>0);console.log(JSON.stringify({status:'PASS',count,passes,failures,scope:'receipt and archived source/test hash validation only; does not rerun tests or prove full-file behavior'}))
