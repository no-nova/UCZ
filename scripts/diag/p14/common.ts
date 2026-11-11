import assert from 'node:assert/strict'
import { readFileSync,openSync,readSync,closeSync } from 'node:fs'
import { createHash } from 'node:crypto'
export const sha=(x:Uint8Array|string)=>createHash('sha256').update(x).digest('hex')
export const eq=(a:Uint8Array,b:Uint8Array)=>assert.deepEqual(Buffer.from(a),Buffer.from(b))
export function load(name:string) {
 const entry=JSON.parse(readFileSync('scripts/diag/p14/slices.json','utf8')).samples.find((s:any)=>s.name===name)
 assert.ok(entry&&entry.bytes>0&&entry.bytes<=262144)
 const data=new Uint8Array(entry.bytes),fd=openSync(`.diag-data/corpus/${entry.file}`,'r')
 try {assert.equal(readSync(fd,data,0,data.length,entry.offset),data.length)}finally{closeSync(fd)}
 assert.equal(sha(data),entry.sha256)
 return {entry,data}
}
export function varint(n:number) {const a:number[]=[];while(n>=128){a.push((n&127)|128);n>>>=7}a.push(n);return Uint8Array.from(a)}
export function concat(...xs:Uint8Array[]) {const out=new Uint8Array(xs.reduce((n,x)=>n+x.length,0));let p=0;for(const x of xs){out.set(x,p);p+=x.length}return out}
export function done(result:any) {console.log(JSON.stringify({...result,fullFileMeasured:false,productionContainerEmitted:false}))}
export function entropy(data:Uint8Array) {const h=new Uint32Array(256);for(const x of data)h[x]++;let b=0;for(const n of h)if(n)b-=n/data.length*Math.log2(n/data.length);return b}
