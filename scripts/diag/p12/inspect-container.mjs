// Metadata-only inspector: reads an existing UCZ, never encodes or decodes data.
// Usage: node .../inspect-container.mjs /path/to/mozilla.ucz --baseline mozilla
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'
export function inspect(c){
 assert.ok(c.length>=7&&c.subarray(0,3).toString('ascii')==='UCZ','Not a UCZ file')
 const version=c[3];assert.ok(version>=2&&version<=19,'Inspector supports grouped UCZ v2..v19 only')
 let p=version===19?6:version>=17?5:4
 assert.ok(p<c.length)
 const flags=version===19?c[4]|c[5]<<8:version>=17?c[4]:0
 const read=()=>{let n=0,m=1;for(let k=0;k<8;k++){assert.ok(p<c.length,'Truncated header');const b=c[p++];n+=(b&127)*m;assert.ok(Number.isSafeInteger(n));if(b<128)return n;m*=128}throw Error('Invalid varint')}
 const n=read(),segmentCount=read(),groupCount=read()
 assert.ok(segmentCount<=n&&segmentCount<=c.length&&segmentCount<=1000000)
 assert.ok(groupCount<=segmentCount&&(segmentCount===0||groupCount>0))
 const groups=[];for(let i=0;i<groupCount;i++){
  const id=read(),s=read(),rRaw=read(),payloadBytes=read(),v15=version>=15&&!!(rRaw&32768),wordPre=version>=15&&!!(rRaw&16384),r=v15||wordPre?rRaw&16383:rRaw
  assert.ok(id<=31&&r>=1)
  groups.push({index:i,id,s,r,v15,wordPre,payloadBytes,members:[]})
 }
 const segments=[];let total=0
 for(let i=0;i<segmentCount;i++){const bytes=read();assert.ok(bytes>0&&bytes<=n-total);segments.push({index:i,start:total,end:total+bytes,bytes});total+=bytes}
 assert.equal(total,n)
 let pending=segments.map(s=>s.index),bit=0
 for(let gi=0;gi+1<groupCount;gi++){
  const next=[];for(const i of pending){const pos=p+Math.floor(bit/8);assert.ok(pos<c.length);if((c[pos]>>>(bit%8))&1)groups[gi].members.push(i);else next.push(i);bit++}
  assert.ok(groups[gi].members.length);pending=next
 }
 if(groupCount){assert.ok(pending.length);groups[groupCount-1].members=pending}
 p+=Math.ceil(bit/8);const headerBytes=p
 for(const g of groups){g.payloadOffset=p;assert.ok(g.payloadBytes<=c.length-p);p+=g.payloadBytes;g.rawBytes=g.members.reduce((n,i)=>n+segments[i].bytes,0);g.rawFraction=g.rawBytes/Math.max(1,n);g.ranges=g.members.map(i=>[segments[i].start,segments[i].end]);g.orphanSizeEligible=g.id!==1&&g.rawBytes<2*1024*1024&&g.rawBytes<n*.2}
 assert.equal(p,c.length,'Trailing or truncated payloads')
 return {kind:'P12-existing-container-metadata',version,modelFlags:flags,rawBytes:n,containerBytes:c.length,containerSha256:createHash('sha256').update(c).digest('hex'),headerBytes,segmentCount,groupCount,groups,segments,decoded:false,sourceCommitKnown:false,note:'Exact header/group layout only. Does not prove input SHA, kernel correctness, encoder commit, or profitable merging. Orphan flags are size-only eligibility, never adoption.'}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [file,...args]=process.argv.slice(2);assert.ok(file,'Existing UCZ path required; no recompression fallback')
 const r=inspect(readFileSync(file)),i=args.indexOf('--baseline')
 if(i>=0){const name=args[i+1],b=JSON.parse(readFileSync('scripts/diag/baseline.json','utf8')).files.find(f=>f.file===name);assert.ok(b,'Unknown baseline file');r.baseline={file:name,expectedRawBytes:b.size,expectedContainerBytes:b.bestUcz,sizeMatches:r.rawBytes===b.size&&r.containerBytes===b.bestUcz,expectedInputSha256:b.sha256,inputShaVerified:false}}
 console.log(JSON.stringify(r,null,2))
}
