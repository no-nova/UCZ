import { readFileSync } from 'node:fs'
// Exact patches only inside a disposable lib copy. Every patch is in receipts.
export function patchLibrary(patch,read) {
 patch('coder.ts',"import { ByteWriter } from './byte-writer'",`import { ByteWriter } from './byte-writer'
export const p15 = {binStride:false,textContext:'control',resContext:'control'}
`)
 patch('coder.ts','class Model {','class Model {\n  p15Peer?:Model\n  p15NumHash=0; p15NumLen=0; p15Field=0; p15ClassHist=0; p15PunctDistance=0\n'+`
  private p15TextHash(old:number,b1:number,b2:number,b3:number,b4:number):number {
    switch(p15.textContext) {
      case 'numfield':return this.p15NumLen>0||b1===58 ? hh(this.p15NumHash&4095,this.p15NumLen&15,this.p15Field&7,b1) : old
      case 'numclass':return this.p15NumLen>0||b1===58 ? hh(this.p15ClassHist&511,b1,this.p15NumLen&15,this.p15Field&7) : old
      case 'puncword':return hh(this.p15ClassHist&63,this.curWord||this.prevWord,Math.min(15,this.p15PunctDistance))
      case 'sparse5':return hh(b1,b3,this.g(5))
      case 'control':return old
      default:throw Error('unknown P15 text experiment')
    }
  }
`)
 patch('coder.ts','wordTokens = false, options?: CMOptions) {\n    this.context = options?.context','wordTokens = false, options?: CMOptions, p15Peer?:Model) {\n    this.p15Peer=p15Peer\n    if(p15Peer)this.msm=p15Peer.msm\n    this.context = options?.context')
 patch('coder.ts','    this.buf = new Uint8Array(n + 1)','    this.buf = p15Peer?.buf ?? new Uint8Array(n + 1)')
 patch('coder.ts','      this.tables.push(new Uint32Array(1 << bits).fill(32768 << 16))','      this.tables.push(p15Peer && i<8 ? p15Peer.tables[i] : new Uint32Array(1 << bits).fill(32768 << 16))')
 patch('coder.ts','    this.mht = new Int32Array(this.useMatch ? 1 << mhBits : 1)','    this.mht = p15Peer?.mht ?? new Int32Array(this.useMatch ? 1 << mhBits : 1)')
 patch('coder.ts','      this.mht8 = new Int32Array(1 << mh8Bits)','      this.mht8 = p15Peer?.mht8 ?? new Int32Array(1 << mh8Bits)')
 const original=`      for (let i = 0; i < nctx; i++) {
        let h = Math.imul(hashes[i] ^ cm, 0x85ebca6b)
        h ^= h >>> 15
        idx[i] = h >>> shift
      }
      for (let i = 0; i < nctx; i++) {
        inputs[i] = STRETCH_l[(tables[i][idx[i]] >>> 16) >>> 4]
      }`
 patch('coder.ts',original,`      const peer=this.p15Peer,first=peer?8:0
      if(peer)for(let i=0;i<8;i++){idx[i]=peer.idx[i];inputs[i]=peer.inputs[i]}
      for (let i = first; i < nctx; i++) {
        let h = Math.imul(hashes[i] ^ cm, 0x85ebca6b)
        h ^= h >>> 15
        idx[i] = h >>> shift
      }
      for (let i = first; i < nctx; i++) {
        inputs[i] = STRETCH_l[(tables[i][idx[i]] >>> 16) >>> 4]
      }`)
 const source=read('coder.ts'),begin=source.indexOf('  learn(y: number, prOverride?: number): void {'),end=source.indexOf('\n  p(): number {',begin)
 if(begin<0||end<begin)throw Error('learn method anchors')
 const old=source.slice(begin,end),changed=old.replace('for (let i = 0; i < nctx; i++) {','for (let i = this.p15Peer ? 8 : 0; i < nctx; i++) {').replace('if (mi >= 0) {','if (mi >= 0 && !this.p15Peer) {')
 patch('coder.ts',old,changed)
 patch('coder.ts','    if (this.useMatch) {\n      const buf = this.buf',`    if (this.p15Peer) {
      const p=this.p15Peer
      this.mlen=p.mlen;this.mptr=p.mptr;this.mbyte=p.mbyte;this.lastDist=p.lastDist;this.gapLeft=p.gapLeft
    } else if (this.useMatch) {
      const buf = this.buf`)
 patch('coder.ts','  private byteUpdate(byte: number) {',`  private byteUpdate(byte: number) {
    if(p15.textContext!=='control'&&(this.profile==='text'||this.profile==='bin')) {
      const digit=byte>=48&&byte<=57
      if(digit){this.p15NumHash=(Math.imul(this.p15NumHash,257)+byte-47)>>>0;this.p15NumLen++}
      else {this.p15NumHash=0;this.p15NumLen=0}
      if(byte===10)this.p15Field=0;else if(byte===58)this.p15Field++
      this.p15ClassHist=((this.p15ClassHist<<3)|charClass8(byte))&4095
      const lower=byte|32,alnum=digit||(lower>=97&&lower<=122)
      this.p15PunctDistance=alnum?Math.min(63,this.p15PunctDistance+1):0
    }`)
 const textExpr="H[8]=this.context === 'wp-token3' ? hh(this.prevPrevWord,this.prevWord,this.curWord||b1) : hh(b1,b3,b4);return"
 patch('coder.ts',textExpr,textExpr.replace(';return',";if(this.isV20&&!this.wordTokens&&p15.textContext!=='control')H[8]=this.p15TextHash(H[8],b1,b2,b3,b4);return"))
 patch('coder.ts','        if(this.isV20)this.computeGeometry(b1,b2)\n        return',`        if(this.isV20)this.computeGeometry(b1,b2)
        if(this.isV20&&p15.binStride)H[8]=hh(b4,this.g(8),this.g(12),this.pos&3)
        if(this.isV20&&p15.textContext!=='control')H[8]=this.p15TextHash(H[8],b1,b2,b3,b4)
        return`)
 patch('coder.ts','if(this.isV20)this.computeGeometry(b1,b2); return',"if(this.isV20)this.computeGeometry(b1,b2); if(this.isV20&&p15.resContext==='gradclass')H[8]=hh(phase,QV[gs],QV[gr],QV[(gs-gr)&255]); return")
 patch('coder.ts','  const n = data.length\n  const m = new Model(n, profile, s, r, variant, geomStride, matchExperiment, matchStats, wordTokens, options)','  const n = data.length\n  if(n>524288)throw Error("P15 CM input cap")\n  const m = new Model(n, profile, s, r, variant, geomStride, matchExperiment, matchStats, wordTokens, options)')
 patch('coder.ts','  const m = new Model(n, profile, s, r, variant, geomStride, matchExperiment, undefined, wordTokens, options)','  if(n>524288)throw Error("P15 CM decode cap")\n  const m = new Model(n, profile, s, r, variant, geomStride, matchExperiment, undefined, wordTokens, options)')
 patch('coder.ts',"export type CMVariant = boolean | 'v13' | 'v15' | 'v20'",readFileSync('scripts/diag/p15/dual-append.ts','utf8')+"\nexport type CMVariant = boolean | 'v13' | 'v15' | 'v20'")
 // These exports expose existing pure helpers only in the isolated audit copy.
 for(const name of ['gatherGroup','groupDelta','planColumnGroups','encodeGroupData','encodeGroupedTranspose'])patch('codec.ts',`function ${name}(`,`export function ${name}(`)
}
