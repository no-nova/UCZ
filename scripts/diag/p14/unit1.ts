// Unit 1: real v20 text CM of current v1 dictionary+body; no synthetic v2 token format.
import assert from 'node:assert/strict'
import { readFileSync,writeFileSync,mkdirSync,existsSync } from 'node:fs'
import { encodeCM,decodeCM,withCMBlockSize } from '@lib/coder'
import { wordPreFwdSampled,wordPreInv } from '@lib/wordpre'
import { load,eq,sha,concat,done } from './common'
const [name,variant]=process.argv.slice(2),{entry,data}=load(name),start=performance.now()
const raw=variant==='raw'||variant==='text-class'
const sourceSha=sha(readFileSync('src/lib/wordpre.ts')),cache=`.diag-state/p14-wordpre/${sourceSha}-${entry.sha256}.json`
let cacheHit=false,pre:ReturnType<typeof wordPreFwdSampled>=null
if(!raw) {
 if(existsSync(cache)) {
  const c=JSON.parse(readFileSync(cache,'utf8'));assert.equal(c.sourceSha,sourceSha);assert.equal(c.inputSha,entry.sha256)
  pre={dict:c.dict,header:new Uint8Array(Buffer.from(c.header,'base64')),body:new Uint8Array(Buffer.from(c.body,'base64'))}
  assert.equal(sha(concat(pre.header,pre.body)),c.transformedSha);cacheHit=true
 }else {
  pre=wordPreFwdSampled(data,262144);assert.ok(pre)
  mkdirSync('.diag-state/p14-wordpre',{recursive:true})
  writeFileSync(cache,JSON.stringify({sourceSha,inputSha:entry.sha256,dict:pre.dict,header:Buffer.from(pre.header).toString('base64'),body:Buffer.from(pre.body).toString('base64'),transformedSha:sha(concat(pre.header,pre.body))}),{flag:'wx'})
 }
}
assert.ok(raw||pre)
let tokenHits=0,escapedLiterals=0,adjacentTokenPairs=0,prevToken=false,leadingSpaceHits=0,multiwordHits=0
if(pre) {
 eq(wordPreInv(pre.header,pre.body,data.length),data)
 for(let i=0;i<pre.body.length;i++) {
  const b=pre.body[i]
  if(b===127){escapedLiterals++;i++;prevToken=false;continue}
  if(b>=128){assert.ok(b-128<pre.dict.length);tokenHits++;if(prevToken)adjacentTokenPairs++;prevToken=true
   const w=pre.dict[b-128];if(w.startsWith(' '))leadingSpaceHits++;if(/[a-zA-Z].*\s+.*[a-zA-Z]/.test(w))multiwordHits++
  }else prevToken=false
 }
}
const input=pre?concat(pre.header,pre.body):data,prepMs=performance.now()-start
const t=performance.now(),payload=withCMBlockSize(data.length,()=>encodeCM(input,'text',1,1,undefined,0,undefined,undefined,'v20',0,!!pre)),encodeMs=performance.now()-t
const d=performance.now(),out=withCMBlockSize(data.length,()=>decodeCM(payload,input.length,'text',1,1,undefined,'v20',0,!!pre))
eq(out,input);if(pre)eq(wordPreInv(out.subarray(0,pre.header.length),out.subarray(pre.header.length),data.length),data)
done({unit:1,input:entry,variant,profile:'text',kernel:'v20',cmInputBytes:input.length,cmInputSha256:sha(input),
 dictionaryBytes:pre?.header.length??0,dictionaryEntries:pre?.dict.length??0,dictionarySha256:pre?sha(pre.header):null,
 tokenBodyBytes:pre?.body.length??0,tokenHits,escapedLiterals,adjacentTokenPairs,leadingSpaceHits,multiwordHits,
 dictionaryIsJointlyCMEncoded:!!pre,tokenWireFormat:pre?'v1: 0x80..0xF7, 0x7F escape, no casing prefix':null,
 payloadBytes:payload.length,wordPreLengthPrefixBytes:pre?4:0,wrappedPayloadBytes:payload.length+(pre?4:0),payloadSha256:sha(payload),roundtrip:true,
 productionCompatible:['control','raw'].includes(variant),dictionaryCacheHit:cacheHit,prepMs:Math.round(prepMs),encodeMs:Math.round(encodeMs),decodeMs:Math.round(performance.now()-d),
 scope:'fixed 256KiB window, local dictionary, raw CM payload (plus separately reported 4B WORD-PRE length); not complete container, not full-file adoption'})
