// Read ONLY <=512KiB of an existing v19/v20 UCZ header. No decode/CM/chooser.
// This provides actual final group payload lengths when a user-local .ucz exists.
import { openSync,readSync,closeSync,fstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export function inspectHeader(b,fileBytes) {
 let p=0
 const byte=()=>{if(p>=b.length)throw Error('Header exceeds supplied <=512KiB prefix');return b[p++]}
 if(byte()!==85||byte()!==67||byte()!==90)throw Error('Not UCZ')
 const version=byte();if(version!==19&&version!==20)throw Error('This read-only inspector supports v19/v20 only')
 const flags=byte()|(byte()<<8)
 const v=()=>{let n=0,m=1;for(let k=0;k<8;k++){const x=byte();n+=(x&127)*m;if(!Number.isSafeInteger(n))throw Error('Unsafe varint');if(x<128)return n;m*=128}throw Error('Bad varint')}
 const rawBytes=v(),segmentCount=v(),groupCount=v()
 if(!segmentCount||segmentCount>65536||!groupCount||groupCount>512||groupCount>segmentCount)throw Error('Header count outside inspector budget')
 const family=(id,s)=>[5,19,24].includes(id)?'BIN':[11,20,25].includes(id)?(id===25&&s===2?'BCJ25-MSB':'BCJ'):[15,16,28,29].includes(id)?'SUB':id===30?'TG3':[6,27].includes(id)?'DELTA':id===0?'RAW':[4,18,23].includes(id)?'TEXT':id===31?'WIDE':id===1?'FILL':`ID-${id}`
 const keys=new Set(),groups=Array.from({length:groupCount},(_,index)=>{
  const id=v(),s=v(),rRaw=v(),payloadBytes=v(),r=rRaw&~(0x8000|0x4000|0x10000),key=`${id}/${s}/${r}`
  if(id>31||r<1||r>8192||keys.has(key)||(version<20&&(rRaw&0x10000)))throw Error('Invalid/duplicate group rule')
  keys.add(key)
  return {index,spec:{id,s,r},kernel:(rRaw&0x10000)?'v20':(rRaw&0x8000)?'v15':'base',wordPre:!!(rRaw&0x4000),family:family(id,s),payloadBytes,rawBytes:0,members:[]}
 })
 const lengths=Array.from({length:segmentCount},v)
 if(lengths.some(n=>n<=0)||lengths.reduce((n,x)=>n+x,0)!==rawBytes)throw Error('Invalid segment lengths')
 let pending=lengths.map((_,i)=>i),packed=0,remaining=0
 const bit=()=>{if(!remaining){packed=byte();remaining=8}const result=packed&1;packed>>>=1;remaining--;return result}
 for(let gi=0;gi+1<groupCount;gi++) {
  const next=[];for(const i of pending)if(bit())groups[gi].members.push(i);else next.push(i);pending=next
 }
 groups.at(-1).members=pending
 for(const g of groups){if(!g.members.length)throw Error('Empty group');g.rawBytes=g.members.reduce((n,i)=>n+lengths[i],0)}
 const payloadBytes=groups.reduce((n,g)=>n+g.payloadBytes,0)
 if(p+payloadBytes!==fileBytes)throw Error('Header/payload lengths do not match file size')
 const families={}
 for(const g of groups){const f=families[g.family]??={rawBytes:0,payloadBytes:0,groups:0};f.rawBytes+=g.rawBytes;f.payloadBytes+=g.payloadBytes;f.groups++}
 return {version,flags,rawBytes,segmentCount,groupCount,headerBytes:p,payloadBytes,fileBytes,groups,families,
  actualDirectory:true,payloadDecoded:false,inputHashVerified:false,cmCalls:0,note:'Exact serialized group lengths, not segment cost allocation; integrity/roundtrip must come from the separate local validation report.'}
}
if(import.meta.url&&process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const path=process.argv[2];if(!path)throw Error('Usage: inspect-container.mjs /path/to/existing.ucz (no encoding)')
 const fd=openSync(path,'r')
 try{const n=fstatSync(fd).size,b=Buffer.alloc(Math.min(n,512*1024));const read=readSync(fd,b,0,b.length,0);console.log(JSON.stringify(inspectHeader(b.subarray(0,read),n),null,2))}finally{closeSync(fd)}
}
