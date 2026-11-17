import fs from 'node:fs'
const { compressAdaptive, decompress } = await import('./dist/index.js')
const { encodeCMContextDual, decodeCM, encodeCMDual } = await import('./dist/index.js').catch(()=>({}))
function xs(seed){let s=seed>>>0;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s}}
// C-1 sample: 98,304 B binary with a 512 B high-entropy window
const r=xs(12345); const a=new Uint8Array(98304)
for(let i=0;i<a.length;i++) a[i]=(i%64<60)? (i%7) : (r()&0xff)
const c=(await compressAdaptive(a)).container
const d=decompress(c)
let bad=0,first=-1
for(let i=0;i<a.length;i++) if(a[i]!==d[i]){bad++; if(first<0) first=i}
console.log('C-1 98K:', 'ucz',c.length,'ver',c[3],'rt',bad===0,'bad',bad,'first',first)
// 512 KiB case
const b=new Uint8Array(524288); const r2=xs(999); for(let i=0;i<b.length;i++) b[i]=(i%256===0)? (r2()&0xff) : (i&0x3f)
const c2=(await compressAdaptive(b)).container; const d2=decompress(c2)
let bad2=0,first2=-1
for(let i=0;i<b.length;i++) if(b[i]!==d2[i]){bad2++; if(first2<0) first2=i}
console.log('C-1 512K:', 'ucz',c2.length,'ver',c2[3],'rt',bad2===0,'bad',bad2,'first',first2)
