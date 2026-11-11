// node scripts/diag/p131/prepare.mjs <xml|nci> <main|macro> [receipt-phase]
// Separately timed, full-file read/analyze/tokenization. NO CM encoding.
import { build } from 'esbuild'
import { spawnSync,execFileSync } from 'node:child_process'
import { readFileSync,writeFileSync,mkdirSync,existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
const begun=performance.now(),[file,scope,phase="preparation"]=process.argv.slice(2),sha=x=>createHash('sha256').update(x).digest('hex')
if(!['xml','nci'].includes(file)||!['main','macro'].includes(scope)||!phase||!/^[\w.-]+$/.test(phase))throw Error('file / scope required')
const path=`scripts/diag/p131-results/${phase}/${file}-${scope}.json`
if(existsSync(path))throw Error(`Refusing to overwrite ${path}`)
mkdirSync('.diag-state/p131',{recursive:true});mkdirSync(`scripts/diag/p131-results/${phase}`,{recursive:true})
const bundle=`.diag-state/p131/prepare-${process.pid}.cjs`,entry='scripts/diag/p131/prepare.ts'
await build({entryPoints:[entry],bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'silent'})
const r=spawnSync(process.execPath,[bundle,file,scope],{encoding:'utf8',timeout:Math.max(1,17500-Math.ceil(performance.now()-begun)),killSignal:'SIGKILL',maxBuffer:2*1024*1024})
const record={commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),file,scope,node:process.version,
 probeSha256:sha(readFileSync(entry)),runnerSha256:sha(readFileSync('scripts/diag/p131/prepare.mjs')),bundleSha256:sha(readFileSync(bundle)),
 status:r.status===0&&!r.error?'PASS':'FAIL',durationMs:Math.round(performance.now()-begun),stdout:r.stdout,stderr:r.stderr,error:r.error?.message}
if(record.status==='PASS')record.result=JSON.parse(r.stdout.trim())
writeFileSync(path,JSON.stringify(record,null,2)+'\n',{flag:'wx'})
const x=record.result
console.log(JSON.stringify({path,status:record.status,durationMs:record.durationMs,rawBytes:x?.rawBytes,bodyBytes:x?.bodyBytes,dictionaryBytes:x?.dictionaryBytes,
 analysisMs:x?.analysisMs,prepareMs:x?.prepareMs,segments:x?.analysisSegments,cmCalls:0,error:record.error}))
if(record.status!=='PASS'){console.error(r.stderr);process.exitCode=1}
