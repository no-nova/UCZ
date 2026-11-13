// SYNTHETIC METADATA ONLY: never a corpus run or measurement receipt.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assessTargets } from '../scripts/diag/p13/check-targets.mjs'
const root=fileURLToPath(new URL('../',import.meta.url))
const baselinePath=join(root,'scripts/diag/baseline.json'),baselineBytes=readFileSync(baselinePath)
const baseline=JSON.parse(baselineBytes)
const meta=()=>({kind:'p13-local-full-file-validation',parallelFiles:1,requestedWorkers:16,source:{sha256:'a'.repeat(64)}})
// P17.2: the synthetic corpus must sit INSIDE every per-file ceiling while also
// letting the total target be probed. The P17.1 lock (39,947,318 B) is itself
// below 40M, so no slack needs to be invented: the locked numbers already model a
// passing run. The strictness of the 40M gate is exercised below by inflating the
// total by exactly the distance to the target plus one byte, on rows that stay
// inside their own ceilings.
const TARGET = 40000000
const LOCKED = baseline.total.bestUcz
function rows() {
  return baseline.files.map(b=>({file:b.file,size:b.size,sha256:b.sha256,verified:true,
    ucz:b.bestUcz,pct:1,encMs:115765,decMs:1000,
    sourceUnchanged:true,source:{sha256:'a'.repeat(64)}}))
}
test('40M is strict; the -35% encode-row threshold is inclusive and not wall time',()=>{
  // Locked rows already pass: every file at its ceiling, total 39,947,318 < 40M.
  let r=assessTargets(rows(),meta(),true)
  assert.equal(r.status,'PASS');assert.equal(r.accepted,true)
  assert.equal(r.bytes.total,LOCKED)
  assert.equal(r.timing.encodeRowSumMs,1389180)
  assert.equal(r.timing.targetEncMs,1389180);assert.equal(r.timing.referenceEncMs,2137200)

  // Strictness of the 40M gate. Note the structural point: every locked row sits AT
  // its own ceiling, so a corpus built straight from `bestUcz` has exactly zero
  // headroom and any increase is a per-file regression. The boundary probe therefore
  // starts from a corpus that is uniformly BELOW every ceiling, which is both a
  // legal (non-regressing) run and leaves room to grow the total to the target.
  // Boundary probe for the 40M gate specifically. This test is about the TOTAL
  // target, so the probe is built to reach the boundary while respecting only the
  // hard `ucz <= size` invariant; the per-file ceiling is a separate gate that the
  // dedicated regression tests below cover. (The previous version of this test
  // implicitly exceeded mozilla's ceiling by 42,938 B without noticing, which is
  // why it could reach 39,999,999 at all.)
  // Synthetic corpus for the boundary probe. Rows are laid out so the START total is
  // exactly (40M - 12 x MARGIN): every row then needs to grow by at most MARGIN to
  // reach the boundary, which can never cross its own ceiling because MARGIN is far
  // smaller than any row's real headroom above `bestUcz`.
  // The 40M gate is strict (`<`, not `<=`). Two facts make the boundary probe
  // necessarily synthetic:
  //   1. every locked row sits AT its own ceiling, so no corpus that respects the
  //      per-file gate can grow at all;
  //   2. the P17.1 lock total (39,947,318 B) is itself BELOW 40M, so a corpus that
  //      respects the per-file gate can never even reach the boundary.
  // So the total gate is probed with the per-file ceiling deliberately relaxed, and
  // only `bytes.under40M` / `bytes.total` are asserted. The per-file gate has its own
  // dedicated tests below and is not what this case measures.
  const relaxed = (total) => {
    const data = rows()
    let left = total - LOCKED
    const order = [...data].sort((a,b) => (b.size-b.ucz) - (a.size-a.ucz))
    for (const row of order) {
      if (left <= 0) break
      const add = Math.min(left, row.size - row.ucz)
      row.ucz += add; left -= add
    }
    return data
  }
  const at39 = relaxed(TARGET - 1)
  assert.equal(at39.reduce((n,x)=>n+x.ucz,0), TARGET-1)
  r=assessTargets(at39,meta(),true)
  assert.equal(r.bytes.total,TARGET-1)
  assert.equal(r.bytes.under40M,true,'39,999,999 B is under the target')

  const at40 = relaxed(TARGET)
  assert.equal(at40.reduce((n,x)=>n+x.ucz,0), TARGET)
  r=assessTargets(at40,meta(),true)
  assert.equal(r.bytes.total,TARGET)
  assert.equal(r.bytes.under40M,false,'exactly 40,000,000 B must NOT count as under')

  const tooSlow=rows();tooSlow[0].encMs++
  r=assessTargets(tooSlow,meta(),true)
  assert.equal(r.bytes.under40M,true);assert.equal(r.timing.numericTimingGoal,false);assert.equal(r.accepted,false)
})
test('numeric timing gain is not accepted as comparable without explicit local confirmation',()=>{
  let r=assessTargets(rows(),meta())
  assert.equal(r.status,'TIMING_UNCONFIRMED');assert.equal(r.timing.numericTimingGoal,true);assert.equal(r.accepted,false)
  r=assessTargets(rows(),{...meta(),timingComparableConfirmed:true})
  assert.equal(r.status,'PASS')
  r=assessTargets(rows(),{...meta(),requestedWorkers:8},true)
  assert.equal(r.status,'TIMING_UNCONFIRMED')
})
test('one-byte per-file regression cannot be offset by any other gain',()=>{
  const data=rows();data.find(x=>x.file==='xml').ucz++
  data.find(x=>x.file==='mozilla').ucz-=10000
  const r=assessTargets(data,meta(),true)
  assert.equal(r.bytes.under40M,true);assert.equal(r.status,'REGRESSION');assert.equal(r.accepted,false)
  assert.deepEqual(r.regressions,[{file:'xml',bytes:1}])
})
test('twelve locked-baseline rows are nonregressing and now clear the 40M target',()=>{
  // P17.1 moved the lock from 40,042,937 B to 39,947,318 B, so a run that merely
  // reproduces the lock now PASSES the 40M gate instead of failing it. This is the
  // assertion that has to flip when the lock crosses the target: it is the evidence
  // that the gate is reading real bytes, not a hardcoded expectation.
  const data=rows();for(const r of data)r.ucz=baseline.files.find(b=>b.file===r.file).bestUcz
  const r=assessTargets(data,meta(),true)
  assert.equal(r.bytes.total,39947318);assert.equal(r.bytes.perFileNoRegression,true)
  assert.equal(r.bytes.under40M,true)
  assert.equal(r.status,'PASS')
})
test('missing, duplicate, unverified, mixed-source and invalid-timing rows fail closed',()=>{
  for(const mutate of [d=>d.pop(),d=>d.push(d[0]),d=>{d[0].verified=false},d=>{d[0].size++},
    d=>{d[0].sha256='0'.repeat(64)},d=>{d[0].source.sha256='b'.repeat(64)},
    d=>{d[0].sourceUnchanged=false},d=>{delete d[0].encMs},d=>{d[0].decMs=-1},d=>{d[0].file='unknown'}]) {
    const data=rows();mutate(data)
    const r=assessTargets(data,meta(),true)
    assert.equal(r.status,'INVALID');assert.equal(r.accepted,false);assert.equal(r.bytes.total,null)
  }
  assert.equal(assessTargets(rows(),{},true).status,'INVALID')
})
test('local target CLI reports nonacceptance with nonzero exit and never rewrites the lock',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ucz-p13-targets-'))
  try {
    writeFileSync(join(dir,'run-source.meta'),JSON.stringify(meta()))
    for(const r of rows())writeFileSync(join(dir,`${r.file}.json`),JSON.stringify(r))
    const run=(...args)=>spawnSync(process.execPath,[join(root,'scripts/diag/p13/check-targets.mjs'),dir,...args],{encoding:'utf8',timeout:5000})
    let r=run();assert.ifError(r.error);assert.equal(r.status,1)
    assert.equal(JSON.parse(r.stdout).status,'TIMING_UNCONFIRMED')
    r=run('--confirm-comparable-timing');assert.ifError(r.error);assert.equal(r.status,0,r.stderr)
    assert.equal(JSON.parse(r.stdout).status,'PASS')
    writeFileSync(join(dir,'xml.json'),'')
    r=run();assert.ifError(r.error);assert.equal(r.status,2)
    assert.match(r.stderr,/P13 target check failed/)
    { const a=readFileSync(baselinePath),b=Buffer.from(baselineBytes)
      assert.equal(a.length,b.length)
      for(let i=0;i<a.length;i++) if(a[i]!==b[i]) assert.fail(`baseline 第 ${i} 字节不同 ${a[i]} != ${b[i]}`) }
  } finally {rmSync(dir,{recursive:true,force:true})}
})
test('user-local wrapper has valid shell syntax; no full-file execution in this test',()=>{
  const r=spawnSync('bash',['-n',join(root,'scripts/diag/p13/local-validate.sh')],{encoding:'utf8',timeout:2000})
  assert.ifError(r.error);assert.equal(r.status,0,r.stderr)
})
