import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {encodeCM as oldEncode,withContainerModel as oldScope,withCMBlockSize as oldBlock} from '@old/coder'
import {decompress} from '../src/lib/codec'
const data=Uint8Array.from({length:4096},(_,i)=>(i*37+(i>>>3))&255),put=(a:number[],n:number)=>{while(n>=128){a.push(n%128|128);n=Math.floor(n/128)}a.push(n)},rows=[]
for(const version of [14,16]){
 const v=version===14?'v13':'v15',payload=oldScope(version,0,()=>oldBlock(data.length,()=>oldEncode(data,'bin',1,1,undefined,0,undefined,undefined,v)))
 const header=[85,67,90,version];for(const n of [data.length,1,1,24,1,version===16?0x8001:1,payload.length,data.length])put(header,n)
 const c=new Uint8Array(header.length+payload.length);c.set(header);c.set(payload,header.length)
 assert.deepEqual(decompress(c),data)
 rows.push({version,bytes:c.length,sha256:createHash('sha256').update(c).digest('hex'),roundtrip:true,source:'18f497d old coder; constructed UCZ header'})
}
console.log(JSON.stringify({inputBytes:data.length,rows}))
