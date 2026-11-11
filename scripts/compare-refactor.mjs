// Reproduce the byte-for-byte regression against the pre-refactor local commit.
// No network or corpus is required: node scripts/compare-refactor.mjs
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const root=resolve('.'), temp=await mkdtemp(join(tmpdir(),'ucz-refactor-'))
const require=createRequire(import.meta.url)
try {
  const archive=execFileSync('git',['archive','57b41aa','universal-adaptive-compression-system/src/lib'],{cwd:resolve(root,'..')})
  execFileSync('tar',['-x','-C',temp],{input:archive})
  const previous=join(temp,'universal-adaptive-compression-system/src/lib/codec.ts')
  for(const [entry,out] of [[previous,'old'],[join(root,'src/lib/codec.ts'),'new']])
    await build({entryPoints:[entry],bundle:true,platform:'node',format:'cjs',outfile:join(temp,out+'.cjs'),logLevel:'silent'})
  const old=require(join(temp,'old.cjs')), now=require(join(temp,'new.cjs')), ID=now.ID
  let state=924123; const rand=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0}
  const text=new TextEncoder().encode('A deterministic text record: hello world, 2026.\n'.repeat(320))
  const noise=Uint8Array.from({length:8000},()=>rand()&255)
  const mixed=Buffer.concat([text,noise,text])
  const records=Uint8Array.from({length:28*1200},(_,i)=>i%28<14?i%28*3:(Math.floor(i/28)+i%28)&255)
  const executable=Uint8Array.from({length:16000},(_,i)=>i%16===0?0xe8:i%16===1?(255-i/16)&255:i%16<5?255:(i*17)&255)
  const image=Uint8Array.from({length:28*600},(_,i)=>(Math.floor(i/28)*7+(i%28<14?0:i%28))&255)
  const wide=Uint8Array.from({length:512*32},(_,i)=>i%2===0?(Math.floor(i/2)%256):((Math.floor(i/1024)+Math.floor(i/2)%37)&255))
  const fill=Buffer.concat([new Uint8Array(4096).fill(3),noise,new Uint8Array(4096).fill(9)])
  const anchor=new TextEncoder().encode('name:example,value:sample,number:42\n'.repeat(380))
  const samples={text,noise,mixed,records,executable,image,wide,fill,anchor}
  const hash=x=>createHash('sha256').update(x).digest('hex')
  for(const [name,data] of Object.entries(samples)) {
    const a=await old.compressAdaptive(data),b=await now.compressAdaptive(data)
    assert.deepEqual(b.container,a.container,name)
    assert.deepEqual(now.decompress(b.container),new Uint8Array(data),name+' round trip')
    console.log(`adaptive ${name} bytes=${b.container.length} ids=${b.segs.map(s=>s.spec.id).join(',')} sha256=${hash(b.container)}`)
  }
  // Forced valid UCZ plans cover branches that selection on these samples may
  // not naturally choose. Recreate the same complete one-group container with
  // each revision's encoder and the existing automatic transpose comparison.
  const put=v=>{const a=[];while(v>=128){a.push((v%128)|128);v=Math.floor(v/128)}a.push(v);return a}
  function container(codec,data,spec) {
    let selected=spec, payload=spec.id===ID.FILL?Uint8Array.of(data[0]):codec.encodeTerrainGroup([data],spec,undefined,undefined,undefined,[0])
    if(spec.id===ID.TRANSPOSE_GROUP) {
      const geom=codec.encodeTerrainGroup([data],{id:ID.TRANSPOSE_2D,s:spec.s,r:1})
      const enhanced=codec.encodeTerrainGroup([data],{id:ID.TRANSPOSE_GROUP_V3,s:spec.s,r:1})
      if(enhanced.length<Math.min(geom.length,geom[0]===0?geom.length-1:Infinity)){selected={...spec,id:ID.TRANSPOSE_GROUP_V3};payload=enhanced}
      else if(geom[0]===1){selected={...spec,id:ID.TRANSPOSE_2D};payload=geom}
    }
    const id=selected.id,version=id===ID.WIDE_GRAD?14:id>=ID.TEXT_V3?13:id>=ID.TEXT_V2?12:id===ID.MICRO?11:id===ID.SUB_TRANSPOSE||id===ID.SUB_ANCHOR?10:id===ID.PEEL?9:id===ID.ANCHOR_FOLD?8:7
    return Uint8Array.from([85,67,90,version,...put(data.length),1,1,...put(id),...put(selected.s),...put(selected.r),...put(payload.length),...put(data.length),...payload])
  }
  const forced=[['BCJ',executable,{id:ID.BCJ_V3,s:1,r:1}],['TRANSPOSE_2D',image,{id:ID.TRANSPOSE_2D,s:28,r:1}],['TRANSPOSE_GROUP_V3',image,{id:ID.TRANSPOSE_GROUP_V3,s:28,r:1}],['TRANSPOSE_GROUP_AUTO',image,{id:ID.TRANSPOSE_GROUP,s:28,r:1}],['WIDE_D16',wide,{id:ID.WIDE_GRAD,s:1,r:512}],['WIDE_MED',wide,{id:ID.WIDE_GRAD,s:2,r:512}],['FILL',new Uint8Array(2048).fill(3),{id:ID.FILL,s:1,r:1}],['PEEL',records.subarray(0,2048),{id:ID.PEEL,s:28,r:1}],['MICRO',wide.subarray(0,4096),{id:ID.MICRO,s:2,r:512}],['ANCHOR',anchor.subarray(0,4096),{id:ID.ANCHOR,s:11,r:1}]]
  for(const [name,data,spec] of forced) {
    const a=container(old,data,spec),b=container(now,data,spec)
    assert.deepEqual(b,a,name);assert.deepEqual(now.decompress(b),new Uint8Array(data),name+' round trip')
    assert.equal(now.evaluatePlan(data,[{start:0,end:data.length,cls:'binary',spec}]).totalBytes,b.length,name+' cost')
    console.log(`forced ${name} bytes=${b.length} sha256=${hash(b)}`)
  }
} finally {await rm(temp,{recursive:true,force:true})}
