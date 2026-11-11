// Pure header tests. Uses existing historical byte strings, never calls a codec.
import {readFileSync,writeFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {inspect} from './inspect-container.mjs'
const checks=[]
for(const file of ['tests/p111-references.json','tests/p111-wordpre-reference.json']){
 const refs=JSON.parse(readFileSync(file,'utf8'))
 for(const [source,r] of Object.entries(refs.references))for(const c of r.containers){
  const b=Buffer.from(c.base64,'base64'),v=inspect(b)
  assert.equal(v.rawBytes,c.inputBytes);assert.equal(v.containerBytes,c.bytes);assert.equal(v.version,c.version);assert.equal(v.containerSha256,c.sha256)
  assert.throws(()=>inspect(b.subarray(0,b.length-1)))
  checks.push({reference:file,source,name:c.name,version:v.version,groups:v.groupCount,headerBytes:v.headerBytes,containerBytes:v.containerBytes,status:'PASS'})
 }
}
// Virtual metadata, not an encoded payload. Explicitly cover 0x2000 width8192
// and v19's uint16 flags without allocating any decoded data.
const vi=n=>{const b=[];do{b.push((n&127)|(n>=128?128:0));n=Math.floor(n/128)}while(n);return b}
const virtual=Buffer.from([85,67,90,19,0,7,...vi(65536),1,1,31,1,...vi(8192|0x8000),1,...vi(65536),0])
const v=inspect(virtual);assert.equal(v.modelFlags,0x700);assert.equal(v.groups[0].r,8192);assert.equal(v.groups[0].v15,true)
const report={kind:'metadata-only-parser-check',compressionExecuted:false,checks,virtualV19:{flags:v.modelFlags,r:v.groups[0].r,v15:v.groups[0].v15,entropyPayloadValidNotTested:true,status:'PASS'}}
writeFileSync('scripts/diag/p12-results/container-inspector-check.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({historicalContainers:checks.length,virtualV19:'PASS',compressionExecuted:false}))
