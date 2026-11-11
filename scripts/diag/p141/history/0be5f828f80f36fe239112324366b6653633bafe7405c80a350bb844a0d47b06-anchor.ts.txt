import { ByteWriter } from './byte-writer'
import { encodeCM, decodeCM } from './coder'

// UCZ v7 anchor-aligned rows. Bound row metadata independently of input size.
export const MAX_ANCHOR_ROWS = 1_000_000
const PREFIX = 32, GROUP = 8
function put(w: ByteWriter, v: number) { while (v >= 128) { w.push((v % 128) | 128); v = Math.floor(v / 128) } w.push(v) }
function get(d: Uint8Array, st: {p:number}) { let v=0, mul=1; for (;;) { if (st.p>=d.length) throw Error('锚点数据被截断'); const b=d[st.p++]; v+=(b&127)*mul; if (!Number.isSafeInteger(v)) throw Error('锚点长度溢出'); if (b<128) return v; mul*=128; if (!Number.isSafeInteger(mul)) throw Error('锚点长度溢出') } }
function bytes(w: ByteWriter, d: Uint8Array) { w.append(d) }
function packStream(w: ByteWriter, data: Uint8Array, lengthStream = false) {
  let mode=0, packed=data
  const modes = lengthStream ? ['o0'] as const : ['bin', 'text'] as const
  for (const profile of modes) {
    const candidate=encodeCM(data, profile)
    if (candidate.length < packed.length) { mode=profile === 'o0' ? 3 : profile === 'bin' ? 1 : 2; packed=candidate }
  }
  w.push(mode); put(w, packed.length); bytes(w, packed)
}
function unpackStream(d: Uint8Array, st: {p:number}, n:number, lengthStream = false): Uint8Array {
  if (st.p>=d.length) throw Error('锚点流头被截断')
  const mode=d[st.p++], len=get(d,st)
  if (len>d.length-st.p || (mode===0 && len!==n) || (lengthStream ? ![0,3].includes(mode) : ![0,1,2].includes(mode))) throw Error('无效的锚点流')
  const src=d.subarray(st.p,st.p+len); st.p+=len
  return mode===0 ? new Uint8Array(src) : decodeCM(src,n,mode===3?'o0':mode===1?'bin':'text')
}
// A quick, bias-corrected column specialization estimate. It only gates
// expensive trials; encoded bytes (including metadata) decide selection.
export function anchorPotential(data: Uint8Array, anchor: number): number {
  const hist = new Uint32Array(15 * 256), global = new Uint32Array(256)
  const sizes = new Uint32Array(15)
  let starts=0, col=0
  for (let i=0;i<data.length;i++) {
    if (data[i]===anchor) { starts++; col=0; continue }
    col++
    if (col<=15) { const j=col-1; hist[j*256+data[i]]++; sizes[j]++; global[data[i]]++ }
  }
  if (starts<128) return 0
  let total=0, globalSum=0, sum=0, active=0, globalActive=0
  for (const n of sizes) total+=n
  if (total<starts*4) return 0
  for (const n of global) if(n) { globalSum-=n*Math.log2(n/total); globalActive++ }
  for(let j=0;j<15;j++) if(sizes[j]) for(let b=0;b<256;b++) {
    const n=hist[j*256+b]; if(n) { sum-=n*Math.log2(n/sizes[j]); active++ }
  }
  const correction=Math.max(0,active-globalActive)/(2*Math.LN2*total)
  return Math.max(0,(globalSum-sum)/total-correction)
}
export function anchorRowCount(data: Uint8Array, anchor: number): number {
  if (!data.length) return 0
  let count=1
  for (let i=1;i<data.length;i++) if (data[i]===anchor && ++count>MAX_ANCHOR_ROWS) return count
  return count
}
export function encodeAnchor(data: Uint8Array, anchor: number): Uint8Array {
  if (!Number.isInteger(anchor) || anchor<0 || anchor>255) throw Error('无效锚点')
  const count=anchorRowCount(data,anchor)
  if (count>MAX_ANCHOR_ROWS) throw Error('锚点行数超过上限')
  const starts=new Uint32Array(count+1)
  let k=1
  for (let i=1;i<data.length;i++) if (data[i]===anchor) starts[k++]=i
  starts[count]=data.length
  const lengths=new ByteWriter()
  for (let i=0;i<count;i++) put(lengths,starts[i+1]-starts[i])
  const rawLens=lengths.finish(), out=new ByteWriter()
  put(out,count); put(out,rawLens.length); packStream(out,rawLens,true)
  for (let col=0;col<PREFIX;col+=GROUP) {
    let size=0
    for (let i=0;i<count;i++) size+=Math.min(GROUP,Math.max(0,starts[i+1]-starts[i]-col))
    const lane=new Uint8Array(size); let p=0
    for (let i=0;i<count;i++) { const a=Math.min(starts[i+1],starts[i]+col), b=Math.min(starts[i+1],a+GROUP); lane.set(data.subarray(a,b),p); p+=b-a }
    packStream(out,lane)
  }
  let tailSize=0
  for (let i=0;i<count;i++) tailSize+=Math.max(0,starts[i+1]-starts[i]-PREFIX)
  const tail=new Uint8Array(tailSize); let p=0
  for (let i=0;i<count;i++) { const a=Math.min(starts[i+1],starts[i]+PREFIX), b=starts[i+1]; tail.set(data.subarray(a,b),p); p+=b-a }
  packStream(out,tail)
  return out.finish()
}
export function decodeAnchor(payload: Uint8Array, n:number, anchor:number): Uint8Array {
  if (!Number.isInteger(n) || n<0 || !Number.isInteger(anchor) || anchor<0 || anchor>255) throw Error('无效锚点参数')
  const st={p:0}, count=get(payload,st), rawLen=get(payload,st)
  if (count>MAX_ANCHOR_ROWS || count>n || (n>0 && !count) || rawLen<count || rawLen>count*5) throw Error('无效锚点行数')
  const raw=unpackStream(payload,st,rawLen,true), rs={p:0}, starts=new Uint32Array(count+1)
  let total=0
  for (let i=0;i<count;i++) { const len=get(raw,rs); if (!len || len>n-total) throw Error('无效锚点行长'); total+=len; starts[i+1]=total }
  if (total!==n || rs.p!==raw.length) throw Error('锚点行长不匹配')
  const out=new Uint8Array(n)
  for (let col=0;col<PREFIX;col+=GROUP) {
    let size=0
    for (let i=0;i<count;i++) size+=Math.min(GROUP,Math.max(0,starts[i+1]-starts[i]-col))
    const lane=unpackStream(payload,st,size); let p=0
    for (let i=0;i<count;i++) { const a=Math.min(starts[i+1],starts[i]+col), b=Math.min(starts[i+1],a+GROUP); out.set(lane.subarray(p,p+b-a),a); p+=b-a }
  }
  let size=0
  for (let i=0;i<count;i++) size+=Math.max(0,starts[i+1]-starts[i]-PREFIX)
  const tail=unpackStream(payload,st,size); let p=0
  for (let i=0;i<count;i++) { const a=Math.min(starts[i+1],starts[i]+PREFIX), b=starts[i+1]; out.set(tail.subarray(p,p+b-a),a); p+=b-a }
  if (st.p!==payload.length) throw Error('锚点流存在多余数据')
  for (let i=1;i<count;i++) if (out[starts[i]]!==anchor) throw Error('锚点不匹配')
  return out
}
