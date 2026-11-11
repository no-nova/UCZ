import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
export const sha=(x:Uint8Array|string)=>createHash('sha256').update(x).digest('hex')
export function input(){
 const [name,variant,limitArg]=process.argv.slice(2)
 const catalog=JSON.parse(readFileSync('scripts/diag/p12-results/slices.json','utf8'))
 const meta=catalog.samples.find((x:any)=>x.name===name);assert.ok(meta,'Unknown fixed slice')
 const all=readFileSync(meta.path);assert.equal(sha(all),meta.sha256)
 const n=limitArg?Number(limitArg):all.length;assert.ok(Number.isSafeInteger(n)&&n>=65536&&n<=262144&&n<=all.length)
 const data=new Uint8Array(all.subarray(0,n))
 return {name,variant,data,meta:{...meta,path:undefined,bytes:n,sha256:sha(data),parentSliceSha256:meta.sha256}}
}
export const same=(a:Uint8Array,b:Uint8Array)=>{assert.equal(a.length,b.length);assert.equal(sha(a),sha(b),'Roundtrip/input mismatch')}
export function varint(n:number){const r:number[]=[];do{const b=n&127;n=Math.floor(n/128);r.push(b|(n?128:0))}while(n);return r}
export function cat(parts:Uint8Array[]){const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let o=0;for(const p of parts){out.set(p,o);o+=p.length}return out}
export function entropy(d:Uint8Array){const h=new Uint32Array(256);for(const b of d)h[b]++;let e=0;for(const n of h)if(n){const p=n/d.length;e-=p*Math.log2(p)}return e}
export function done(data:Record<string,unknown>){console.log(JSON.stringify({...data,maxRSSMiB:process.resourceUsage().maxRSS/1024}))}
