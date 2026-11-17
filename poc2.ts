import { encodeCMContextDual, decodeCM, encodeCMDual } from './src/lib/coder'
function xs(seed:number){let s=seed>>>0;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s}}
function mk(n:number,seed:number){const r=xs(seed);const a=new Uint8Array(n);for(let i=0;i<n;i++)a[i]=(i%64<60)?(i%7):(r()&0xff);return a}
function cmp(a:Uint8Array,b:Uint8Array){let bad=0,first=-1;const m=Math.min(a.length,b.length);for(let i=0;i<m;i++)if(a[i]!==b[i]){bad++;if(first<0)first=i}return {bad,first}}
for (const n of [65536, 524288]) {
  const d = mk(n, 777+n)
  const r = encodeCMContextDual(d, 'bin-stride4')
  const alt = decodeCM(r.alt, n, 'bin', 1, 1, undefined, 0, undefined, 'v20', 0, false, { context: 'bin-stride4' })
  const base = decodeCM(r.base, n, 'bin', 1, 1, undefined, 0, undefined, 'v20', 0, false)
  console.log(`dual ctx n=${n} baseLen=${r.base.length} altLen=${r.alt.length} altBad=${JSON.stringify(cmp(d,alt))} baseBad=${JSON.stringify(cmp(d,base))}`)
}
for (const n of [65536]) {
  const d = mk(n, 4242)
  const r = encodeCMDual(d, 'bin', 1, 1, 'v20', 0)
  const b = decodeCM(r.base, n, 'bin', 1, 1, undefined, 0, undefined, false, 0, false)
  const a = decodeCM(r.alt, n, 'bin', 1, 1, undefined, 0, undefined, 'v20', 0, false)
  console.log(`encodeCMDual v20 n=${n} baseBad=${JSON.stringify(cmp(d,b))} altBad=${JSON.stringify(cmp(d,a))}`)
}
