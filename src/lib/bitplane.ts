import { deadlineHit } from './planner/budget'

import {encodeCM,decodeCM} from './coder'
import {MAX_OUTPUT_BYTES} from './limits'
import {inheritPayloadModel} from './payload-model'
import {encodePlaneBitCM,decodePlaneBitCM,createBitCMModel} from './bitcm'

/** P16.2: cheap first-order gate, kept from the REC2 lineage. A high first-2 KiB
 * byte entropy is one trigger; see `bitplaneStoreTrigger` for the other. */
export function bitplaneEntropyGate(data:Uint8Array):boolean {
 if(data.length<16384)return false
 const counts=new Uint32Array(256);for(let i=0;i<2048;i++)counts[data[i]]++
 let h=0;for(const count of counts)if(count){const p=count/2048;h-=p*Math.log2(p)}
 return h>7.5
}

/** AITDCC/L reaches the bit-plane stage while still failing the 7.5-bit gate:
 * its high planes are near-random, so the byte-level CM models lose everywhere and
 * the baseline keeps the whole file in STORE. Raw-STORE dominance is therefore the
 * second, targeted trigger. Normal text/code/binaries compress and stay untouched. */
export function bitplaneStoreTrigger(rawBytes:number,storedBytes:number):boolean {
 return rawBytes>=16384 && storedBytes*2>rawBytes
}

export const BITPLANE_SCREEN_THRESHOLD=0.975
/** Plane format tags carried by the group's `r` (id33 keeps r=1 compatible). */
export const BITPLANE_BYTE_CM=1
export const BITPLANE_BIT_CM=2
export const BITPLANE_PERIOD_CM=4

/** The legacy statistical screen. Retained for diagnostics and for old receipts;
 * it is NOT the adoption gate any more, because at 16..20 orders the corrected
 * entropy plus Laplace validation rejects real structure (see the P16.2 report). */
export function bitplaneScreen(data:Uint8Array):{k:number;orders:number[];entropies:number[]} {
 const m=Math.min(data.length,262144)
 if(m<16384)throw Error('位平面筛选输入过短')
 const k=Math.min(16,Math.max(13,Math.floor(Math.log2(m))-2)),orders=[12,k],entropies:number[]=[]
 const xlog=new Float64Array(m+1),logFactorial=new Float64Array(m+2)
 for(let i=2;i<=m;i++)xlog[i]=i*Math.log2(i)
 for(let i=2;i<logFactorial.length;i++)logFactorial[i]=logFactorial[i-1]+Math.log2(i)
 for(let b=0;b<8;b++){
  const sizes=orders.map(o=>1<<o),zeros=sizes.map(size=>new Uint32Array(size)),ones=sizes.map(size=>new Uint32Array(size));let history=0
  let midZeros:Uint32Array[]=[],midOnes:Uint32Array[]=[]
  for(let i=0;i<m;i++){
   if(i===Math.floor(m/2)){midZeros=zeros.map(x=>x.slice());midOnes=ones.map(x=>x.slice())}
   const bit=(data[i]>>>b)&1
   for(let j=0;j<2;j++)if(i>=orders[j]){const h=history&(sizes[j]-1);(bit?ones[j]:zeros[j])[h]++}
   history=((history<<1)|bit)&(sizes[1]-1)
  }
  let best=1
  for(let j=0;j<2;j++){
   let cost=0,active=0,validation=0;const z=zeros[j],o=ones[j],total=m-orders[j],z0=midZeros[j],o0=midOnes[j]
   const code=(a:number,c:number)=>logFactorial[a+c+1]-logFactorial[a]-logFactorial[c]
   for(let i=0;i<z.length;i++){const a=z[i],c=o[i],n=a+c;if(n){active++;cost+=xlog[n]-xlog[a]-xlog[c];validation+=code(a,c)-code(z0[i],o0[i])}}
   const corrected=cost/total+active/(2*Math.LN2*total)
   if(validation/(m-Math.floor(m/2))<0.985)best=Math.min(best,corrected)
  }
  entropies.push(best)
 }
 return {k,orders,entropies}
}

/** Pack plane `b` (LSB-first) into bytes. */
function packPlane(data:Uint8Array,b:number,q:number):Uint8Array {
 const p=new Uint8Array(q)
 for(let i=0;i<q*8;i++)p[i>>>3]|=((data[i]>>>b)&1)<<(i&7)
 return p
}

