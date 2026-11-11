// One bounded test per process; run under timeout --signal=KILL 19s.
import {build} from 'esbuild'
import {spawnSync,execFileSync} from 'node:child_process'
import {mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {basename} from 'node:path'
const [test,phase,...args]=process.argv.slice(2)
if(!['p16-bitplane','p16-bitplane-production','p16-bitplane-L','p16-xform','p16-macro','p16-macro-gate','p16-threshold','p16-adaptive','p151-raw','p151-rec2','p151-rec2-gates','p141-core'].includes(test)||!phase||!/^[-\w]+$/.test(phase)||args.some(x=>!/^[-\w]+$/.test(x)))throw Error('run.mjs test phase [args...]')
const dir='scripts/diag/p16-results',path=`${dir}/${test}--${phase}.json`,bundle=`.diag-state/${test}-p16.cjs`
mkdirSync(dir,{recursive:true});mkdirSync('.diag-state',{recursive:true});if(existsSync(path))throw Error('immutable receipt exists')
const sha=x=>createHash('sha256').update(x).digest('hex'),files=Object.fromEntries(readdirSync('src/lib').filter(f=>f.endsWith('.ts')).sort().map(f=>[f,sha(readFileSync(`src/lib/${f}`))]))
mkdirSync('scripts/diag/p16/history',{recursive:true})
for(const f of [...Object.keys(files).map(f=>`src/lib/${f}`),`tests/${test}.ts`]) {const content=readFileSync(f),dest=`scripts/diag/p16/history/${sha(content)}-${basename(f)}.txt`;if(!existsSync(dest))writeFileSync(dest,content,{flag:'wx'})}
const record={test,phase,args,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),node:process.version,sourceFiles:files,sourceSha256:sha(JSON.stringify(files)),testSha256:sha(readFileSync(`tests/${test}.ts`)),status:'FAIL',outerBudgetMs:19000,innerBudgetMs:17000}
const start=performance.now()
try{
 await build({entryPoints:[`tests/${test}.ts`],bundle:true,platform:'node',format:'cjs',outfile:bundle,alias:{'@lib':'./src/lib','@old':'./.diag-state/p151-old/lib'},logLevel:'silent'})
 const child=spawnSync(process.execPath,[bundle,...args],{encoding:'utf8',timeout:Math.max(1,17000-Math.ceil(performance.now()-start)),killSignal:'SIGKILL',maxBuffer:4*1024*1024})
 Object.assign(record,{status:child.status===0&&!child.error?'PASS':'FAIL',exitCode:child.status,signal:child.signal,timedOut:child.error?.code==='ETIMEDOUT',error:child.error?.message??null,stdout:child.stdout,stderr:child.stderr})
 if(record.status==='PASS')record.result=JSON.parse(child.stdout.trim().split('\n').at(-1))
}catch(e){record.error=String(e?.stack??e)}
record.durationMs=Math.round(performance.now()-start);writeFileSync(path,JSON.stringify(record,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({receipt:path,status:record.status,durationMs:record.durationMs,result:record.result,error:record.error}));if(record.status!=='PASS')process.exitCode=1
