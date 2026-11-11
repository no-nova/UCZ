import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {encodeCM,decodeCM,withCMBlockSize} from '../src/lib/coder'
import {detectRec2} from '../src/lib/rec2'
const mode=process.argv[2]??'structured',n=262144,bytes=new Uint8Array(n)
let rng=0x918ab73d;const rand=()=>{rng^=rng<<13;rng^=rng>>>17;rng^=rng<<5;return rng>>>0}
const state=[0x1a213,0x2b721,0x4c331],degrees=[17,18,19],taps=[3,7,5]
for(let i=0;i<n;i++){
 let v=rand()&255
 if(mode==='structured'||mode==='forced')for(let p=0;p<3;p++){const bit=state[p]&1;v=(v&~(1<<p))|(bit<<p);state[p]=(state[p]>>>1)|(((state[p]^(state[p]>>>taps[p]))&1)<<(degrees[p]-1))}
 bytes[i]=v
}
const hist=new Uint32Array(256);for(let i=0;i<2048;i++)hist[bytes[i]]++;let h0=0;for(const k of hist)if(k){const p=k/2048;h0-=p*Math.log2(p)}
assert.ok(h0>7.5);const rec2=detectRec2(bytes);assert.equal(rec2,null)
// Causal prequential Laplace counts, not in-sample plug-in entropy.
const start=performance.now(),sample=65536,history=20,mask=(1<<history)-1,screen=[]
for(let b=0;b<8;b++){
 const zeros=new Uint32Array(1<<history),ones=new Uint32Array(1<<history);let h=0,cost=0
 for(let i=0;i<sample;i++){const bit=bytes[i]>>>b&1;if(i>=history){const z=zeros[h],o=ones[h];cost-=Math.log2(((bit?o:z)+1)/(z+o+2));if(bit)ones[h]++;else zeros[h]++}h=(h<<1|bit)&mask}
 screen.push(cost/(sample-history))
}
const screenMs=performance.now()-start,q=n/8,planes=[];for(let b=0;b<8;b++){const plane=new Uint8Array(q);for(let i=0;i<n;i++)plane[i>>>3]|=((bytes[i]>>>b)&1)<<(i&7);planes.push(plane)}
const packed=planes.map(x=>x),rows=[]
for(let b=0;b<8;b++)if(screen[b]<0.965||(mode==='forced'&&b<3)){const p=withCMBlockSize(n,()=>encodeCM(planes[b],'bin',1,1,undefined,0,undefined,undefined,'v20'));assert.deepEqual(withCMBlockSize(n,()=>decodeCM(p,q,'bin',1,1,undefined,'v20')),planes[b]);if(p.length<q-8)packed[b]=p;rows.push({plane:b,raw:q,payload:p.length,selected:packed[b]===p})}
const out=new Uint8Array(n);for(let b=0;b<8;b++){const p=packed[b]===planes[b]?packed[b]:withCMBlockSize(n,()=>decodeCM(packed[b],q,'bin',1,1,undefined,'v20'));for(let i=0;i<n;i++)out[i]|=((p[i>>>3]>>>(i&7))&1)<<b}
assert.deepEqual(out,bytes)
const framed=1+packed.reduce((sum,p,b)=>sum+p.length+(p===planes[b]?0:4),0)
console.log(JSON.stringify({mode,inputBytes:n,inputSha256:createHash('sha256').update(bytes).digest('hex'),h0,rec2,history,sampleBytes:sample,causalBits:screen,screenMs,rows,framedBytes:framed,rawBytes:n,roundtrip:true,scope:'experimental plane framing only; not a UCZ container; deterministic xorshift is not crypto random'}))
