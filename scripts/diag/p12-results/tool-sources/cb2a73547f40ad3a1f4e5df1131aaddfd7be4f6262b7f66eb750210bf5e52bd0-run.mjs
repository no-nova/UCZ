// One process = one fixed slice + one predeclared variant. End-to-end hard
// budget17.5s (<20s), including build. No loops over corpus files here.
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir,mkdtemp,rm,readdir} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {spawnSync,execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {build} from 'esbuild'
import {coderPatch} from './patches.mjs'
const started=performance.now(),[agent,name,variant,limit]=process.argv.slice(2)
assert.ok(['agent1','agent2','agent3','agent4'].includes(agent))
assert.match(name??'',/^[a-z0-9-]+$/);assert.match(variant??'',/^[a-z0-9-]+$/)
const root=process.cwd(),hash=x=>createHash('sha256').update(x).digest('hex')
const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim()
assert.equal(git('branch','--show-current'),'arena/1220f47e-test')
assert.equal(git('diff','a3b6c3d','--','src/lib'),'','Production source must remain unchanged')
const source={};for(const f of (await readdir('src/lib')).sort())source[f]=hash(await readFile(join('src/lib',f)))
const folder=`scripts/diag/p12-results/${agent}`,resultPath=`${folder}/${name}-${variant}-${limit??'native'}.json`
await mkdir(folder,{recursive:true})
const exists=await readFile(resultPath).then(()=>true,()=>false);assert.ok(!exists,'Refusing to overwrite a probe receipt')
await mkdir('.diag-state/p12',{recursive:true});const scratch=await mkdtemp(resolve('.diag-state/p12/probe-'))
const patches=[],used=['run.mjs','patches.mjs','common.ts',`${agent}.ts`],tools={}
await mkdir('scripts/diag/p12-results/tool-sources',{recursive:true})
for(const f of used){const bytes=await readFile(`scripts/diag/p12/${f}`);tools[f]=hash(bytes);await writeFile(`scripts/diag/p12-results/tool-sources/${tools[f]}-${f}`,bytes)}
try{
 await build({entryPoints:[`scripts/diag/p12/${agent}.ts`],bundle:true,platform:'node',format:'cjs',outfile:join(scratch,'probe.cjs'),logLevel:'silent',plugins:[{name:'isolated-research-only',setup(b){
  b.onLoad({filter:/[/\\]src[/\\]lib[/\\]coder\.ts$/},async a=>{
   const original=await readFile(a.path,'utf8'),contents=agent==='agent1'||agent==='agent4'&&variant==='v2-atomic'?coderPatch(original,variant):original
   patches.push({file:'coder.ts',originalSha256:hash(original),compiledSha256:hash(contents),modified:original!==contents})
   return {contents,loader:'ts'}
  })
 }}]})
 const remain=Math.floor(17500-(performance.now()-started));assert.ok(remain>100)
 const r=spawnSync(process.execPath,[join(scratch,'probe.cjs'),name,variant,...(limit?[limit]:[])],{cwd:root,encoding:'utf8',timeout:remain,killSignal:'SIGKILL',maxBuffer:4*1024*1024,env:{...process.env,UCZ_THREADS:'1'}})
 const wallMs=Math.round(performance.now()-started),passed=r.status===0&&!r.error&&wallMs<20000
 let result=null
 if(passed)result=JSON.parse(r.stdout.trim())
 const record={kind:'P12-bounded-oracle',agent,name,variant,inputLimit:limit?Number(limit):null,command:process.argv.slice(1),commit:git('rev-parse','HEAD'),productionReference:'a3b6c3dd3b69f0ac65b06482313de880a2322a4f',source,tools,patches,wallMs,budgetMs:17500,status:passed?'PASS':r.error?.code==='ETIMEDOUT'?'TIMEOUT':'FAIL',exitCode:r.status,result,...(!passed?{error:String(r.error??r.stderr).slice(0,6000)}:{})}
 assert.equal(git('diff','a3b6c3d','--','src/lib'),'')
 await writeFile(resultPath,JSON.stringify(record,null,2)+'\n',{flag:'wx'})
 console.log(JSON.stringify({path:resultPath,status:record.status,wallMs,result}))
 if(!passed)process.exitCode=1
}finally{await rm(scratch,{recursive:true,force:true})}
