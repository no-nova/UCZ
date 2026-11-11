import { encodeCM, decodeCM, withCMBlockSize, withCMProbe, type Profile, type CMVariant } from './coder'
import { ByteWriter } from './byte-writer'

function put(w:ByteWriter,n:number) { while(n>=128){w.push(n%128|128);n=Math.floor(n/128)}w.push(n) }
function get(d:Uint8Array,s:{p:number}):number {let n=0,m=1;for(;;){if(s.p>=d.length)throw Error('子通道头被截断');const b=d[s.p++];n+=(b&127)*m;if(!Number.isSafeInteger(n))throw Error('子通道长度溢出');if(b<128)return n;m*=128;if(!Number.isSafeInteger(m))throw Error('子通道长度溢出')}}
function add(w:ByteWriter,d:Uint8Array){w.append(d)}
function cat(parts:Uint8Array[]):Uint8Array {const n=parts.reduce((a,b)=>a+b.length,0),o=new Uint8Array(n);let p=0;for(const b of parts){o.set(b,p);p+=b.length}return o}
function rle(d:Uint8Array):Uint8Array {const w=new ByteWriter();for(let i=0;i<d.length;){let j=i+1;while(j<d.length&&d[j]===d[i])j++;w.push(d[i]);put(w,j-i);i=j}return w.finish()}
function unrle(d:Uint8Array,n:number):Uint8Array {const o=new Uint8Array(n),s={p:0};let pos=0;while(s.p<d.length){const b=d[s.p++],k=get(d,s);if(!k||k>n-pos)throw Error('子通道游程越界');o.fill(b,pos,pos+k);pos+=k}if(pos!==n)throw Error('子通道游程长度错误');return o}
function delta(data:Uint8Array,lengths:number[],inverse=false):Uint8Array {const o=new Uint8Array(data.length);let pos=0;for(const n of lengths){let prev=0;for(let i=0;i<n;i++){const value=inverse?(data[pos]+prev)&255:data[pos];o[pos]=inverse?value:(value-prev)&255;prev=value;pos++}}if(pos!==data.length)throw Error('子通道差分长度错误');return o}
function pack(mode:number,raw:Uint8Array,diff:Uint8Array,profile:Profile,variant:CMVariant=false):Uint8Array {
  if(mode===0)return raw
  if(mode===1){const r=rle(raw),o=encodeCM(r,'o0'),w=new ByteWriter();put(w,r.length);add(w,o);return w.finish()}
  return encodeCM(mode===4?raw:diff,mode===2?'o0':mode===3?'bin':profile,1,1,undefined,0,undefined,undefined,variant)
}
function unpack(mode:number,payload:Uint8Array,n:number,profile:Profile,variant:CMVariant=false):Uint8Array {
  if(mode===0){if(payload.length!==n)throw Error('原样子通道长度错误');return new Uint8Array(payload)}
  if(mode===1){const st={p:0},len=get(payload,st);if(len>2*n+5)throw Error('游程数据长度越界');return unrle(decodeCM(payload.subarray(st.p),len,'o0'),n)}
  return decodeCM(payload,n,mode===2?'o0':mode===3?'bin':profile,1,1,undefined,variant)
}
class BitsOut {w=new ByteWriter();v=0;n=0;put(x:number,k:number){for(let i=0;i<k;i++){this.v|=((x>>i)&1)<<this.n;if(++this.n===8){this.w.push(this.v);this.v=0;this.n=0}}}finish(){if(this.n)this.w.push(this.v);return this.w.finish()}}
class BitsIn {p=0;constructor(public d:Uint8Array){}get(n:number){let x=0;for(let i=0;i<n;i++){if(this.p>=this.d.length*8)throw Error('模态位图被截断');x|=((this.d[this.p>>3]>>(this.p&7))&1)<<i;this.p++}return x}}
function modesTable(modes:number[]):{unique:number[];bits:Uint8Array} {
  const counts=new Uint32Array(5);for(const m of modes)counts[m]++
  const unique=[0,1,2,3,4].filter(i=>counts[i]).sort((a,b)=>counts[b]-counts[a]||a-b)
  const out=new BitsOut();out.put(unique.length,3);for(const m of unique)out.put(m,3)
  let pending=modes.map((_,i)=>i)
  for(let k=0;k+1<unique.length;k++){const next:number[]=[];for(const i of pending){const hit=modes[i]===unique[k];out.put(hit?1:0,1);if(!hit)next.push(i)}pending=next}
  return {unique,bits:out.finish()}
}
function readModes(d:Uint8Array,width:number):{modes:number[];unique:number[]} {
  const bits=new BitsIn(d),n=bits.get(3);if(!n||n>5)throw Error('子通道模态数量错误')
  const unique:number[]=[];for(let i=0;i<n;i++){const m=bits.get(3);if(m>4||unique.includes(m))throw Error('无效子通道模态');unique.push(m)}
  const modes=new Array<number>(width),pending0=Array.from({length:width},(_,i)=>i);let pending=pending0
  for(let k=0;k+1<n;k++){const next:number[]=[];for(const i of pending){if(bits.get(1))modes[i]=unique[k];else next.push(i)}pending=next}
  for(const i of pending)modes[i]=unique[n-1]
  if(unique.some(m=>!modes.includes(m)) || Math.ceil(bits.p/8)!==d.length)throw Error('无效子通道位图')
  return {modes,unique}
}
export interface SubPeelInfo {grouped:boolean; modes:number[]; payloadSizes:number[]}
export function encodePeeledTranspose(parts:Uint8Array[],width:number,profile:Profile='bin',variant:CMVariant=false):Uint8Array {
  if(!Number.isInteger(width)||width<2||width>64||!['bin','text'].includes(profile))throw Error('无效子通道参数')
  const blockBytes=parts.reduce((n,p)=>n+p.length,0)
  const raw:Uint8Array[]=[],diff:Uint8Array[]=[],modes:number[]=[],individual:Uint8Array[]=[]
  for(let c=0;c<width;c++){
    const lengths=parts.map(p=>Math.floor(p.length/width)+(c<p.length%width?1:0)),len=lengths.reduce((a,b)=>a+b,0),column=new Uint8Array(len);let p=0
    for(const part of parts)for(let i=c;i<part.length;i+=width)column[p++]=part[i]
    const d=delta(column,lengths);raw.push(column);diff.push(d)
    const take=len<=24576?len:16384,start=len<=24576?0:Math.floor((len-take)/2),rs=column.subarray(start,start+take),ds=d.subarray(start,start+take)
    let mode=0,best=take
    for(let k=1;k<=4;k++){const v=withCMProbe(()=>pack(k,rs,ds,profile,variant)).length+(k===2?2:4);if(v<best){best=v;mode=k}}
    let encoded=mode?withCMBlockSize(blockBytes,()=>pack(mode,column,d,profile,variant)):column
    if(encoded.length>=len){mode=0;encoded=column}
    modes.push(mode);individual.push(encoded)
  }
  const table=modesTable(modes)
  function make(grouped:boolean){const w=new ByteWriter();w.push(grouped?1:0);put(w,table.bits.length);add(w,table.bits)
    const entries=grouped?table.unique.map(mode=>{const ids=modes.map((v,i)=>v===mode?i:-1).filter(i=>i>=0);return withCMBlockSize(blockBytes,()=>pack(mode,cat(ids.map(i=>raw[i])),cat(ids.map(i=>diff[i])),profile,variant))}):individual
    for(const item of entries){put(w,item.length);add(w,item)}return w.finish()}
  const a=make(false),b=make(true)
  return b.length<a.length?b:a
}
export function decodePeeledTranspose(payload:Uint8Array,lengths:number[],width:number,profile:Profile='bin',variant:CMVariant=false):Uint8Array[] {
  if(!Number.isInteger(width)||width<2||width>64||!['bin','text'].includes(profile)||lengths.some(n=>!Number.isInteger(n)||n<0))throw Error('无效子通道参数')
  const st={p:0};if(st.p>=payload.length)throw Error('子通道数据被截断');const flag=payload[st.p++];if(flag>1)throw Error('无效子通道布局')
  const bm=get(payload,st);if(bm>payload.length-st.p)throw Error('子通道位图被截断');const {modes,unique}=readModes(payload.subarray(st.p,st.p+bm),width);st.p+=bm
  const blockBytes=lengths.reduce((n,v)=>n+v,0)
  const colLens=modes.map((_,c)=>lengths.map(n=>Math.floor(n/width)+(c<n%width?1:0))), totals=colLens.map(x=>x.reduce((a,b)=>a+b,0)),columns=new Array<Uint8Array>(width)
  const read=()=>{const len=get(payload,st);if(len>payload.length-st.p)throw Error('子通道负载被截断');const p=payload.subarray(st.p,st.p+len);st.p+=len;return p}
  if(flag===0){for(let c=0;c<width;c++){const v=withCMBlockSize(blockBytes,()=>unpack(modes[c],read(),totals[c],profile,variant));columns[c]=(modes[c]===2||modes[c]===3)?delta(v,colLens[c],true):v}}
  else for(const mode of unique){const ids=modes.map((v,i)=>v===mode?i:-1).filter(i=>i>=0),n=ids.reduce((a,i)=>a+totals[i],0),v=withCMBlockSize(blockBytes,()=>unpack(mode,read(),n,profile,variant));let p=0;for(const c of ids){const piece=v.subarray(p,p+totals[c]);columns[c]=(mode===2||mode===3)?delta(piece,colLens[c],true):piece;p+=totals[c]}}
  if(st.p!==payload.length)throw Error('子通道负载含多余数据')
  const out=lengths.map(n=>new Uint8Array(n));for(let c=0;c<width;c++){let p=0;for(const part of out)for(let i=c;i<part.length;i+=width)part[i]=columns[c][p++]}
  return out
}
export function inspectPeeledTranspose(payload:Uint8Array,width:number):SubPeelInfo {
  const s={p:0};if(!payload.length||payload[0]>1)throw Error('无效子通道布局');const grouped=payload[s.p++]===1,bm=get(payload,s);if(bm>payload.length-s.p)throw Error('子通道位图被截断');const {modes,unique}=readModes(payload.subarray(s.p,s.p+bm),width);s.p+=bm
  const sizes:number[]=[];for(let i=0;i<(grouped?unique.length:width);i++){const n=get(payload,s);if(n>payload.length-s.p)throw Error('子通道负载被截断');sizes.push(n);s.p+=n}if(s.p!==payload.length)throw Error('子通道负载含多余数据');return {grouped,modes,payloadSizes:sizes}
}

