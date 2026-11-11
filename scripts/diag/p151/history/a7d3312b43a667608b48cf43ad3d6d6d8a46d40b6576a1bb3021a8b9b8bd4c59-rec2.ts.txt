import { MAX_OUTPUT_BYTES } from './limits'

export interface Rec2Params { op:number; a:number; b:number }
const WINDOW=2048
function entropy(hist:Uint32Array,n:number):number {let h=0;for(const f of hist)if(f){const p=f/n;h-=p*Math.log2(p)}return h}
function prediction(x:number,y:number,op:number):number {return op===0?x+y:op===1?x-y:op===2?y-x:op===3?-x-y:x^y}
function residual(x:number,a:number,b:number,op:number):number {return op===4?x^a^b:(x-prediction(a,b,op))&255}
function valid(p:Rec2Params):boolean {return Number.isInteger(p.op)&&p.op>=0&&p.op<=4&&Number.isInteger(p.a)&&Number.isInteger(p.b)&&p.a>=1&&p.a<p.b&&p.b<=63}
function score(data:Uint8Array,p:Rec2Params,start:number,h:Uint32Array):{h:number;ratio:number} {
 h.fill(0);let close=0
 for(let i=start;i<start+WINDOW;i++){const r=residual(data[i],data[i-p.a],data[i-p.b],p.op);h[r]++;if(r<=1)close++}
 return {h:entropy(h,WINDOW),ratio:close/WINDOW}
}
/** Fixed search cost: 1953 lag pairs * 5 operations * 2048 training bytes. */
export function detectRec2(data:Uint8Array):Rec2Params|null {
 if(data.length<16384)return null
 const hist=new Uint32Array(256);for(let i=0;i<WINDOW;i++)hist[data[i]]++
 if(entropy(hist,WINDOW)<=7.5)return null
 let best:Rec2Params|null=null,bestH=Infinity
 for(let b=2;b<=63;b++)for(let a=1;a<b;a++)for(let op=0;op<5;op++){
  const p={op,a,b},fit=score(data,p,63,hist)
  if(fit.h<bestH){bestH=fit.h;best=p}
 }
 if(!best)return null
 const fit=score(data,best,63,hist),tail=score(data,best,data.length-WINDOW,hist)
 const pass=(s:{h:number;ratio:number})=>s.ratio>0.8||s.h<5
 return pass(fit)&&pass(tail)?best:null
}
/** Decoded transform stream is exactly raw output length + 3 bytes:
 * [op,a,b, first b raw seed bytes, remaining residuals]. */
export function rec2Forward(data:Uint8Array,p:Rec2Params):Uint8Array {
 if(!valid(p)||data.length<p.b||data.length>MAX_OUTPUT_BYTES-3)throw Error('无效 REC2 参数或长度')
 const out=new Uint8Array(data.length+3);out[0]=p.op;out[1]=p.a;out[2]=p.b;out.set(data.subarray(0,p.b),3)
 for(let i=p.b;i<data.length;i++)out[3+i]=residual(data[i],data[i-p.a],data[i-p.b],p.op)
 return out
}
export function rec2Inverse(stream:Uint8Array,n:number):Uint8Array {
 if(!Number.isSafeInteger(n)||n<0||n>MAX_OUTPUT_BYTES-3||stream.length!==n+3||stream.length<3)throw Error('无效 REC2 长度')
 const p={op:stream[0],a:stream[1],b:stream[2]}
 if(!valid(p)||n<p.b||stream.length<3+p.b)throw Error('无效 REC2 参数或种子')
 const out=new Uint8Array(n);out.set(stream.subarray(3,3+p.b))
 for(let i=p.b;i<n;i++)out[i]=p.op===4?stream[3+i]^out[i-p.a]^out[i-p.b]:(stream[3+i]+prediction(out[i-p.a],out[i-p.b],p.op))&255
 return out
}
