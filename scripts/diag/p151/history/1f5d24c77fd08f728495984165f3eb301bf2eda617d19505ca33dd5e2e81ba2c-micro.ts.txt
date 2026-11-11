// Five-byte, per-region ridge-regularized OLS predictor. The model predicts
// bytes, not signed 16-bit samples. Integer-only prediction makes decoding
// independent of how the floating-point fit was computed.
export const MICRO_SEED_BYTES = 5
export const MICRO_SCALE = 32
const FEATURES = 5
const MAX_FIT_SAMPLES = 4096
function check(s:number,r:number) {
  if(!Number.isInteger(s)||s<1||s>16||!Number.isInteger(r)||r<1||r>4096) throw Error('无效微种子预测参数')
}
function features(d:Uint8Array,i:number,s:number,r:number):number[] {
  return [i>=s?d[i-s]:0, i>=r?d[i-r]:0, i>=r+s?d[i-r-s]:0, i>=2*s?d[i-2*s]:0, 32]
}
export function fitMicroSeed(data:Uint8Array,s:number,r:number):Uint8Array {
  check(s,r)
  const seed=new Uint8Array(FEATURES), start=Math.min(data.length,Math.max(r+s,2*s)), span=data.length-start
  if(span<16) {seed[0]=MICRO_SCALE;return seed}
  const count=Math.min(MAX_FIT_SAMPLES,span), matrix=Array.from({length:FEATURES},()=>new Float64Array(FEATURES+1))
  for(let j=0;j<count;j++) {
    const i=start+Math.floor((j+0.5)*span/count), x=features(data,i,s,r), y=data[i]
    for(let a=0;a<FEATURES;a++) { for(let b=0;b<FEATURES;b++) matrix[a][b]+=x[a]*x[b]; matrix[a][FEATURES]+=x[a]*y }
  }
  // A small ridge term prevents singular or nearly collinear neighborhoods.
  let maxDiag=0;for(let i=0;i<FEATURES;i++) maxDiag=Math.max(maxDiag,matrix[i][i])
  const ridge=Math.max(1,maxDiag*0.0001)
  for(let i=0;i<FEATURES;i++) matrix[i][i]+=ridge
  for(let col=0;col<FEATURES;col++) {
    let pivot=col;for(let j=col+1;j<FEATURES;j++) if(Math.abs(matrix[j][col])>Math.abs(matrix[pivot][col])) pivot=j
    if(pivot!==col) [matrix[col],matrix[pivot]]=[matrix[pivot],matrix[col]]
    const divisor=matrix[col][col]
    if(!Number.isFinite(divisor)||Math.abs(divisor)<1e-9) {seed[0]=MICRO_SCALE;return seed}
    for(let k=col;k<=FEATURES;k++) matrix[col][k]/=divisor
    for(let j=0;j<FEATURES;j++) if(j!==col) {const mul=matrix[j][col];for(let k=col;k<=FEATURES;k++) matrix[j][k]-=mul*matrix[col][k]}
  }
  for(let i=0;i<FEATURES;i++) {
    const v=matrix[i][FEATURES]
    if(!Number.isFinite(v)) {seed.fill(0);seed[0]=MICRO_SCALE;return seed}
    seed[i]=Math.max(-128,Math.min(127,Math.round(v*MICRO_SCALE)))&255
  }
  return seed
}
export function microWeights(seed:Uint8Array):number[] {
  if(seed.length!==MICRO_SEED_BYTES) throw Error('微种子长度错误')
  return Array.from(seed,b=>(b<128?b:b-256)/MICRO_SCALE)
}
function predict(d:Uint8Array,i:number,s:number,r:number,w:number[]):number {
  const sum=w[0]*(i>=s?d[i-s]:0)+w[1]*(i>=r?d[i-r]:0)+w[2]*(i>=r+s?d[i-r-s]:0)+w[3]*(i>=2*s?d[i-2*s]:0)+w[4]*32
  return Math.max(0,Math.min(255,Math.round(sum/MICRO_SCALE)))
}
function signed(seed:Uint8Array):number[] {
  if(seed.length!==MICRO_SEED_BYTES) throw Error('微种子长度错误')
  return Array.from(seed,b=>b<128?b:b-256)
}
export function microFwd(data:Uint8Array,s:number,r:number,seed:Uint8Array):Uint8Array {
  check(s,r);const w=signed(seed),out=new Uint8Array(data.length)
  for(let i=0;i<data.length;i++) out[i]=(data[i]-predict(data,i,s,r,w))&255
  return out
}
export function microInv(residual:Uint8Array,s:number,r:number,seed:Uint8Array):Uint8Array {
  check(s,r);const w=signed(seed),out=new Uint8Array(residual.length)
  for(let i=0;i<residual.length;i++) out[i]=(residual[i]+predict(out,i,s,r,w))&255
  return out
}
