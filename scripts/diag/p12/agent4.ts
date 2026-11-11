import assert from 'node:assert/strict'
import {input,same,sha,done,cat} from './common'
import {encodeCM,decodeCM,withCMBlockSize,withCMProbe} from '../../../src/lib/coder'
import {wordPreFwdSampled,wordPreFwd2Sampled,wordPreInv,wordPreInv2,dictHeader,dictHeader2,dictHeaderLen,dictHeaderLen2,collapseWithDict,collapseWithDict2} from '../../../src/lib/wordpre'
import {ID,planHeader,decompress,groupV15CandidatesSync} from '../../../src/lib/codec'
import {payloadModelFlags} from '../../../src/lib/payload-model'
const {name,variant,data,meta}=input(),started=performance.now(),spec={id:ID.TEXT_V3,s:1,r:1}
function complete(payload:Uint8Array,flags:number,wp:boolean){const h=Uint8Array.from(planHeader(data.length,[{start:0,end:data.length,cls:'text',spec}],[{spec,members:[0],payload,modelFlags:flags,v15:true,wordPre:wp}]));return {container:cat([h,payload]),headerBytes:h.length}}
function usage(body:Uint8Array,one:string[],two:string[]=[]){
 const a=new Array(one.length).fill(0),b=new Array(two.length).fill(0);let escapes=0,literals=0,covered=0,spaces=0,punctuation=0
 for(let i=0;i<body.length;i++){
  const x=body[i];let word=''
  if(x===127){i++;assert.ok(i<body.length);escapes++;literals++;continue}
  if(two.length&&x===255){const k=body[++i];assert.ok(k<two.length);b[k]++;word=two[k]}
  else if(x>=128){assert.ok(x-128<one.length);a[x-128]++;word=one[x-128]}
  else {literals++;continue}
  covered+=word.length;if(word.endsWith(' '))spaces++;if(/[.,;:)>]$/.test(word))punctuation++
 }
 const entries=[...one.map((word,i)=>({word,hits:a[i],tier:1})),...two.map((word,i)=>({word,hits:b[i],tier:2}))]
 return {oneHits:a.reduce((a,b)=>a+b,0),twoHits:b.reduce((a,b)=>a+b,0),escapedOriginalBytes:escapes,literalOriginalBytes:literals,coveredOriginalBytes:covered,coverage:covered/data.length,spaceSuffixHits:spaces,punctuationSuffixHits:punctuation,unusedTokens:entries.filter(e=>e.hits===0).length,entries}
}
function words(kind:string){
 const counts=new Map<string,number>(),char=(x:number)=>x>=65&&x<=90||x>=97&&x<=122||x>=48&&x<=57||x===95||x===39
 let totalWords=0,totalWordBytes=0
 for(let i=0;i<data.length;){if(!char(data[i])){i++;continue}let j=i+1;while(j<data.length&&char(data[j]))j++;const len=j-i
  if(len>=2&&len<=32){const w=Buffer.from(data.subarray(i,j)).toString('latin1');counts.set(w,(counts.get(w)??0)+1);totalWords++;totalWordBytes+=len
   if(kind!=='words'&&j<data.length&&data[j]===32&&(j+1===data.length||data[j+1]!==32)){counts.set(w+' ',(counts.get(w+' ')??0)+1)}
   if(kind==='words-punct'&&j<data.length&&[44,46,59,58,41,62].includes(data[j])){const x=w+String.fromCharCode(data[j]);counts.set(x,(counts.get(x)??0)+1)}
  }i=j
 }
 // One entry per lexical family: punctuation/space variants compete for the
 // same 120 one-byte slots, rather than adding another unpriced token table.
 const scored=[...counts].map(([w,c])=>({w,c,gain:c*(w.length-1)-(w.length+1)})).filter(x=>x.gain>0).sort((a,b)=>b.gain-a.gain||(a.w<b.w?-1:1))
 const families=new Set<string>(),dict:string[]=[]
 for(const e of scored){const stem=e.w.replace(/[ .,;:)>]$/,'');if(families.has(stem))continue;families.add(stem);dict.push(e.w);if(dict.length===120)break}
 return {dict,header:dictHeader(dict),body:collapseWithDict(data,dict)!,wordStats:{distinctCandidates:counts.size,totalWords,totalWordBytes}}
}
if(variant==='plain'){
 const p=withCMBlockSize(data.length,()=>encodeCM(data,'text',1,1,undefined,0,undefined,undefined,'v15')),flags=payloadModelFlags(p),f=complete(p,flags,false)
 same(decompress(f.container),data)
 done({input:meta,variant,payloadBytes:p.length,bytes:f.container.length,outerHeaderBytes:f.headerBytes,payloadSha256:sha(p),containerSha256:sha(f.container),roundtrip:true,encodeDecodeMs:performance.now()-started,scope:'actual existing single TEXT3 v15 UCZ container; forced spec, not adaptive chooser'})
}else if(variant==='production-gate'){
 const c=groupV15CandidatesSync([data],spec,[0]);assert.ok(c?.alt)
 const p=c.wordPre??c.alt,flags=payloadModelFlags(p),f=complete(p,flags,!!c.wordPre)
 same(decompress(f.container),data)
 done({input:meta,variant,payloadBytes:p.length,bytes:f.container.length,roundtrip:true,short:{plainV15:c.alt.length,wordPreCandidate:c.wordPre?.length??null,gateReturnedWordPre:c.wordPre!==null},encodeDecodeMs:performance.now()-started,scope:'actual production group candidate generation/gate; presence is not final adoption against v13/base'})
}else{
 const v2=variant.startsWith('v2'),isWords=variant.startsWith('words'),poolV1=variant==='pool-repack-v1'
 let pre:any=v2||poolV1?wordPreFwd2Sampled(data,262144,127,variant==='v2-one'?0:256):isWords?words(variant):wordPreFwdSampled(data,262144)
 assert.ok(pre&&pre.body,'No dictionary candidate')
 if(poolV1){
  const rank=usage(pre.body,pre.dict.one,pre.dict.two).entries.filter(e=>e.hits>0).sort((a,b)=>b.hits-a.hits||(a.word<b.word?-1:1))
  const dict=rank.slice(0,120).map(e=>e.word);pre={dict,header:dictHeader(dict),body:collapseWithDict(data,dict)}
 }
 if(variant==='v1-prune'||variant==='v1-repack'){
  let rank=usage(pre.body,pre.dict).entries.filter(e=>e.hits>0)
  if(variant==='v1-repack')rank.sort((a,b)=>b.hits-a.hits||(a.word<b.word?-1:1))
  const dict=rank.map(e=>e.word);pre={dict,header:dictHeader(dict),body:collapseWithDict(data,dict)}
 }
 if(variant==='v2-repack'){
  const u=usage(pre.body,pre.dict.one,pre.dict.two),rank=u.entries.filter(e=>e.hits>0).sort((a,b)=>b.hits-a.hits||(a.word<b.word?-1:1))
  const dict={one:rank.slice(0,127).map(e=>e.word),two:rank.slice(127).map(e=>e.word)}
  pre={dict,header:dictHeader2(dict),body:collapseWithDict2(data,dict)}
 }
 const header=pre.header as Uint8Array,body=pre.body as Uint8Array,stream=cat([header,body]),one=v2?pre.dict.one:pre.dict,two=v2?pre.dict.two:[]
 const stats=usage(body,one,two),inv=v2?wordPreInv2:wordPreInv,hlen=v2?dictHeaderLen2:dictHeaderLen
 same(inv(header,body,data.length),data);assert.equal(hlen(stream),header.length)
 const preprocessMs=performance.now()-started
 const cm=withCMBlockSize(data.length,()=>encodeCM(stream,'text',1,1,undefined,0,undefined,undefined,'v15',0,true)),flags=payloadModelFlags(cm)
 const prefix=new Uint8Array(v2?5:4);let offset=0;if(v2){prefix[0]=2;offset=1}new DataView(prefix.buffer).setUint32(offset,stream.length,true)
 const wrapped=cat([prefix,cm]),bodyN=new DataView(wrapped.buffer).getUint32(offset,true)
 const dec=withCMBlockSize(data.length,()=>decodeCM(wrapped.subarray(prefix.length),bodyN,'text',1,1,undefined,'v15',0,true));const dh=hlen(dec);assert.ok(dh>0)
 same(inv(dec.subarray(0,dh),dec.subarray(dh),data.length),data)
 let bytes:number|null=null,outerHeaderBytes:number|null=null,containerSha256:string|null=null
 if(!v2){const f=complete(wrapped,flags,true);same(decompress(f.container),data);bytes=f.container.length;outerHeaderBytes=f.headerBytes;containerSha256=sha(f.container)}
 done({input:meta,variant,cmBytes:cm.length,payloadBytes:wrapped.length,bytes:bytes??wrapped.length,outerHeaderBytes,containerSha256,payloadSha256:sha(wrapped),roundtrip:true,preprocessMs,encodeDecodeMs:performance.now()-started,
  short:{dictTokens:one.length+two.length,one:one.length,two:two.length,headerRawBytes:header.length,bodyRawBytes:body.length,cmInputBytes:stream.length,bodyRatio:body.length/data.length,coverage:stats.coverage,spaceSuffixHits:stats.spaceSuffixHits,punctuationSuffixHits:stats.punctuationSuffixHits,oneHits:stats.oneHits,twoHits:stats.twoHits,unusedTokens:stats.unusedTokens,escapedOriginalBytes:stats.escapedOriginalBytes,wordStats:pre.wordStats??null},usage:stats,
  scope:v2?'research-only v2 envelope: mode byte + u32 token-stream length + CM(dict||body); no compatible production UCZ outer header, no codec v2 dispatch':'actual existing v1 WORD-PRE UCZ single TEXT3 group, dictionary and length prefix and model/header flags fully charged; forced dictionary, not chooser'})
}
