import { encodeCMDual, decodeCM } from './src/lib/coder'
import { wordPreInv } from './src/lib/wordpre'
function xs(seed:number){let s=seed>>>0;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s}}
function mk(n:number,seed:number){const r=xs(seed);const a=new Uint8Array(n);for(let i=0;i<n;i++)a[i]=(i%32<28)?(97+(i%26)):(r()&0xff);return a}
function cmp(a:Uint8Array,b:Uint8Array){let bad=0,first=-1;const m=Math.min(a.length,b.length);for(let i=0;i<m;i++)if(a[i]!==b[i]){bad++;if(first<0)first=i}return {bad,first,lenA:a.length,lenB:b.length}}
for (const n of [8192, 65536, 131072]) {
  const d = mk(n, 5150+n)
  const r = encodeCMDual(d, 'bin', 1, 1, 'v15', 0)
  const a = decodeCM(r.alt, n, 'bin', 1, 1, undefined, 0, undefined, 'v15', 0, false)
  const b = decodeCM(r.base, n, 'bin', 1, 1, undefined, 0, undefined, false, 0, false)
  console.log(`v15dual n=${n} alt=${JSON.stringify(cmp(d,a))} base=${JSON.stringify(cmp(d,b))}`)
}
// C-4: evil 14-byte wordPre body
const evil = Uint8Array.from([0x80,0x08,0x01,0x0a,0xff,0xff,0xff,0xff,0x07,0xfb,0xff,0xff,0xff,0x0f])
try { const out = wordPreInv(evil.subarray(0,0), evil, 1024); console.log('wordPreInv evil -> returned', out.length) }
catch(e:any){ console.log('wordPreInv evil -> threw:', String(e.message).slice(0,60)) }