/** Real-coder arbitration on the FULL plane.
 *
 * A 16 KiB sample is not enough for these models: order 16 has 65,536 states and
 * order 20 has 1,048,576, so a small sample fills almost none of them and the
 * measured ratio collapses toward 1.0. Confirmed on a bounded L-shaped proxy at
 * 5% noise: the sample rejected every plane that the full encode shrinks to 0.09.
 * Full arbitration is cheap enough here (measured ~0.4 s/MiB for all eight planes)
 * and it is exact, so a random plane can never be adopted: the model's own output
 * is larger than the raw plane and the plane stays stored.
 */
export function bitplaneFullProof(data:Uint8Array):{q:number;proof:boolean[];coded:Uint8Array[];ms:number} {
 const start=Date.now(),q=Math.floor(data.length/8),proof:boolean[]=[],coded:Uint8Array[]=[]
 for(let b=0;b<8;b++){
  const plane=packPlane(data,b,q)
  const bytes=encodePlaneBitCM(plane,q*8,createBitCMModel(BITPLANE_BIT_ORDERS))
  coded.push(bytes)
  proof.push(bytes.length+4<q||!!findLag(plane,q*8))
 }
 return {q,proof,coded,ms:Date.now()-start}
}

/** P22.1: exact emergent dyadic lag. A plane whose tail is an exact copy of an
 * earlier power-of-two prefix (possibly inverted) costs only that prefix plus two
 * tag bytes, independent of the tail length. The lag is discovered from the data;
 * no plane index or corpus constant is assumed. */
function findLag(plane:Uint8Array,bits:number):{k:number;inv:number}|null {
 for(let k=10;k<=21;k++){
  const D=1<<k
  if(D>=bits)break
  let inv=-1,ok=true
  for(let i=D;i<bits;i++){
   const a=(plane[i>>>3]>>>(i&7))&1,b=(plane[(i-D)>>>3]>>>((i-D)&7))&1
   if(a===b){if(inv===1){ok=false;break}}
   else{if(inv===0){ok=false;break}inv=1}
  }
  if(ok)return {k,inv:inv===1?1:0}
 }
 return null
}

function encodeLagPlane(plane:Uint8Array,lag:{k:number;inv:number}):Uint8Array {
 const D=1<<lag.k,out=new Uint8Array(2+(D>>>3))
 out[0]=lag.inv;out[1]=lag.k
 out.set(plane.subarray(0,D>>>3),2)
 return out
}

function decodeLagPlane(payload:Uint8Array,bits:number,length:number):Uint8Array {
 if(length<3)throw Error('位平面周期载荷被截断')
 const inv=payload[0],k=payload[1]
 if(inv>1||k<10||k>21)throw Error('无效位平面周期参数')
 const D=1<<k,need=2+(D>>>3)
 if(D>=bits||length!==need)throw Error('无效位平面周期长度')
 const plane=new Uint8Array((bits+7)>>>3)
 plane.set(payload.subarray(2,need),0)
 for(let i=D;i<bits;i++){
  const bit=((plane[(i-D)>>>3]>>>((i-D)&7))&1)^inv
  if(bit)plane[i>>>3]|=1<<(i&7)
 }
 return plane
}

/** Bit-CM payload: same mask/length layout as the legacy byte-CM payload.
 * The order set is FIXED per payload (BITPLANE_BIT_ORDERS) so that `r` alone
 * determines the model; a per-plane order choice would not be decodable. */
