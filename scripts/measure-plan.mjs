// A single illustrative synchronous evaluation; not a benchmark or a limit.
// Run from the project directory with: node --expose-gc scripts/measure-plan.mjs
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const dir=await mkdtemp(join(tmpdir(),'ucz-eval-'))
try {
  const file=join(dir,'codec.cjs')
  await build({entryPoints:['src/lib/codec.ts'],bundle:true,platform:'node',format:'cjs',outfile:file,logLevel:'silent'})
  const {evaluatePlan,ID}=createRequire(import.meta.url)(file)
  const data=Uint8Array.from({length:128*1024},(_,i)=>(i*7+(i>>>10))&255)
  const picks=[{start:0,end:data.length,cls:'smooth',spec:{id:ID.DELTA_V3,s:2,r:1}}]
  globalThis.gc?.()
  const before=process.memoryUsage(),peakBefore=process.resourceUsage().maxRSS,t=performance.now()
  const result=evaluatePlan(data,picks),elapsed=performance.now()-t
  const after=process.memoryUsage(),peakAfter=process.resourceUsage().maxRSS
  console.log(JSON.stringify({node:process.version,inputBytes:data.length,spec:'DELTA_V3 s=2 r=1',elapsedMs:Math.round(elapsed),rssBefore:before.rss,rssAfter:after.rss,maxRssBeforeKiB:peakBefore,maxRssAfterKiB:peakAfter,heapUsedBefore:before.heapUsed,heapUsedAfter:after.heapUsed,result},null,2))
} finally {await rm(dir,{recursive:true,force:true})}
