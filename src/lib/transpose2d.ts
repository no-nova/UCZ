import { encodeCM, decodeCM, withCMBlockSize, withCMProbe, type CMVariant, type CMOptions } from './coder'
import { ByteWriter } from './byte-writer'

function put(w:ByteWriter, n:number) { while(n>=128){w.push((n%128)|128); n=Math.floor(n/128)} w.push(n) }
function get(d:Uint8Array, st:{p:number}) { let n=0,m=1; for (;;) { if(st.p>=d.length) throw Error('二维转置头被截断');const b=d[st.p++];n+=(b&127)*m;if(!Number.isSafeInteger(n))throw Error('二维转置长度溢出');if(b<128)return n;m*=128;if(!Number.isSafeInteger(m))throw Error('二维转置长度溢出') } }
function add(w:ByteWriter, d:Uint8Array) { w.append(d) }
// Independent region streams allow a different row count (and therefore a
// different geometric stride) on each region, including partial final rows.
export function encodeTranspose2d(parts:Uint8Array[], width:number, kernel:CMVariant=true, options?:CMOptions):Uint8Array {
  if(!Number.isInteger(width)||width<2||width>64)throw Error('无效二维转置步长')
  const out=new ByteWriter()
  for(const data of parts) {
    const rows=Math.floor(data.length/width), rem=data.length%width
    const columns:Array<Uint8Array>=[], mask=new Uint8Array(Math.ceil(width/8))
    for(let c=width-1;c>=0;c--) {
      const col=new Uint8Array(rows);for(let r=0;r<rows;r++)col[r]=data[r*width+c]
      const len=Math.min(rows,4096),start=Math.floor((rows-len)/2),sample=col.subarray(start,start+len)
      if(rows<256 || withCMProbe(()=>encodeCM(sample,'bin',1,1,undefined,0,undefined,undefined,true)).length>=len*.995) mask[c>>3]|=1<<(c&7)
      columns[c]=col
    }
    let active=0;for(let c=0;c<width;c++)if(!(mask[c>>3]&(1<<(c&7))))active++
    const joined=new Uint8Array(active*rows);let pos=0
    for(let c=width-1;c>=0;c--)if(!(mask[c>>3]&(1<<(c&7)))){joined.set(columns[c],pos);pos+=rows}
    const coded=withCMBlockSize(data.length,()=>encodeCM(joined,'bin',1,1,undefined,0,undefined,undefined,kernel,rows,false,options))
    add(out,mask);put(out,coded.length);add(out,coded)
    for(let c=width-1;c>=0;c--)if(mask[c>>3]&(1<<(c&7)))add(out,columns[c])
    add(out,data.subarray(data.length-rem))
  }
  return out.finish()
}
export function decodeTranspose2d(payload:Uint8Array,lengths:number[],width:number,kernel:CMVariant=true,options?:CMOptions):Uint8Array[] {
  if(!Number.isInteger(width)||width<2||width>64)throw Error('无效二维转置步长')
  const st={p:0}, out:Uint8Array[]=[]
  for(const n of lengths) {
    if(!Number.isSafeInteger(n)||n<0)throw Error('无效二维转置长度')
    const rows=Math.floor(n/width), rem=n%width, maskLen=Math.ceil(width/8)
    if(maskLen>payload.length-st.p)throw Error('二维转置位图被截断')
    const mask=payload.subarray(st.p,st.p+maskLen);st.p+=maskLen
    if(width%8 && (mask[maskLen-1] >>> (width%8)))throw Error('无效二维转置位图')
    let active=0;for(let c=0;c<width;c++)if(!(mask[c>>3]&(1<<(c&7))))active++
    const size=get(payload,st);if(size>payload.length-st.p)throw Error('二维转置负载被截断')
    const coded=withCMBlockSize(n,()=>decodeCM(payload.subarray(st.p,st.p+size),active*rows,'bin',1,1,undefined,kernel,rows,false,options));st.p+=size
    const target=new Uint8Array(n);let pos=0
    for(let c=width-1;c>=0;c--)if(!(mask[c>>3]&(1<<(c&7)))){for(let r=0;r<rows;r++)target[r*width+c]=coded[pos++]} 
    for(let c=width-1;c>=0;c--)if(mask[c>>3]&(1<<(c&7))){if(rows>payload.length-st.p)throw Error('二维转置原样列被截断');for(let r=0;r<rows;r++)target[r*width+c]=payload[st.p++]} 
    if(rem>payload.length-st.p)throw Error('二维转置尾行被截断')
    target.set(payload.subarray(st.p,st.p+rem),n-rem);st.p+=rem;out.push(target)
  }
  if(st.p!==payload.length)throw Error('二维转置负载有尾随数据')
  return out
}