// Anchor channel payloads store only each region's tail length and row count.
// The K-by-M lengths are reconstructed from delimiter conservation, not stored.
export function encodePeeledAnchor(parts:Uint8Array[],s:number,r:number,variant:CMVariant=false):Uint8Array {
  const aR=s&255,rawR=r&127,grid=rawR>=32||rawR===9,aC=grid?rawR:-1,K=grid?12:Math.max(2,Math.min(24,rawR)),profile:Profile=r&128?'bin':'text'
  if(grid&&aR===aC)throw Error('行列锚点不能相同')
  const blockBytes=parts.reduce((n,p)=>n+p.length,0)
  const counts=parts.map(()=>new Uint32Array(K)),tails:number[]=[],rows:number[]=[],totals=new Uint32Array(K)
  for(let m=0;m<parts.length;m++){
    const d=parts[m];let last=d.length-1;while(last>=0&&d[last]!==aR)last--
    tails.push(d.length-1-last);let col=0,row=0
    for(let i=0;i<=last;i++){const b=d[i];counts[m][col]++;totals[col]++;if(b===aR){col=0;row++}else if(col<K-1&&(!grid||b===aC))col++}rows.push(row)
  }
  const columns=Array.from(totals,n=>new Uint8Array(n)),offsets=new Uint32Array(K),tail=new Uint8Array(tails.reduce((a,b)=>a+b,0));let tp=0
  for(let m=0;m<parts.length;m++){const d=parts[m],end=d.length-tails[m];let col=0;for(let i=0;i<end;i++){const b=d[i];columns[col][offsets[col]++]=b;if(b===aR)col=0;else if(col<K-1&&(!grid||b===aC))col++}tail.set(d.subarray(end),tp);tp+=tails[m]}
  const w=new ByteWriter();for(let m=0;m<parts.length;m++){put(w,tails[m]);put(w,rows[m])}
  let mask=0;for(let c=0;c<K;c++)if(totals[c])mask|=1<<c;put(w,mask)
  for(let c=0;c<K;c++)if(totals[c]){
    const raw=columns[c],d=delta(raw,counts.map(x=>x[c])),take=raw.length<=24576?raw.length:16384,start=raw.length<=24576?0:Math.floor((raw.length-take)/2),rs=raw.subarray(start,start+take),ds=d.subarray(start,start+take)
    let mode=0,best=take;for(const k of [1,3,4]){const size=withCMProbe(()=>pack(k,rs,ds,profile,variant)).length+4;if(size<best){best=size;mode=k}}
    let enc=mode?withCMBlockSize(blockBytes,()=>pack(mode,raw,d,profile,variant)):raw;if(enc.length>=raw.length){mode=0;enc=raw}
    put(w,raw.length);put(w,mode);put(w,enc.length);add(w,enc)
  }
  const tc=withCMBlockSize(blockBytes,()=>encodeCM(tail,profile,1,1,undefined,0,undefined,undefined,variant)),mode=tc.length<tail.length?4:0,enc=mode?tc:tail
  put(w,mode);put(w,enc.length);add(w,enc)
  return w.finish()
}
export function decodePeeledAnchor(payload:Uint8Array,lengths:number[],s:number,r:number,variant:CMVariant=false):Uint8Array[] {
  const aR=s&255,rawR=r&127,grid=rawR>=32||rawR===9,aC=grid?rawR:-1,K=grid?12:Math.max(2,Math.min(24,rawR)),profile:Profile=r&128?'bin':'text'
  if(grid&&aR===aC)throw Error('行列锚点不能相同')
  const st={p:0},tails:number[]=[],needed:number[]=[],remain:number[]=[]
  for(const n of lengths){if(!Number.isInteger(n)||n<0)throw Error('无效区域长度');const t=get(payload,st),rows=get(payload,st);if(t>n||rows>n-t)throw Error('无效锚点计数');tails.push(t);needed.push(rows);remain.push(n-t)}
  const mask=get(payload,st);if(mask>=2**K)throw Error('无效锚点通道掩码')
  const channels:Uint8Array[]=Array.from({length:K},()=>new Uint8Array(0)),modes=new Uint8Array(K)
  const total=lengths.reduce((a,b)=>a+b,0),prefixTotal=remain.reduce((a,b)=>a+b,0)
  let declared=0
  for(let c=0;c<K;c++)if(mask&(1<<c)){
    const n=get(payload,st),mode=get(payload,st),pl=get(payload,st)
    declared+=n
    if(!n||n>total||declared>prefixTotal||![0,1,3,4].includes(mode)||pl>payload.length-st.p)throw Error('无效锚点通道')
    channels[c]=withCMBlockSize(total,()=>unpack(mode,payload.subarray(st.p,st.p+pl),n,profile,variant));modes[c]=mode;st.p+=pl
  }
  if(declared!==prefixTotal)throw Error('锚点通道总长度错误')
  const tailN=tails.reduce((a,b)=>a+b,0),tailMode=get(payload,st),tailPL=get(payload,st)
  if(![0,4].includes(tailMode)||tailPL>payload.length-st.p)throw Error('无效锚点尾流')
  const tail=withCMBlockSize(total,()=>unpack(tailMode,payload.subarray(st.p,st.p+tailPL),tailN,profile,variant));st.p+=tailPL
  if(st.p!==payload.length)throw Error('锚点通道含多余数据')
  const pieces=lengths.map(()=>new Array<Uint8Array>(K))
  for(let c=0;c<K;c++){
    const stream=channels[c];let p=0
    for(let m=0;m<lengths.length;m++){
      const start=p;let previous=0,next=0,count=0,remaining=needed[m]
      const expected=c===K-1?remain[m]:grid?-1:remaining
      while(expected<0?remaining>0:count<expected){
        if(p>=stream.length || count>=remain[m])throw Error('锚点守恒长度错误')
        let b=stream[p]
        if(modes[c]===3){b=(b+previous)&255;stream[p]=b;previous=b}
        p++;count++
        if(c<K-1){if(grid){if(b===aR)remaining--;else if(b===aC){remaining--;next++}}else if(b!==aR)next++}
      }
      pieces[m][c]=stream.subarray(start,p);remain[m]-=count
      if(c<K-1)needed[m]=next
    }
    if(p!==stream.length)throw Error('锚点通道边界不匹配')
  }
  const out=lengths.map(n=>new Uint8Array(n));let tp=0
  for(let m=0;m<lengths.length;m++){
    const part=out[m],end=part.length-tails[m],pos=new Uint32Array(K);let col=0
    for(let i=0;i<end;i++){const source=pieces[m][col];if(pos[col]>=source.length)throw Error('锚点列不足');const b=source[pos[col]++];part[i]=b;if(b===aR)col=0;else if(col<K-1&&(!grid||b===aC))col++}
    for(let c=0;c<K;c++)if(pos[c]!==pieces[m][c].length)throw Error('锚点列多余')
    part.set(tail.subarray(tp,tp+tails[m]),end);tp+=tails[m]
  }
  return out
}
export interface AnchorSubInfo {channels:{column:number;rawLen:number;mode:number;payloadSize:number}[];tailMode:number;tailSize:number}
export function inspectPeeledAnchor(payload:Uint8Array, lengths:number[], r:number):AnchorSubInfo {
  const st={p:0},raw=r&127,K=raw>=32||raw===9?12:Math.max(2,Math.min(24,raw))
  for(const n of lengths){const tail=get(payload,st),rows=get(payload,st);if(tail>n||rows>n-tail)throw Error('锚点计数错误')}
  const mask=get(payload,st);if(mask>=2**K)throw Error('锚点掩码错误')
  const channels:AnchorSubInfo['channels']=[]
  for(let c=0;c<K;c++)if(mask&(1<<c)){const rawLen=get(payload,st),mode=get(payload,st),size=get(payload,st);if(!rawLen||![0,1,3,4].includes(mode)||size>payload.length-st.p)throw Error('锚点通道错误');channels.push({column:c,rawLen,mode,payloadSize:size});st.p+=size}
  const tailMode=get(payload,st),tailSize=get(payload,st);if(![0,4].includes(tailMode)||tailSize>payload.length-st.p)throw Error('锚点尾流错误');st.p+=tailSize;if(st.p!==payload.length)throw Error('锚点通道尾部多余数据')
  return {channels,tailMode,tailSize}
}
