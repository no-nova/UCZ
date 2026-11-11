import {openSync,readSync,closeSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {detectRec2} from '../src/lib/rec2'
const names=['xml','dickens','ooffice','mr','osdb','x-ray','sao','reymont','nci','samba','webster','mozilla']
const rows=names.map(name=>{const data=new Uint8Array(16384),f=openSync(`.diag-data/corpus/${name}`,'r');try{if(readSync(f,data,0,data.length,0)!==data.length)throw Error('short read')}finally{closeSync(f)}
 const h=new Uint32Array(256);for(const b of data.subarray(0,2048))h[b]++
 let entropy=0;for(const c of h)if(c){const p=c/2048;entropy-=p*Math.log2(p)}
 const start=performance.now(),detected=detectRec2(data),detectMs=performance.now()-start
 return {name,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),entropy,detected,detectMs}
})
console.log(JSON.stringify({totalReadBytes:rows.reduce((a,r)=>a+r.bytes,0),rows,allRejected:rows.every(r=>r.detected===null)}))
