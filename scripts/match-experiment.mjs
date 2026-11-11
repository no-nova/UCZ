// Isolated-process, deterministic research measurements; no UCZ format changes.
// node scripts/match-experiment.mjs [output.json]
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const cases=['repeated-text','branching-text','records','random','changing']
const modes=['single','dual','dual-distance']
function sample(name) {
  const text=s=>new TextEncoder().encode(s)
  let state=0x3ab81529;const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0}
  if(name==='repeated-text')return {profile:'text',data:text('The compression algorithm models recurring patterns.\n'.repeat(500))}
  if(name==='branching-text'){let s='';for(let i=0;i<800;i++)s+=`unique-${i%23}-abcdefghij${i%3===0?'ONE':'TWO'}-end; `;return {profile:'text',data:text(s)}}
  if(name==='records')return {profile:'bin',data:Uint8Array.from({length:28*1100},(_,i)=>i%28<12?i%28*3:(Math.floor(i/28)+i%28)&255)}
  if(name==='random')return {profile:'bin',data:Uint8Array.from({length:24000},()=>random()&255)}
  if(name==='changing')return {profile:'bin',data:Uint8Array.from({length:30000},(_,i)=>i<10000?i%7:i<20000?random()&255:(i%40<20?0:(i*17)&255))}
  throw Error('unknown sample')
}
if(process.argv[2]==='--worker') {
  const [file,name,mode]=process.argv.slice(3), codec=createRequire(import.meta.url)(file)
  const {data,profile}=sample(name), costs=new Float32Array(data.length),bins=new Float32Array(Math.ceil(data.length/512))
  globalThis.gc?.();const memBefore=process.memoryUsage().rss,peakBefore=process.resourceUsage().maxRSS
  let t=performance.now();const {payload,stats}=codec.encodeMatchExperiment(data,profile,mode,costs,{values:bins,blockSize:512}),encodeMs=performance.now()-t
  const rssAfterEncode=process.memoryUsage().rss,peakAfterEncode=process.resourceUsage().maxRSS
  t=performance.now();const decoded=codec.decodeMatchExperiment(payload,data.length,profile,mode),decodeMs=performance.now()-t
  assert.deepEqual(decoded,data)
  const repeat=codec.encodeMatchExperiment(data,profile,mode);assert.deepEqual(repeat.payload,payload)
  if(mode==='single') assert.deepEqual(payload,codec.encodeCM(data,profile,1,1,undefined,0,undefined,undefined,'v13'))
  const result={sample:name,profile,mode,inputBytes:data.length,inputSha256:createHash('sha256').update(data).digest('hex'),payloadBytes:payload.length,predictionBits:costs.reduce((a,b)=>a+b,0),blockBits:Array.from(bins),encodeMs,decodeMs,rssBeforeBytes:memBefore,rssAfterEncodeBytes:rssAfterEncode,processMaxRssBeforeKiB:peakBefore,processMaxRssAfterEncodeKiB:peakAfterEncode,processMaxRssAfterDecodeKiB:process.resourceUsage().maxRSS,stats,matchBitAccuracy:stats.predictedBits?stats.correctBits/stats.predictedBits:null}
  console.log(JSON.stringify(result))
} else {
  const dir=await mkdtemp(join(tmpdir(),'ucz-match-'))
  try {
    const codec=join(dir,'coder.cjs');await build({entryPoints:['src/lib/coder.ts'],bundle:true,platform:'node',format:'cjs',outfile:codec,logLevel:'silent'})
    const results=[]
    for(const name of cases)for(const mode of modes) {
      const child=spawnSync(process.execPath,['--expose-gc',resolve('scripts/match-experiment.mjs'),'--worker',codec,name,mode],{encoding:'utf8',maxBuffer:10*1024*1024})
      if(child.status!==0)throw Error(child.stderr||`worker exited ${child.status}`)
      const row=JSON.parse(child.stdout);results.push(row)
      console.log(`${name.padEnd(14)} ${mode.padEnd(13)} payload=${String(row.payloadBytes).padStart(5)} cost=${row.predictionBits.toFixed(1).padStart(9)} bits enc=${row.encodeMs.toFixed(1)} ms dec=${row.decodeMs.toFixed(1)} ms match=${row.matchBitAccuracy===null?'n/a':(100*row.matchBitAccuracy).toFixed(2)+'%'} olderWins=${row.stats.olderWins}`)
    }
    if(process.argv[2])await writeFile(process.argv[2],JSON.stringify({node:process.version,note:'Single run per case in fresh subprocess; RSS is process-wide, timing is illustrative.',results},null,2)+'\n')
  } finally {await rm(dir,{recursive:true,force:true})}
}
