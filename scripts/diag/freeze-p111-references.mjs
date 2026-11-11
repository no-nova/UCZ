// Independent historical oracle, not an encode/decode self-test of new code.
// git show reads fixed commits; never switches branch or modifies tracked source.
// Existing output is never overwritten. To reproduce, pass a NEW output path.
import assert from 'node:assert/strict'
import {execFileSync,spawnSync} from 'node:child_process'
import {readFile,writeFile,mkdir,mkdtemp,rm,access} from 'node:fs/promises'
import {join,resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {build} from 'esbuild'
const root=fileURLToPath(new URL('../../',import.meta.url))
const output=resolve(root,process.argv[2]??'tests/p111-references.json')
await access(output).then(()=>{throw Error('Refusing to overwrite historical reference: '+output)},e=>{if(e.code!=='ENOENT')throw e})
const git=(...args)=>execFileSync('git',args,{cwd:root,maxBuffer:8*1024*1024})
const prefix=git('rev-parse','--show-prefix').toString().trim()
const onlyCase=process.argv[3]??null
const refs={p10:'d4bf4d836aec2616b53ee79fc1f628f00ab93bce',p11:'147b778e427fe4b27677d6b9c48b435a0c296e6c'}
await mkdir(join(root,'.diag-state'),{recursive:true})
const scratch=await mkdtemp(join(root,'.diag-state/p111-reference-'))
try {
 const results={kind:'independent-historical-small-references',maxActualInputBytes:49152,references:{}}
 for(const [name,commit] of Object.entries(refs)) {
  if(onlyCase && name!=='p10')continue
  assert.equal(git('rev-parse',commit).toString().trim(),commit)
  const snapshot=join(scratch,name)
  const list=git('ls-tree','--full-tree','-rz',commit,'--',`${prefix}src/lib`).toString().split('\0').filter(Boolean)
  assert.ok(list.length>0,'Historical source tree must not be empty')
  await mkdir(snapshot,{recursive:true})
  const hashes={}
  for(const item of list){
   const [entry,path]=item.split('\t'),[mode,kind,blob]=entry.split(' ')
   assert.equal(mode,'100644');assert.equal(kind,'blob');assert.ok(path.startsWith(`${prefix}src/lib/`))
   const rel=path.slice(prefix.length),bytes=git('cat-file','blob',blob)
   hashes[rel]=createHash('sha256').update(bytes).digest('hex')
   const file=join(snapshot,rel);await mkdir(dirname(file),{recursive:true});await writeFile(file,bytes)
  }
  const rawOutput=join(snapshot,'result.json'),entry=join(snapshot,'freeze.ts'),built=join(snapshot,'freeze.mjs')
  await writeFile(entry,`
import {writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {compressAdaptive,compressGuardedPlanForProbe,decompress} from './src/lib/codec'
import {encodeCM,decodeCM,withCMBlockSize,withContainerModel,cmTableShape} from './src/lib/coder'
import {payloadModelFlags} from './src/lib/payload-model'
import {compatibilityInputs,rawCompatibilityInput} from ${JSON.stringify(join(root,'tests/p111-inputs.ts'))}
const sha=(x:Uint8Array)=>createHash('sha256').update(x).digest('hex')
const containers=[]
${name==='p10'?`for(const c of compatibilityInputs().filter(c=>${onlyCase?`c.name===${JSON.stringify(onlyCase)}`:`c.name!=='guarded-wordpre'`})){
 const result=c.picks?await compressGuardedPlanForProbe(c.data,c.picks,{serial:true}):await compressAdaptive(c.data,undefined,{serial:true})
 if(!Buffer.from(decompress(result.container)).equals(Buffer.from(c.data)))throw Error('Historical roundtrip failed')
 containers.push({name:c.name,inputBytes:c.data.length,inputSha256:sha(c.data),bytes:result.container.length,version:result.container[3],sha256:sha(result.container),base64:Buffer.from(result.container).toString('base64'),orphan:result.orphanComparison??null,macro:result.macroComparison??null})
}`:''}
const raw=rawCompatibilityInput(),models=[]
for(const scope of ${onlyCase?'[]':name==='p10'?'[524288,8388607]':'[8388608]'}){
 const geometry=withCMBlockSize(scope,()=>cmTableShape(raw.length))
 const payload=withCMBlockSize(scope,()=>encodeCM(raw,'bin',1,1,undefined,0,undefined,undefined,'v15'))
 const flags=payloadModelFlags(payload),version=${name==='p10'?18:19}
 const back=withContainerModel(version,flags,()=>withCMBlockSize(scope,()=>decodeCM(payload,raw.length,'bin',1,1,undefined,'v15')))
 if(!Buffer.from(back).equals(Buffer.from(raw)))throw Error('Historical raw-model roundtrip failed')
 models.push({kind:'raw-CM-with-virtual-parent-not-a-UCZ-container',inputBytes:raw.length,inputSha256:sha(raw),scope,geometry,version,flags,bytes:payload.length,sha256:sha(payload),base64:Buffer.from(payload).toString('base64')})
}
writeFileSync(${JSON.stringify(rawOutput)},JSON.stringify({containers,models}))
`)
  await build({entryPoints:[entry],bundle:true,platform:'node',format:'esm',outfile:built,logLevel:'silent'})
  const r=spawnSync(process.execPath,[built],{cwd:root,stdio:'inherit',timeout:90000,env:{...process.env,UCZ_THREADS:'1'}})
  if(r.error)throw r.error
  assert.equal(r.status,0)
  results.references[name]={commit,sourceFiles:hashes,...JSON.parse(await readFile(rawOutput,'utf8'))}
 }
 await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(results,null,2)+'\n',{flag:'wx'})
 console.log('Historical references saved:',output)
 for(const [name,r] of Object.entries(results.references)) console.log(name,JSON.stringify({containers:r.containers.map(c=>({name:c.name,bytes:c.bytes,version:c.version})),rawModels:r.models.map(m=>({scope:m.scope,geometry:m.geometry,flags:m.flags}))}))
} finally {await rm(scratch,{recursive:true,force:true})}
