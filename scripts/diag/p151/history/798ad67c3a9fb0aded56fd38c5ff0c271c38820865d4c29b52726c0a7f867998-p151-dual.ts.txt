import assert from 'node:assert/strict'
import {encodeCM,decodeCM,encodeCMContextDual,withCMBlockSize,a2Tuning} from '../src/lib/coder'
import {payloadModelFlags} from '../src/lib/payload-model'
const n=Number(process.argv[2]??1024),data=Uint8Array.from({length:n},(_,i)=>(Math.imul(i,71)^(i>>>3)^((i%11)*29))&255)
let cases=0
for(const textOn of [false,true])for(const context of ['bin-stride4','wp-token3','text-sparse5'] as const){
 a2Tuning.textOn=textOn;const profile=context==='bin-stride4'?'bin':'text',words=context==='wp-token3'
 const [base,alt,dual]=withCMBlockSize(n,()=>[encodeCM(data,profile,1,1,undefined,0,undefined,undefined,'v20',0,words),encodeCM(data,profile,1,1,undefined,0,undefined,undefined,'v20',0,words,{context}),encodeCMContextDual(data,context)] as const)
 assert.deepEqual(dual.base,base);assert.deepEqual(dual.alt,alt);assert.equal(payloadModelFlags(dual.base),payloadModelFlags(base));assert.equal(payloadModelFlags(dual.alt),payloadModelFlags(alt))
 assert.deepEqual(withCMBlockSize(n,()=>decodeCM(dual.alt,n,profile,1,1,undefined,'v20',0,words,{context})),data);cases++
}
a2Tuning.textOn=true;console.log(JSON.stringify({n,cases,bothStreamsByteIdentical:true,flagsIdentical:true,roundtrip:true}))
