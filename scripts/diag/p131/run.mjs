// node scripts/diag/p131/run.mjs <phase> <xml-main|xml-macro|nci-main> <p12|p13|p13-no-dict|prefix-wrapped|fixed>
// Extracts historical production gate code into a disposable module. Full CM
// calls (>192 KiB) throw BEFORE allocation. Source and injected-code hashes saved.
import { build } from 'esbuild'
import { execFileSync,spawnSync } from 'node:child_process'
import { readFileSync,writeFileSync,readdirSync,mkdirSync,existsSync } from 'node:fs'
import { resolve,join,dirname } from 'node:path'
import { createHash } from 'node:crypto'
const begun=performance.now(),[phase,name,mode]=process.argv.slice(2)
if(![phase,name].every(x=>x&&/^[\w.-]+$/.test(x))||!['p12','p13','p13-no-dict','prefix-wrapped','fixed'].includes(mode))throw Error('phase / input / mode required')
const sha=x=>createHash('sha256').update(x).digest('hex')
const path=`scripts/diag/p131-results/${phase}/${name}-${mode}.json`
if(existsSync(path))throw Error(`Refusing to overwrite ${path}`)
const ref=mode==='p12'?'d9b84df':mode==='fixed'?'HEAD':'51ced1f',working=mode==='fixed'
const commit=execFileSync('git',['rev-parse',ref],{encoding:'utf8'}).trim()
const lib=resolve('.diag-state/p131',`${phase}-${name}-${mode}-${process.pid}`,'lib');mkdirSync(lib,{recursive:true})
const files=working?readdirSync('src/lib').filter(f=>f.endsWith('.ts')).sort():execFileSync('git',['ls-tree','--full-tree','--name-only',`${commit}:universal-adaptive-compression-system/src/lib`],{encoding:'utf8'}).trim().split('\n').filter(f=>f.endsWith('.ts')).sort()
const sourceFiles={}
for(const f of files){const b=working?readFileSync(`src/lib/${f}`):execFileSync('git',['show',`${commit}:universal-adaptive-compression-system/src/lib/${f}`],{maxBuffer:4*1024*1024});sourceFiles[f]=sha(b);writeFileSync(join(lib,f),b)}
const meta=JSON.parse(readFileSync(`.diag-state/p131-prepared/${name}/meta.json`,'utf8'))
for(const [f,h] of Object.entries(meta.sourceFiles))if(sourceFiles[f]!==h)throw Error(`Preparation source mismatch ${f}`)
let code=readFileSync(join(lib,'codec.ts'),'utf8'),injection=''
if(mode==='p12') {
 const a=code.indexOf('function wordPreTry('),b=code.indexOf('\nfunction joinForSpec(',a)
 if(a<0||b<0)throw Error('legacy gate anchors missing')
 let fn=code.slice(a,b),full=fn.indexOf('  const bodyLen =')
 if(full<0)throw Error('legacy full-encode boundary missing')
 // Preserve the actual P12 adoption statements; stop before its full encode.
 fn=fn.slice(0,full)+'  return Uint8Array.of(1)\n}\n'
 fn=fn.replace('  if (wpProbe >= plainProbe * 0.99)',
   "  ;(globalThis as any).__p131Gate={kernel,plainProbe,wpProbe,rawPrefixBytes:probe,tokenPrefixBytes:head.length}\n  if (wpProbe >= plainProbe * 0.99)")
 code=code.slice(0,a)+fn+code.slice(b)
 injection=`\nexport function p131Decision(data:any,pre:any) {\n const trials=['v15','v20'].map((k:any)=>{(globalThis as any).__p131Gate=null;const accepted=!!wordPreTry({data},k,pre);return {...(globalThis as any).__p131Gate,kernel:k,accepted}})\n return {policy:'P12 exact contiguous raw-prefix retokenization, body-only gate',trials,fullCandidateKernels:trials.filter(t=>t.accepted).map(t=>t.kernel)}\n}\n`
} else {
 const a=code.indexOf('        const text=joinForSpec(sampled.parts'),b=code.indexOf('        for(const i of wpSelected)',a)
 let block=mode==='fixed'?'':code.slice(a,b)
 if(mode!=='fixed'&&(a<0||b<0))throw Error('P13 gate anchors missing')
 if(mode==='p13-no-dict')block=block.replace('header:pre.header,body:head','header:new Uint8Array(0),body:head')
 block=block.replace('          return cost<rawCosts[i]*0.99?cost:null',
   '          observations[i]={kernel:k,rawCost:rawCosts[i],wrappedPayloadBytes:p.length,cost,tokenPrefixBytes:head.length,accepted:cost<rawCosts[i]*0.99}; return cost<rawCosts[i]*0.99?cost:null')
 injection=`\nexport function p131Decision(data:any,pre:any,parts:any,positions:any,mode:string) {\n const kernels:GroupKernel[]=['v15','v20'],spec={id:ID.TEXT_V3,s:1,r:1},rawLen=data.length\n const sampled=mode==='prefix-wrapped'?{parts:[data.subarray(0,196608)],positions:[positions[0]],bytes:Math.min(data.length,196608)}:groupKernelSample(parts,positions)\n const priced=(p:Uint8Array,n:number,wp=false)=>p.length+(planTuning.realHeaderCosts?selectionHeaderBytes(spec,n,p.length,payloadModelFlags(p),true,wp):0)\n const rawCosts=kernels.map(k=>withCMProbe(()=>priced(encodeGroupV15(sampled.parts,spec,sampled.positions,k)!,sampled.bytes)))\n const rawSelected=clearProbeWinners(rawCosts),observations:any[]=[]\n ${mode==='fixed'?`const gate=screenWordPreCandidates(data,pre,kernels,rawSelected);return {policy:'P13.1 production helper',rawCosts,rawSelected,gate,fullCandidateKernels:gate.selected.map(i=>kernels[i])}`:block+`\n return {policy:mode,rawCosts,rawSelected,rawSampleBytes:sampled.bytes,trials:observations,wpCosts,wpSelected,fullCandidateKernels:wpSelected.map(i=>kernels[i])}`}\n}\n`
}
code+=injection;writeFileSync(join(lib,'codec.ts'),code)
let coder=readFileSync(join(lib,'coder.ts'),'utf8')
const anchor='  return encodeCMImpl(data, profile, s, r, costOut, costOff, blockCost, onProgress, variant, geomStride, undefined, undefined, wordTokens)'
if(coder.split(anchor).length!==2)throw Error('CM guard anchor is not unique')
coder+='\nexport const p131CMCalls:any[]=[]\n'
coder=coder.replace(anchor,`  if(data.length>196608)throw Error('PROHIBITED full CM input: '+data.length)\n  const started=performance.now()\n  const p=encodeCMImpl(data, profile, s, r, costOut, costOff, blockCost, onProgress, variant, geomStride, undefined, undefined, wordTokens)\n  p131CMCalls.push({bytes:data.length,profile,kernel:variant,wordTokens,payloadBytes:p.length,ms:Math.round(performance.now()-started)})\n  return p`)
writeFileSync(join(lib,'coder.ts'),coder)
const injectedFiles=Object.fromEntries(files.map(f=>[f,sha(readFileSync(join(lib,f)))]))
const entry='scripts/diag/p131/decision.ts',bundle=join(dirname(lib),'decision.cjs')
await build({entryPoints:[entry],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'silent',plugins:[{name:'guarded-source',setup(b){b.onResolve({filter:/^@lib\//},a=>({path:join(lib,a.path.slice(5)+'.ts')}))}}]})
const r=spawnSync(process.execPath,[bundle,name,mode],{encoding:'utf8',timeout:Math.max(1,17500-Math.ceil(performance.now()-begun)),killSignal:'SIGKILL',maxBuffer:2*1024*1024})
const record={phase,name,mode,commit,workingSource:working,sourceFiles,sourceSha256:sha(JSON.stringify(sourceFiles)),injectedFiles,injectedSha256:sha(JSON.stringify(injectedFiles)),
 probeSha256:sha(readFileSync(entry)),runnerSha256:sha(readFileSync('scripts/diag/p131/run.mjs')),bundleSha256:sha(readFileSync(bundle)),preparedMetaSha256:sha(readFileSync(`.diag-state/p131-prepared/${name}/meta.json`)),
 node:process.version,status:r.status===0&&!r.error?'PASS':'FAIL',durationMs:Math.round(performance.now()-begun),stdout:r.stdout,stderr:r.stderr,error:r.error?.message}
if(record.status==='PASS')record.result=JSON.parse(r.stdout.trim())
mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(record,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({path,status:record.status,durationMs:record.durationMs,...record.result,error:record.error}))
if(record.status!=='PASS'){console.error(r.stderr);process.exitCode=1}
