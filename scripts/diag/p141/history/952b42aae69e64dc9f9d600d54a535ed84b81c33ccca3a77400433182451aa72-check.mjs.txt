// One check per command. Always wrap the invocation in timeout --signal=KILL 19s.
// Kill the complete child process group, including npm's grandchildren, at 17s.
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'
const commands={
 worker:['npm',['run','check:worker']],
 types:['npx',['tsc','--noEmit']],
 'diag-types':['npx',['tsc','--noEmit','-p','tsconfig.p141.json']],
 build:['npm',['run','build']],
 ui:['npm',['run','test:ui']],
 metadata:['node',['--test','tests/p10-baseline.test.mjs','tests/p122-diagnostics.test.mjs','tests/p13-diagnostics.test.mjs']],
 legacy:['node',['tests/run-p12.mjs','history']],
 'p131-gate':['node',['tests/run-p131.mjs','gate']],
 'p131-worker':['node',['tests/run-p131.mjs','worker']],
}
const name=process.argv[2],command=commands[name]
if(!command)throw Error(`Choose one: ${Object.keys(commands).join(' / ')}`)
const start=performance.now(),sha=x=>createHash('sha256').update(x).digest('hex')
const sourceFiles=Object.fromEntries(readdirSync('src/lib').filter(f=>f.endsWith('.ts')).sort().map(f=>[f,sha(readFileSync(`src/lib/${f}`))]))
const sourceSha256=sha(JSON.stringify(sourceFiles)),history='scripts/diag/p141/history'
mkdirSync(history,{recursive:true})
const scripts={}
for(const path of ['scripts/diag/p141/check.mjs','package.json','tsconfig.json','tsconfig.p141.json']) {
 const content=readFileSync(path),hash=sha(content),dest=`${history}/${hash}-${basename(path)}.txt`
 if(existsSync(dest)){if(sha(readFileSync(dest))!==hash)throw Error('history SHA mismatch')}
 else writeFileSync(dest,content,{flag:'wx'})
 scripts[path]=hash
}
let stdout='',stderr='',timedOut=false,error
const child=spawn(command[0],command[1],{stdio:['ignore','pipe','pipe'],detached:true,env:{...process.env,UCZ_THREADS:'1'}})
child.stdout.on('data',b=>{if(stdout.length<2*1024*1024)stdout+=b})
child.stderr.on('data',b=>{if(stderr.length<2*1024*1024)stderr+=b})
const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGKILL')}catch{}},Math.max(1,17000-Math.ceil(performance.now()-start)))
const outcome=await new Promise(resolve=>{
 child.once('error',e=>{error=e.message;resolve({code:null,signal:null})})
 child.once('close',(code,signal)=>resolve({code,signal}))
})
clearTimeout(timer)
const record={kind:'P14.1-bounded-project-check',name,status:outcome.code===0&&!timedOut&&!error?'PASS':'FAIL',command,
 commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceSha256,sourceFiles,scripts,node:process.version,
 durationMs:Math.round(performance.now()-start),...outcome,timedOut,error,stdout,stderr,fullCorpusEncoded:false,baselinePromoted:false}
const dir='scripts/diag/p141-results/checks';mkdirSync(dir,{recursive:true})
const path=resolve(`${dir}/${name}-${Date.now()}.json`);writeFileSync(path,JSON.stringify(record,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({path,name,status:record.status,durationMs:record.durationMs,stdout,stderr,error}))
if(record.status==='FAIL')process.exitCode=1
