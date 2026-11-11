// Decision-only: prepared full-group bytes may be read, but every CM call is
// independently hard-capped to 192 KiB by the runner's disposable-source guard.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as codec from '@lib/codec'
import * as coder from '@lib/coder'
const [name,mode]=process.argv.slice(2),dir=`.diag-state/p131-prepared/${name}`
const meta=JSON.parse(readFileSync(`${dir}/meta.json`,'utf8'))
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex')
const raw=readFileSync(`${dir}/raw.bin`),body=readFileSync(`${dir}/body.bin`),header=readFileSync(`${dir}/header.bin`)
assert.equal(sha(raw),meta.rawSha256);assert.equal(sha(body),meta.bodySha256);assert.equal(sha(header),meta.headerSha256)
const parts:Uint8Array[]=[];let p=0
for(const len of meta.lengths){parts.push(raw.subarray(p,p+len));p+=len}assert.equal(p,raw.length)
const start=performance.now()
const decision=(codec as any).p131Decision(raw,{body,header,dict:meta.dict},parts,meta.positions,mode)
const elapsedMs=performance.now()-start,cmCalls=(coder as any).p131CMCalls
assert.ok(cmCalls.length>0&&cmCalls.every((c:any)=>c.bytes<=196608))
const proposed=meta.analysisSegments.map((s:any)=>({...s,spec:{id:s.cls==='fill'?codec.ID.FILL:s.cls==='text'?codec.ID.TEXT_V3:codec.ID.BIN_V3,s:1,r:1}}))
console.log(JSON.stringify({input:{name,file:meta.file,scope:meta.scope,corpusBytes:meta.inputBytes,corpusSha256:meta.inputSha256,
 rawBytes:raw.length,rawSha256:sha(raw),parts:parts.length,bodyBytes:body.length,bodySha256:sha(body),dictionaryBytes:header.length},
 decision,cmCalls,decisionMs:Math.round(elapsedMs),under5Seconds:elapsedMs<5000,
 proposedMacroRule:codec.macroDirectSpec(meta.inputBytes,proposed),
 routingScope:'macro metadata check uses analyze-derived TEXT_V3/BIN_V3 assignments, not unknown user final groups; no macro/family full encode',
 fullCMCalls:0,containerEmitted:false,fullFileBytesMeasured:false}))
