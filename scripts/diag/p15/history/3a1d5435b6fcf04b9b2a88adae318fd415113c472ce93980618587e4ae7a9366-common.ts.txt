import assert from 'node:assert/strict'
import { readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
export const sha=(x:Uint8Array|string)=>createHash('sha256').update(x).digest('hex')
export const eq=(a:Uint8Array,b:Uint8Array)=>assert.deepEqual(Buffer.from(a),Buffer.from(b))
export const ms=(x:number)=>Math.round(x*1000)/1000
export function cat(...xs:Uint8Array[]){const o=new Uint8Array(xs.reduce((n,x)=>n+x.length,0));let p=0;for(const x of xs){o.set(x,p);p+=x.length}return o}
export function varint(n:number){const a:number[]=[];do{a.push((n&127)|(n>=128?128:0));n=Math.floor(n/128)}while(n);return Uint8Array.from(a)}
export function entropy(d:Uint8Array){const h=new Uint32Array(256);for(const b of d)h[b]++;let e=0;for(const n of h)if(n)e-=n/d.length*Math.log2(n/d.length);return e}
export function rng(seed:number){let x=seed>>>0;return ()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return x>>>0}}
export function synthetic(name:string,n:number):Uint8Array {
 const random=rng(0x6e624eb7),o=new Uint8Array(n)
 if(name==='random'||name==='random-holdout'){const r=rng(name==='random'?0x74a2d19b:0x23dc519f);for(let i=0;i<n;i++)o[i]=r()&255;return o}
 if(name==='be16'||name==='le16') {
  // 256 samples/row; separate high/low ranges guarantee lag1 inequality.
  // Horizontal plateaus deliberately exercise the requested lag2 >52% case.
  for(let j=0;j<(n>>1);j++){const x=j%256,y=j>>>8,v=0x8000+(((y>>>3)&31)<<8)+(((x>>>2)+(y&7)*3)&127)
   o[2*j]=name==='be16'?v>>>8:v&255;o[2*j+1]=name==='be16'?v&255:v>>>8}
  if(n&1)o[n-1]=71;return o
 }
 if(name==='colon'||name==='colon-holdout') {
  const words=['record','title','index','compression','sample','chapter','archive','system','number','article','section','entry','data','volume','reference','text']
  const lines:string[]=[];let len=0,at=name==='colon'?0:7000000,k=name==='colon'?0:27183
  while(len<n){const line=`${at}:${(k*7919)%1000003}:${words[(k>>>2)&15]} ${words[random()&15]} ${words[(k>>>6)&15]}\n`;lines.push(line);len+=line.length;at+=line.length+17;k++}
  return new TextEncoder().encode(lines.join('')).subarray(0,n)
 }
 if(name==='glibc-low8') {
  // Additive degree-31 / separation-3 generator, seed 1, glibc-compatible
  // first 10 rand() integers checked below. We retain ONLY each return's low byte.
  const r=new Uint32Array(n+344);r[0]=1
  for(let i=1;i<31;i++)r[i]=(16807*r[i-1])%2147483647
  r[31]=r[0];r[32]=r[1];r[33]=r[2]
  for(let i=34;i<r.length;i++)r[i]=(r[i-31]+r[i-3])>>>0
  const first=[1804289383,846930886,1681692777,1714636915,1957747793,424238335,719885386,1649760492,596516649,1189641421]
  for(let i=0;i<Math.min(n,first.length);i++)assert.equal(r[344+i]>>>1,first[i])
  for(let i=0;i<n;i++)o[i]=(r[344+i]>>>1)&255
  return o
 }
 if(['rec2-plus','rec2-minus','rec2-xor','rec2-adversarial'].includes(name)) {
  const a=3,b=31
  for(let i=0;i<n;i++){
   if(i<b||(name==='rec2-adversarial'&&i>=4096))o[i]=random()&255
   else {const noise=(random()&3)===0?1:0;o[i]=name==='rec2-xor'?(o[i-a]^o[i-b]^noise):(o[i-a]+(name==='rec2-minus'?-o[i-b]:o[i-b])+noise)&255}
  }return o
 }
 throw Error(`unknown synthetic input ${name}`)
}
export function load(name:string,bytes:number,offset=0){
 assert.ok(Number.isSafeInteger(bytes)&&bytes>0&&bytes<=262144&&offset>=0&&offset+bytes<=262144)
 if(name.startsWith('synthetic-')){
  assert.equal(offset,0);const kind=name.slice(10),data=synthetic(kind,bytes)
  return {data,input:{name,kind:'synthetic',generator:kind,generatorSourceSha256:sha(readFileSync('scripts/diag/p15/common.ts')),bytes,offset:0,sha256:sha(data)}}
 }
 const row=JSON.parse(readFileSync('scripts/diag/p14/slices.json','utf8')).samples.find((r:any)=>r.name===name)
 assert.ok(row&&row.bytes<=262144&&offset+bytes<=row.bytes)
 const path=`.diag-data/corpus/${row.file}`;assert.equal(statSync(path).size,row.corpusBytes)
 const parent=new Uint8Array(row.bytes),fd=openSync(path,'r')
 try{assert.equal(readSync(fd,parent,0,parent.length,row.offset),parent.length)}finally{closeSync(fd)}
 assert.equal(sha(parent),row.sha256)
 const data=parent.subarray(offset,offset+bytes)
 return {data,input:{name,kind:'fixed-corpus-window',file:row.file,offset:row.offset+offset,withinParentOffset:offset,bytes,sha256:sha(data),parentWindowBytes:row.bytes,parentWindowSha256:row.sha256}}
}
export function stats(d:Uint8Array){
 let lag1=0,lag2=0,le=0,be=0,count=0
 for(let i=1;i<d.length;i++)if(d[i]===d[i-1])lag1++
 for(let i=2;i<d.length;i++)if(d[i]===d[i-2])lag2++
 for(let i=2;i+1<d.length;i+=2){le+=Math.abs((d[i]|d[i+1]<<8)-(d[i-2]|d[i-1]<<8));be+=Math.abs((d[i]<<8|d[i+1])-(d[i-2]<<8|d[i-1]));count++}
 return {entropy:entropy(d),evenEntropy:entropy(d.filter((_,i)=>!(i&1))),oddEntropy:entropy(d.filter((_,i)=>!!(i&1))),lag1Equal:lag1/Math.max(1,d.length-1),lag2Equal:lag2/Math.max(1,d.length-2),meanAbsLE16Delta:le/Math.max(1,count),meanAbsBE16Delta:be/Math.max(1,count)}
}
export function done(r:any){console.log(JSON.stringify({...r,fullFileMeasured:false,productionSourceModified:false}))}
