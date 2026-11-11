// One bounded synthetic test shard with an immutable source-bound receipt.
// node scripts/diag/p13/test-run.mjs <phase> <shard>
import { spawnSync, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
const begun=performance.now(),[phase,shard]=process.argv.slice(2)
if(![phase,shard].every(x=>x&&/^[\w.-]+$/.test(x)))throw Error('phase / shard required')
const path=`scripts/diag/p13-results/tests/${phase}-${shard}.json`
if(existsSync(path))throw Error(`Refusing to overwrite ${path}`)
const sha=x=>createHash('sha256').update(x).digest('hex')
const sourceFiles=Object.fromEntries(readdirSync('src/lib').sort().filter(f=>f.endsWith('.ts')).map(f=>[f,sha(readFileSync(join('src/lib',f)))]))
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
const r=spawnSync(process.execPath,['tests/run-p13.mjs',shard],{encoding:'utf8',timeout:Math.max(1,18000-Math.ceil(performance.now()-begun)),killSignal:'SIGKILL',maxBuffer:2*1024*1024})
const result={phase,shard,sourceCommit,workingSource:true,sourceFiles,sourceSha256:sha(JSON.stringify(sourceFiles)),
  testSha256:sha(readFileSync('tests/p13.test.ts')),runnerSha256:sha(readFileSync('tests/run-p13.mjs')),
  receiptRunnerSha256:sha(readFileSync('scripts/diag/p13/test-run.mjs')),
  status:r.status===0&&!r.error?'PASS':'FAIL',exitCode:r.status,signal:r.signal,error:r.error?.message,
  node:process.version,durationMs:Math.round(performance.now()-begun),stdout:r.stdout,stderr:r.stderr,
  scope:'one bounded synthetic test shard; no full corpus encoding'}
mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(result,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({receipt:path,status:result.status,durationMs:result.durationMs}))
if(r.stdout)console.log(r.stdout.trim())
if(result.status!=='PASS'){console.error(r.stderr);process.exitCode=1}
