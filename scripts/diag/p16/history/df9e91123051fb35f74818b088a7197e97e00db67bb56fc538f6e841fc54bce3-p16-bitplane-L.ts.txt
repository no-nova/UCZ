import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {bitplaneEntropyGate,bitplaneStoreTrigger,bitplaneFullProof,encodeBitplanesBitCM,decodeBitplanes,BITPLANE_BIT_CM} from '../src/lib/bitplane'
import {compressAdaptive,decompress} from '../src/lib/codec'

// Deterministic bounded proxy for the AITDCC/L shape: planes 0..3 are driven by a
// 20-bit LFSR (real order-16..20 structure), planes 4..7 are xorshift noise.
// This is NOT L and its numbers are NOT a prediction for L.
function lfsr20(n:number,noisePct:number){
  let s=0x9e3779b9>>>0,x=0x2545f4914f6cdd1d
  const out=new Uint8Array(n),r=new Uint8Array(n)
  for(let i=0;i<n;i++){x^=x<<13;x^=x>>>7;x^=x<<17;r[i]=x&255}
  const noise=noisePct/100
  for(let i=0;i<n;i++){
    let v=0
    for(let b=0;b<8;b++){
      let bit
      if(b<4){bit=((s>>>15)^(s>>>13)^(s>>>12)^(s>>>10))&1;if(r[i]/256<noise)bit^=1;s=((s<<1)|bit)&0xfffff}
      else bit=(r[i]>>>(b-4))&1
      v|=bit<<b
    }
    out[i]=v
  }
  return out
}
function sha256Stream(n:number){
  const out=new Uint8Array(n)
  for(let off=0,c=0;off<n;off+=32,c++)out.set(createHash('sha256').update(Buffer.from([c&255,(c>>>8)&255,(c>>>16)&255])).digest().subarray(0,Math.min(32,n-off)),off)
  return out
}
const [size='204800',pct='2']=process.argv.slice(2),n=Number(size)
const tAdaptive=performance.now()
const data=lfsr20(n,Number(pct)),rand=sha256Stream(n)
async function main(){
 // plane-level: bit CM must beat raw on low planes, must not on noise planes
 const screen=bitplaneFullProof(data),randScreen=bitplaneFullProof(rand)
 const payload=encodeBitplanesBitCM(data,screen.proof,screen.coded)
 assert.ok(payload,'expected a bit-plane payload')
 const round=decodeBitplanes(payload,data.length,BITPLANE_BIT_CM)
 assert.ok(Buffer.from(round).equals(Buffer.from(data)),'plane payload roundtrip')
 // random control: no plane may be adopted
 assert.equal(randScreen.proof.filter(Boolean).length,0,'random planes must not be adopted')
 assert.equal(encodeBitplanesBitCM(rand,randScreen.proof,randScreen.coded),null)
 const noiseOnly=lfsr20(n,0).subarray(0,0)
 // end-to-end: baseline is STORE, bit-plane must win strictly
 const out=await compressAdaptive(data,undefined,{serial:true})
 assert.ok(Buffer.from(decompress(out.container)).equals(Buffer.from(data)),'adaptive roundtrip')
 const randOut=await compressAdaptive(rand,undefined,{serial:true})
 assert.ok(Buffer.from(decompress(randOut.container)).equals(Buffer.from(rand)),'random roundtrip')
 assert.ok(out.container.length<data.length,'must be strictly smaller than STORE')
 const adaptiveMs=Math.round(performance.now()-tAdaptive)
 console.log(JSON.stringify({n,noisePct:Number(pct),adaptiveMs,secPerMiB:+(adaptiveMs/1000/(n/1048576)).toFixed(2),
   gate:{entropy:bitplaneEntropyGate(data),store:bitplaneStoreTrigger(data.length,data.length)},
   proof:screen.proof,proofMs:screen.ms,codedBytes:screen.coded.map(x=>x.length),
   payloadBytes:payload.length,adaptive:{id:out.segs[0]?.spec.id,r:out.segs[0]?.spec.r,ver:out.container[3],bytes:out.container.length,ratio:+(out.container.length/data.length).toFixed(4),sha256:createHash('sha256').update(out.container).digest('hex').slice(0,16)},
   random:{proof:randScreen.proof.some(Boolean),id:randOut.segs[0]?.spec.id,bytes:randOut.container.length,unchanged:randOut.container.length===n+18}}))
}
main().catch(e=>{console.error(e);process.exitCode=1})
