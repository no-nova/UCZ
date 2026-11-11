// One bounded shard per invocation; default = synthetic wire tests, never the corpus.
// timeout --signal=KILL 19s node tests/p141-implementation.test.mjs <case> [slice] [mode] [bytes]
import { build } from 'esbuild'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
const begun=performance.now(),sha=data=>createHash('sha256').update(data).digest('hex')
const [which='wire',slice='synthetic',mode='current',bytes]=process.argv.slice(2)
if(!['wire','kernel','guard','worker','adaptive','compat','format-extra','screen','proposals'].includes(which))throw Error('Choose wire / kernel / guard / worker / adaptive / compat / format-extra / screen / proposals')
if(![slice,mode].every(x=>/^[\w.-]+$/.test(x)))throw Error('invalid shard args')
if(bytes && (!/^\d+$/.test(bytes)||Number(bytes)>262144||Number(bytes)<1))throw Error('slice limit 262144 B')
const base=resolve('.diag-state/p141');mkdirSync(base,{recursive:true})
let lib=resolve('src/lib'),sourceRef='working'
if(which==='adaptive'&&mode.split('-')[0]==='old') {
 sourceRef=execFileSync('git',['rev-parse','ed09309'],{encoding:'utf8'}).trim()
 lib=join(base,'old-lib');mkdirSync(lib,{recursive:true})
 const paths=execFileSync('git',['ls-tree','-r','--name-only',sourceRef,'--','src/lib'],{encoding:'utf8'}).trim().split('\n')
 for(const path of paths) {
  const name=path.replace(/^src\/lib\//,'')
  const content=execFileSync('git',['show',`${sourceRef}:universal-adaptive-compression-system/src/lib/${name}`],{maxBuffer:4*1024*1024}),target=join(lib,name)
  if(existsSync(target)){if(sha(readFileSync(target))!==sha(content))throw Error('old source cache differs')}else writeFileSync(target,content,{flag:'wx'})
 }
}
const sourceFiles=Object.fromEntries(readdirSync(lib).filter(f=>f.endsWith('.ts')).sort().map(f=>[f,sha(readFileSync(join(lib,f)))]))
const sourceSha256=sha(JSON.stringify(sourceFiles))
const history=resolve('scripts/diag/p141/history');mkdirSync(history,{recursive:true})
function archive(path,name) {
 const content=readFileSync(path),hash=sha(content),target=join(history,`${hash}-${name}.txt`)
 if(existsSync(target)){if(sha(readFileSync(target))!==hash)throw Error('history SHA mismatch')}
 else writeFileSync(target,content,{flag:'wx'})
 return hash
}
for(const name of Object.keys(sourceFiles))archive(join(lib,name),name)
const entry=which==='adaptive'?'scripts/diag/p141/adaptive.ts':'tests/p141-core.ts'
const scripts=Object.fromEntries([entry,...(which==='adaptive'?[]:['tests/p141-extra.ts','tests/p7-v15-fixtures.json','tests/legacy-wordpre-fixtures.json']),'scripts/diag/p141/input.ts','scripts/diag/p141/cases.json','scripts/diag/p14/slices.json','tests/p141-implementation.test.mjs'].map(path=>[path,archive(path,path.split('/').at(-1))]))
const bundle=join(base,`${which}-${slice}-${mode}-${process.pid}.cjs`)
let run,error
try {
 await build({entryPoints:[entry],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'silent',plugins:[{
  name:'p141-source',setup(b){b.onResolve({filter:/^@lib\//},a=>({path:join(lib,a.path.slice(5)+'.ts')}))},
 }]})
 run=spawnSync(process.execPath,[bundle,which,slice,mode,...(bytes?[bytes]:[])],{encoding:'utf8',timeout:Math.max(1,17000-Math.ceil(performance.now()-begun)),killSignal:'SIGKILL',maxBuffer:2*1024*1024,env:{...process.env,UCZ_THREADS:mode.endsWith('-parallel')?'4':'1',P141_SOURCE_REF:sourceRef,P141_SOURCE_SHA256:sourceSha256}})
 error=run.error?.message
}catch(e){error=e.message}
const status=run?.status===0&&!error?'PASS':'FAIL'
let result
try {result=JSON.parse((run?.stdout??'').trim().split('\n').at(-1))}catch{}
const receipt={kind:'P14.1-bounded-implementation-test',case:which,slice,mode,requestedBytes:bytes?Number(bytes):null,status,sourceRef,
 commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceSha256,sourceFiles,scripts,
 bundleSha256:existsSync(bundle)?sha(readFileSync(bundle)):null,command:process.argv.slice(1),node:process.version,
 durationMs:Math.round(performance.now()-begun),exitCode:run?.status??null,error,stdout:run?.stdout??'',stderr:run?.stderr??'',result,
 maxRawSliceBytes:262144,fullCorpusEncoded:false,baselinePromoted:false}
const path=resolve(`scripts/diag/p141-results/${which}-${slice}-${mode}-${Date.now()}.json`);mkdirSync(dirname(path),{recursive:true})
writeFileSync(path,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'})
const summary=result?Object.fromEntries(Object.entries(result).filter(([k])=>k!=='stages')):undefined
console.log(JSON.stringify({path,status,durationMs:receipt.durationMs,result:summary,error}))
if(status==='FAIL'){console.error(run?.stderr??error);process.exitCode=1}
