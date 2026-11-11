import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, cpSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SOURCE_PATHS } from '../scripts/diag/p9-checkpoint.mjs'

const root=fileURLToPath(new URL('../',import.meta.url))
const baseline=JSON.parse(readFileSync(join(root,'scripts/diag/baseline.json'),'utf8'))
// Synthetic result metadata only. These tests never compress Silesia files and
// must not be counted as measurement receipts or a new twelve-file baseline.
const row = b => ({file:b.file,size:b.size,sha256:b.sha256,verified:true,ucz:b.bestUcz,
  pct:+(b.bestUcz/b.size*100).toFixed(2),encMs:1000,decMs:100,source:{sha256:'a'.repeat(64)}})
function temporary(fn) {
  const dir=mkdtempSync(join(tmpdir(),'ucz-diag-test-'))
  try {return fn(dir)} finally {rmSync(dir,{recursive:true,force:true})}
}
function summary(...args) {
  const r=spawnSync(process.execPath,[join(root,'scripts/diag/summary.mjs'),...args],{encoding:'utf8',timeout:8000})
  assert.ifError(r.error)
  return r
}
function putRows(dir,rows=baseline.files.map(row)) {
  for(const r of rows)writeFileSync(join(dir,`${r.file}.json`),JSON.stringify(r))
}

test('summary defaults to locked bestUcz and accepts an individual existing JSON path',()=>temporary(dir=>{
  const r=row(baseline.files[0]),path=join(dir,'xml.json');writeFileSync(path,JSON.stringify(r))
  const result=summary(path)
  assert.equal(result.status,0,result.stderr)
  assert.match(result.stdout,/锁定 P17\.1 bestUcz/)
  assert.match(result.stdout,/^xml\s+333917\s+333917/m)
  assert.match(result.stdout,/有效子集小计 333917\/333917 B/)
  assert.match(result.stdout,/不是完整十二文件结果/)
  const old=summary(path,'--v14')
  assert.match(old.stdout,/历史 v14 ucz（不是锁定 bestUcz）/)
  assert.match(old.stdout,/^xml\s+333917\s+381797/m)
  assert.doesNotMatch(result.stdout,/70\.7|15\.4/,'do not relabel historical v14 timings as the current lock')
}))

test('malformed Mozilla result is incomplete, never a twelve-file success',()=>temporary(dir=>{
  putRows(dir,baseline.files.filter(b=>b.file!=='mozilla').map(row))
  writeFileSync(join(dir,'mozilla.json'),'')
  const r=summary(dir,'--all')
  assert.notEqual(r.status,0)
  assert.match(r.stdout,/FAIL mozilla\.json/)
  assert.match(r.stdout,/有效且唯一的结果 11\/12/)
  assert.match(r.stdout,/缺少或无效 mozilla/)
  assert.match(r.stdout,/有效子集小计 27001287\/27001287 B/)
}))

test('twelve valid same-source rows use the P17.1 39947318 ceiling',()=>temporary(dir=>{
  putRows(dir)
  const r=summary(dir,'--all')
  assert.equal(r.status,0,r.stdout+r.stderr)
  assert.match(r.stdout,/十二项字节小计 39947318\/39947318 B/)
}))

test('duplicates and unverified or mismatched inputs cannot inflate summary coverage',()=>temporary(dir=>{
  putRows(dir)
  writeFileSync(join(dir,'xml-again.json'),JSON.stringify(row(baseline.files[0])))
  let r=summary(dir,'--all')
  assert.notEqual(r.status,0);assert.match(r.stdout,/xml：重复记录/)
  rmSync(join(dir,'xml-again.json'))
  for(const change of [{verified:false},{sha256:'0'.repeat(64)},{size:1},{sourceUnchanged:false}]) {
    writeFileSync(join(dir,'xml.json'),JSON.stringify({...row(baseline.files[0]),...change}))
    r=summary(dir,'--all');assert.notEqual(r.status,0);assert.match(r.stdout,/有效且唯一的结果 11\/12/)
  }
}))

test('a one-byte regression cannot be offset by another gain; mixed sources stay explicit',()=>temporary(dir=>{
  const rows=baseline.files.map(row);rows[0].ucz++;rows[1].ucz-=10000
  putRows(dir,rows)
  let r=summary(dir,'--all')
  assert.notEqual(r.status,0);assert.match(r.stdout,/FAIL 超过锁定 bestUcz 1 B/)
  putRows(dir)
  const changed=row(baseline.files[0]);changed.source.sha256='b'.repeat(64)
  writeFileSync(join(dir,'xml.json'),JSON.stringify(changed))
  r=summary(dir,'--all');assert.notEqual(r.status,0);assert.match(r.stdout,/源码 SHA 混合或缺失/)
}))

test('gitHead for a source-only directory returns null without leaking fatal Git stderr',()=>temporary(dir=>{
  const url=pathToFileURL(join(root,'scripts/diag/p9-checkpoint.mjs')).href
  const env={...process.env};delete env.GIT_DIR;delete env.GIT_WORK_TREE
  const r=spawnSync(process.execPath,['--input-type=module','-e',
    `import {gitHead} from ${JSON.stringify(url)}; console.log(JSON.stringify(gitHead(${JSON.stringify(dir)})));`],
    {cwd:dir,env,encoding:'utf8',timeout:8000})
  assert.ifError(r.error);assert.equal(r.status,0);assert.equal(r.stdout.trim(),'null');assert.equal(r.stderr,'')
}))

test('real bench-one CLI works from a foreign cwd on an archive without .git',()=>temporary(dir=>{
  const project=join(dir,'archive');mkdirSync(project)
  for(const rel of SOURCE_PATHS) {
    const target=join(project,rel);mkdirSync(dirname(target),{recursive:true})
    cpSync(join(root,rel),target,{recursive:true})
  }
  // Dependencies are not fingerprinted source; do not copy a large npm tree.
  symlinkSync(join(root,'node_modules'),join(project,'node_modules'),'dir')
  const input=join(dir,'tiny.bin');writeFileSync(input,Buffer.alloc(64,65))
  const env={...process.env,UCZ_THREADS:'1'}
  for(const key of ['GIT_DIR','GIT_WORK_TREE','P9_PROJECT_ROOT','P9_SOURCE_SHA'])delete env[key]
  const r=spawnSync(process.execPath,[join(project,'scripts/diag/run.mjs'),'bench-one',input,'--no-single','--no-bench'],
    {cwd:dir,env,encoding:'utf8',timeout:10000})
  assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr)
  assert.equal(r.stderr,'')
  const out=JSON.parse(r.stdout)
  assert.equal(out.size,64);assert.equal(out.verified,true);assert.equal(out.sourceUnchanged,true)
  assert.equal(out.source.commit,null);assert.equal(out.source.gitAvailable,false)
  assert.match(out.source.sha256,/^[0-9a-f]{64}$/)
}))
