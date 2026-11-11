// One bounded synthetic pre/post-fix probe; no branch switch and no corpus I/O.
// node scripts/diag/p12-fix/run.mjs <new-receipt-label> [git-ref]
import { build } from 'esbuild'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
const begun=performance.now(),[label,ref]=process.argv.slice(2)
if(!label||!/^[\w.-]+$/.test(label))throw Error('A fresh receipt label is required')
const sha=b=>createHash('sha256').update(b).digest('hex')
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',maxBuffer:4*1024*1024}).trim()
const commit=git('rev-parse',ref??'HEAD'),temp=resolve('.diag-state/p12-fix',`${label}-${process.pid}`)
mkdirSync(temp,{recursive:true})
let lib=resolve('src/lib')
if(ref) {
  lib=join(temp,'src/lib');mkdirSync(lib,{recursive:true})
  const prefix=git('rev-parse','--show-prefix')
  for(const rel of git('ls-tree','-r','--name-only',commit,'--','src/lib').split('\n')) {
    const file=join(lib,rel.replace(/^src\/lib\//,''));mkdirSync(dirname(file),{recursive:true})
    writeFileSync(file,execFileSync('git',['show',`${commit}:${prefix}${rel}`],{maxBuffer:4*1024*1024}))
  }
}
const sourceFiles=Object.fromEntries(readdirSync(lib).sort().filter(f=>f.endsWith('.ts')).map(f=>[f,sha(readFileSync(join(lib,f)))]))
const receipt=resolve(`scripts/diag/p12-fix-results/${label}.json`)
if(existsSync(receipt))throw Error(`Refusing to overwrite ${receipt}`)
const entry=resolve('scripts/diag/p12-fix/probe.ts'),bundle=join(temp,'probe.cjs')
await build({entryPoints:[entry],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'silent',
  plugins:[{name:'immutable-source',setup(b){b.onResolve({filter:/^@lib\//},a=>({path:join(lib,a.path.slice(5)+'.ts')}))}}]})
const r=spawnSync(process.execPath,[bundle],{encoding:'utf8',timeout:Math.max(1,17500-Math.ceil(performance.now()-begun)),killSignal:'SIGKILL',maxBuffer:1024*1024})
let result=null
try{result=JSON.parse(r.stdout.trim().split('\n').at(-1))}catch{}
const record={label,sourceCommit:commit,workingSource:!ref,sourceFiles,sourceSha256:sha(JSON.stringify(sourceFiles)),
  probeSha256:sha(readFileSync(entry)),runnerSha256:sha(readFileSync('scripts/diag/p12-fix/run.mjs')),bundleSha256:sha(readFileSync(bundle)),
  command:process.argv.slice(1),node:process.version,durationMs:Math.round(performance.now()-begun),
  exitCode:r.status,status:r.status===0&&!r.error?'PASS':'FAIL',error:r.error?.message,stdout:r.stdout,stderr:r.stderr,result}
mkdirSync(dirname(receipt),{recursive:true});writeFileSync(receipt,JSON.stringify(record,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({receipt,status:record.status,durationMs:record.durationMs,result}))
process.exitCode=r.status??1
