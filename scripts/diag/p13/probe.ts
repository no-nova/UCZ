// One fixed <=512KiB window per process. Not a full-file adaptive benchmark.
import assert from 'node:assert/strict'
import { readFileSync, openSync, readSync, closeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as codec from '@lib/codec'
import { payloadModelFlags } from '@lib/payload-model'
const [name,which]=process.argv.slice(2)
const manifests=['scripts/diag/p12-results/slices.json','scripts/diag/p12-impl/slices.json']
const entry=manifests.flatMap(p=>JSON.parse(readFileSync(p,'utf8')).samples).find((s:any)=>s.name===name)
assert.ok(entry);assert.ok(entry.bytes>0&&entry.bytes<=512*1024)
const data=new Uint8Array(entry.bytes),fd=openSync(`.diag-data/corpus/${entry.file}`,'r')
try{assert.equal(readSync(fd,data,0,data.length,entry.offset),data.length)}finally{closeSync(fd)}
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex')
assert.equal(sha(data),entry.sha256)
const {ID,encodeTerrainGroup,groupV15CandidatesSync,planHeader,decompress}=codec
const [kind,mode]=which.split('-')
const spec={id:kind.startsWith('bcj')?ID.BCJ_V3:kind.startsWith('wide')?ID.WIDE_GRAD:kind.startsWith('tg')?ID.TRANSPOSE_GROUP_V3:kind==='text'?ID.TEXT_V3:ID.BIN_V3,
 s:kind.startsWith('bcj')?Number(kind.slice(3)):kind.startsWith('wide')?Number(kind.slice(4)):kind.startsWith('tg')?Number(kind.slice(2)):1,
 r:kind.startsWith('wide')?(entry.file==='mr'?1024:3800):1}
const parts=[data],positions=[0],frames:any[]=[]
function add(payload:Uint8Array|null|undefined,apm:boolean,wp=false,rule=spec,label='base') {
 if(!payload)return
 const segs=[{start:0,end:data.length,cls:'binary',spec:rule}]
 const header=Uint8Array.from(planHeader(data.length,segs,[{spec:rule,members:[0],payload,v15:apm,wordPre:wp}]))
 const c=new Uint8Array(header.length+payload.length);c.set(header);c.set(payload,header.length)
 frames.push({payload,c,rule,label,apm,wp,headerBytes:header.length,flags:payloadModelFlags(payload)})
}
const start=performance.now()
let candidates:any=null
if(mode==='v15'||mode==='v20')add(encodeTerrainGroup(parts,spec,undefined,undefined,undefined,positions,mode),true,false,spec,mode)
else {
 if(mode==='oracle')(codec.planTuning as any).groupKernelScreen=false
 add(encodeTerrainGroup(parts,spec,undefined,undefined,undefined,positions),false)
 candidates=groupV15CandidatesSync(parts,spec,positions)
 add(candidates?.alt,true,false,spec,'v15');add(candidates?.v20,true,false,spec,'v20')
 add(candidates?.wordPre,true,true,spec,'wordpre-v15');add(candidates?.wordPreV20,true,true,spec,'wordpre-v20')
 for(const v of candidates?.variants??[])add(v.payload,true,false,v.spec,`bcj2-${v.kernel}`)
}
const encodeMs=performance.now()-start
for(const f of frames)assert.deepEqual(Buffer.from(decompress(f.c)),Buffer.from(data))
frames.sort((a,b)=>a.c.length-b.c.length)
console.log(JSON.stringify({input:entry,spec,positions,scope:'fixed-window forced group, reset origin 0; complete UCZ roundtrip, not full-file adaptive routing',
 bytes:frames[0].c.length,headerBytes:frames[0].headerBytes,version:frames[0].c[3],flags:frames[0].flags,selected:frames[0].label,
 containerSha256:sha(frames[0].c),roundtrip:true,containerRoundtrip:true,
 candidates:frames.map(f=>({label:f.label,spec:f.rule,bytes:f.c.length,flags:f.flags})),screening:candidates?.screening??[],
 encodeMs:Math.round(encodeMs),decodeMs:Math.round(performance.now()-start-encodeMs)}))