export function encodeBitplanesBitCM(data:Uint8Array,proof:readonly boolean[],coded?:readonly Uint8Array[]):Uint8Array|null {
 if(data.length>MAX_OUTPUT_BYTES||data.length<8||proof.length!==8)throw Error('无效位平面输入')
 const q=Math.floor(data.length/8),rem=data.length%8,planes:Uint8Array[]=[],compressed:boolean[]=[],lags:boolean[]=[]
 for(let b=0;b<8;b++){
  const p=packPlane(data,b,q)
  let out:Uint8Array=p,used=false,lagged=false
  if(proof[b]){
   const lag=findLag(p,q*8)
   if(lag){
    const laggedBytes=encodeLagPlane(p,lag)
    if(laggedBytes.length+4<q){out=laggedBytes;used=true;lagged=true}
   }
   if(!lagged){
    const bytes=coded?.[b]??encodePlaneBitCM(p,q*8,createBitCMModel(BITPLANE_BIT_ORDERS))
    if(bytes.length+4<q){out=bytes;used=true}
   }
  }
  planes.push(out);compressed.push(used);lags.push(lagged)
 }
 if(!compressed.some(Boolean))return null
 const size=1+rem+planes.reduce((n,p,i)=>n+p.length+(compressed[i]?4:0),0)
 const out=new Uint8Array(size);let pos=1
 for(let b=0;b<8;b++){
  const p=planes[b]
  if(compressed[b]){
   // Bit 31 marks the bit-CM model. Legacy byte-CM payloads (r=1) keep their exact
   // old bytes, and a model/flag mismatch is a loud decode error, not silent garbage.
   out[0]|=1<<b
   const n=(p.length|(lags[b]?0xc0000000:0x80000000))>>>0
   out[pos++]=n&255;out[pos++]=n>>>8&255;out[pos++]=n>>>16&255;out[pos++]=n>>>24&255
  }
  out.set(p,pos);pos+=p.length
 }
 out.set(data.subarray(q*8),pos);return out
}

/** Legacy byte-level CM plane payload, kept for r=1 containers. */
export function encodeBitplanes(data:Uint8Array,selected:readonly number[]):Uint8Array|null {
 if(data.length>MAX_OUTPUT_BYTES||data.length<8||selected.length!==8)throw Error('无效位平面输入')
 const q=Math.floor(data.length/8),rem=data.length%8,planes:Uint8Array[]=[],compressed:boolean[]=[]
 for(let b=0;b<8;b++){
  const p=packPlane(data,b,q)
  let out:Uint8Array=p,used=false
  if(selected[b]<BITPLANE_SCREEN_THRESHOLD){const candidate=encodeCM(p,'bin',1,1,undefined,0,undefined,undefined,'v20');if(candidate.length+4<q){out=candidate;used=true}}
  planes.push(out);compressed.push(used)
 }
 if(!compressed.some(Boolean))return null
 const size=1+rem+planes.reduce((n,p,i)=>n+p.length+(compressed[i]?4:0),0)
 const out=new Uint8Array(size);let pos=1
 for(let b=0;b<8;b++){
  const p=planes[b];if(compressed[b]){out[0]|=1<<b;const n=p.length;out[pos++]=n&255;out[pos++]=n>>>8&255;out[pos++]=n>>>16&255;out[pos++]=n>>>24&255}
  out.set(p,pos);pos+=p.length
 }
 out.set(data.subarray(q*8),pos);return inheritPayloadModel(out,...planes.filter((_,i)=>compressed[i]))
}

/** `r` in the group dictionary selects the plane model: 1 = legacy byte CM,
 * 2 = bit CM with orders 16 and 16..20 tried per plane. */
export function decodeBitplanes(payload:Uint8Array,n:number,format:number=BITPLANE_BYTE_CM):Uint8Array {
 if(!Number.isSafeInteger(n)||n<8||n>MAX_OUTPUT_BYTES||!payload.length)throw Error('无效位平面长度')
 if(format!==BITPLANE_BYTE_CM&&format!==BITPLANE_BIT_CM)throw Error('未知位平面模型')
 const q=Math.floor(n/8),rem=n%8,mask=payload[0];if(!mask)throw Error('空位平面压缩掩码')
 const pieces:{start:number;length:number;compressed:boolean;lagged:boolean}[]=[];let pos=1
 for(let b=0;b<8;b++){
  const compressed=!!(mask&(1<<b));let length=q,lagged=false
  if(compressed){
   if(payload.length-pos<4)throw Error('位平面长度被截断')
   const rawLength=(payload[pos]|payload[pos+1]<<8|payload[pos+2]<<16|payload[pos+3]<<24)>>>0
   pos+=4
   const bitCM=(rawLength&0x80000000)!==0
   lagged=bitCM&&(rawLength&0x40000000)!==0
   if(bitCM!==(format===BITPLANE_BIT_CM))throw Error('位平面模型标记与分组规则不符')
   length=bitCM?(rawLength&(lagged?0x3fffffff:0x7fffffff)):rawLength
   if(!length||length+4>=q)throw Error('无效位平面压缩长度')
  }
  if(length>payload.length-pos)throw Error('位平面载荷被截断')
  pieces.push({start:pos,length,compressed,lagged});pos+=length
 }
 if(payload.length-pos!==rem)throw Error('位平面载荷长度错误')
 const out=new Uint8Array(n)
 for(let b=0;b<8;b++){
  const entry=pieces[b],p=payload.subarray(entry.start,entry.start+entry.length)
  let plane:Uint8Array
  if(!entry.compressed)plane=p
  else if(format===BITPLANE_BYTE_CM)plane=decodeCM(p,q,'bin',1,1,undefined,'v20')
  else if(entry.lagged)plane=decodeLagPlane(p,q*8,entry.length)
  else {
   plane=decodePlaneBitCM(p,q*8,createBitCMModel(BITPLANE_BIT_ORDERS))
  }
  for(let i=0;i<q*8;i++)out[i]|=((plane[i>>>3]>>>(i&7))&1)<<b
 }
 out.set(payload.subarray(pos),q*8);return out
}

