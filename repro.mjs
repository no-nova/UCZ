import fs from 'node:fs'
const { compressAdaptive, decompress } = await import('./dist/index.js')
function xs(seed){let s=seed>>>0;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s}}
const cands={}
// 4-channel float-ish, stride 4, 300 KB
{const r=xs(1);const a=new Uint8Array(307200);for(let i=0;i<a.length;i++){const k=i&3;a[i]=k===0?(r()&0xff):k===1?((i>>2)&0x3f):k===2?((r()>>3)&0x1f):(i&0x07)} cands.ch4struct=a}
{const r=xs(2);const a=new Uint8Array(262144);for(let i=0;i<a.length;i++){a[i]=((i%4)===0)?(r()&0xff):((i*7)&0xff)} cands.ch4ramp=a}
{const r=xs(3);const a=new Uint8Array(524288);for(let i=0;i<a.length;i++){a[i]=(i%8<6)?((i>>3)&0xff):(r()&0x0f)} cands.ch8=a}
{const r=xs(4);const a=new Uint8Array(196608);for(let i=0;i<a.length;i++){a[i]=(i&3)===0?(r()&0xff):(0x30+(i%10))} cands.ch4text=a}
for (const [name,a] of Object.entries(cands)) {
  const c=(await compressAdaptive(a)).container
  const d=decompress(c); let bad=0,first=-1
  for(let i=0;i<a.length;i++) if(a[i]!==d[i]){bad++; if(first<0)first=i}
  console.log(`${name} raw=${a.length} ucz=${c.length} ver=${c[3]} rt=${bad===0} bad=${bad} first=${first}`)
}
