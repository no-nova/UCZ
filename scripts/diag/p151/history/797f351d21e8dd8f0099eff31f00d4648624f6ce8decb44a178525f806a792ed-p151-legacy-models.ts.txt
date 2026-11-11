import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import historical from './p111-references.json'
import {rawCompatibilityInput} from './p111-inputs'
import {withCMBlockSize,withContainerModel,decodeCM,cmTableShape,modelTuning} from '../src/lib/coder'
const tiny=rawCompatibilityInput(),sha=(d:Uint8Array)=>createHash('sha256').update(d).digest('hex'),rows=[]
const saved={...modelTuning}
try{
 for(const version of [18,19] as const){
  const entries=version===18?historical.references.p10.models:historical.references.p11.models
  if(version===19)Object.assign(modelTuning,{maxTableBits:21,matchTableBits:20})
  for(const g of entries){const payload=Buffer.from(g.base64,'base64');assert.equal(sha(payload),g.sha256)
   const out=withContainerModel(version,g.flags,()=>withCMBlockSize(g.scope,()=>decodeCM(payload,tiny.length,'bin',1,1,undefined,'v15')))
   assert.deepEqual(Buffer.from(out),Buffer.from(tiny));assert.deepEqual(withContainerModel(version,g.flags,()=>withCMBlockSize(g.scope,()=>cmTableShape(tiny.length))),g.geometry)
   rows.push({version,scope:g.scope,flags:g.flags,sha256:g.sha256,roundtrip:true})
  }
 }
}finally{Object.assign(modelTuning,saved)}
console.log(JSON.stringify({rows,inputBytes:tiny.length,source:'independent archived P10/P11 raw CM payloads; not UCZ container fixtures'}))