/** P22.2: emergent byte recurrence at a power-of-two lag:
 *   data[i] = data[i-D] + table[i % P]  (mod 256), for all i >= D.
 * The prefix and the small delta table are stored raw; the tail is free. */
export function encodePeriodBytes(data:Uint8Array):Uint8Array|null {
 const n=data.length
 const tried=new Set<number>()
 const tryD=(D:number):Uint8Array|null=>{
  if(D<256||D>=n||tried.has(D))return null
  // A budget may stop *starting* new verifications, never truncate one: a half-verified
  // lag would be a wrong answer, an unverified lag is simply "not chosen". Unbudgeted
  // runs never consult the clock, so their result is bit-identical to before.
  if(deadlineHit())return null
  tried.add(D)
  const sample=Math.min(2048,n-D)
  // Find the delta period on a short sample first; only exact streams reach full verify.
  const d0=new Uint8Array(256)
  for(let i=0;i<256;i++)d0[i]=(data[D+i]-data[i])&255
  let P=0
  for(let p=1;p<=256;p++){
   if(p>=sample)break
   let ok=true
   for(let i=p;i<256;i++)if(d0[i]!==d0[i-p]){ok=false;break}
   if(ok){P=p;break}
  }
  if(!P)return null
  const table=new Uint8Array(P)
  for(let i=0;i<P;i++)table[i]=(data[D+i]-data[i])&255
  for(let i=D;i<n;i++)if(data[i]!==((data[i-D]+table[i%P])&255))return null
  const out=new Uint8Array(5+D+P)
  out[0]=D&255;out[1]=D>>>8&255;out[2]=D>>>16&255;out[3]=D>>>24&255
  out[4]=P&255
  out.set(data.subarray(0,D),5);out.set(table,5+D)
  return out
 }
 for(let k=8;k<=22;k++){const r=tryD(1<<k);if(r)return r;if(deadlineHit())return null}
 // Arbitrary integer D: the lag-1 delta of a P-periodic byte recurrence is itself
 // periodic, so its primitive period p0 divides (or is a multiple of) the true P.
 // Search D = k*p0; this finds non-dyadic integer lags exactly without O(n^2).
 const m=Math.min(8192,n-1),d1=new Uint8Array(m)
 for(let i=0;i<m;i++)d1[i]=(data[i+1]-data[i])&255
 let p0=0
 for(let p=1;p<=256;p++){
  let ok=true
  for(let i=p;i<m;i++)if(d1[i]!==d1[i-p]){ok=false;break}
  if(ok){p0=p;break}
 }
 if(p0){
  for(let D=p0;D<n/2;D+=p0){
   const r=tryD(D);if(r)return r
   if(deadlineHit())return null
  }
 }
 return null
}

export function decodePeriodBytes(payload:Uint8Array,n:number):Uint8Array {
 if(payload.length<5)throw Error('周期字节载荷被截断')
 const D=(payload[0]|payload[1]<<8|payload[2]<<16|payload[3]<<24)>>>0
 const P=payload[4]||256
 if(D<256||D>=n||P<1||P>256||payload.length!==5+D+P)throw Error('无效周期字节载荷')
 const out=new Uint8Array(n);out.set(payload.subarray(5,5+D),0)
 const table=payload.subarray(5+D)
 for(let i=D;i<n;i++)out[i]=(out[i-D]+table[i%P])&255
 return out
}

/** Fixed order set for the r=2 wire format; the encoder must match. */
export const BITPLANE_BIT_ORDERS:readonly number[]=[16,20,24]
