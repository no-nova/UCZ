// Full-file reading/analysis/tokenization ONLY. No CM import and no encoding.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { analyze } from '../../../src/lib/analyze'
import { wordPreFwdSampled } from '../../../src/lib/wordpre'
const [file,scope]=process.argv.slice(2),start=performance.now()
assert.ok(['xml','nci'].includes(file));assert.ok(['main','macro'].includes(scope))
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex')
const ref=JSON.parse(readFileSync('scripts/diag/baseline.json','utf8')).files.find((r:any)=>r.file===file)
const input=readFileSync(`.diag-data/corpus/${file}`)
assert.equal(input.length,ref.size);assert.equal(sha(input),ref.sha256)
const a0=performance.now(),analysis=analyze(input),analysisMs=performance.now()-a0
const selected=analysis.segs.filter(s=>scope==='main'?s.cls==='text':s.cls!=='fill')
const raw=Buffer.concat(selected.map(s=>input.subarray(s.start,s.end)))
assert.ok(raw.length>192*1024)
const p0=performance.now(),pre=wordPreFwdSampled(raw,256*1024),prepareMs=performance.now()-p0
assert.ok(pre)
const dir=`.diag-state/p131-prepared/${file}-${scope}`,metaPath=`${dir}/meta.json`
assert.ok(!existsSync(metaPath),'immutable preparation already exists')
mkdirSync(dir,{recursive:true})
writeFileSync(`${dir}/raw.bin`,raw);writeFileSync(`${dir}/body.bin`,pre.body);writeFileSync(`${dir}/header.bin`,pre.header)
const meta={file,scope,inputBytes:input.length,inputSha256:ref.sha256,
 selection:scope==='main'?'all analyze() text segments, proposed TEXT_V3 group; not a replay of final adaptive assignments':'all analyze() non-FILL segments, direct macro TEXT_V3 hypothesis; not a full container',
 analysisSegments:analysis.segs.map(s=>({start:s.start,end:s.end,cls:s.cls})),
 positions:selected.map(s=>s.start),lengths:selected.map(s=>s.end-s.start),rawBytes:raw.length,rawSha256:sha(raw),
 bodyBytes:pre.body.length,bodySha256:sha(pre.body),dictionaryBytes:pre.header.length,headerSha256:sha(pre.header),dict:pre.dict,
 collapse:pre.body.length/raw.length,analysisMs:Math.round(analysisMs),prepareMs:Math.round(prepareMs),totalMs:Math.round(performance.now()-start),
 sourceFiles:Object.fromEntries(['analyze.ts','wordpre.ts'].map(f=>[f,sha(readFileSync(`src/lib/${f}`))])),cmCalls:0}
writeFileSync(metaPath,JSON.stringify(meta,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify(meta))
