// In-memory audit variants only. NEVER writes src/lib or any production bundle.
import assert from 'node:assert/strict'
const once=(s,a,b)=>{assert.equal(s.split(a).length-1,1,'Patch anchor changed: '+a.slice(0,80));return s.replace(a,b)}
export function coderPatch(source,variant){
 let s=source
 if(variant==='word-ascii'||variant==='word-bin'){
  s=once(s,'else if (asciiLetter) this.curWord =','else if (asciiLetter || (byte >= 48 && byte <= 57) || byte === 95) this.curWord =')
  if(variant==='word-bin'){
   s=once(s,"if (this.profile === 'text' && this.variant) {","if ((this.profile === 'text' || this.profile === 'bin') && this.variant) {")
   s=once(s,'H[6]=hh(b3,b4);H[7]=hh(b1,b4)','H[6]=hh(this.curWord,b1);H[7]=hh(this.prevWord,this.curWord||b1)')
  }
 }else if(variant==='sparse24'){
  s=once(s,'H[6]=hh(b3,b4);H[7]=hh(b1,b4)','H[6]=hh(b2,b4);H[7]=hh(b1,b4)')
 }else if(variant==='phase4'){
  s=once(s,'H[6]=hh(b3,b4);H[7]=hh(b1,b4)','H[6]=hh(b3,b4);H[7]=hh(this.pos&3,b1,b4)')
 }else if(variant==='no-words'){
  s=once(s,'      let ms = 0\n','      inputs[6] = 0; inputs[7] = 0 // diagnostic joint ablation\n      let ms = 0\n')
 }else if(variant==='confirm4'){
  s=once(s,'          if (cand > 0) {','          if (cand >= 4 && buf[cand-1]===buf[pos-1] && buf[cand-2]===buf[pos-2] && buf[cand-3]===buf[pos-3] && buf[cand-4]===buf[pos-4]) {')
 }else if(variant==='min6'){
  s=once(s,'this.minLen = profile === \'text\' && !v3 ? 5 : 4','this.minLen = v3 ? 6 : profile === \'text\' ? 5 : 4')
 }else if(variant==='gap2'||variant==='gap-distance'){
  s=once(s,'this.lastDist = pos - this.mptr','this.lastDist = pos - 1 - this.mptr')
  if(variant==='gap2')s=once(s,'if (cand >= 1 && buf[cand - 1] === buf[pos - 1])','if (cand >= 2 && buf[cand - 1] === buf[pos - 1] && buf[cand - 2] === buf[pos - 2])')
 }else if(variant==='pre-apm-gradient'){
  s=once(s,'const err = ((y << 12) - (prOverride ?? this.pr)) * 8','const err = ((y << 12) - (prOverride ?? this.lastPr)) * 8')
  s=once(s,'const err3 = ((y << 12) - (prOverride ?? this.pr)) * mixer2Tuning.lr2','const err3 = ((y << 12) - (prOverride ?? this.lastPr)) * mixer2Tuning.lr2')
 }else if(!['base','attrib','a1-ms','mixer2-off','gap-on'].includes(variant))throw Error('Unknown CM audit variant: '+variant)
 if(variant==='attrib'){
  s=once(s,'    if (encode) {\n','    if (encode) {\n      ;(globalThis as any).__P12_BIT?.(this, y, pr, mIdx, mExpect)\n')
  s=once(s,'\n            if (this.matchStats) this.matchStats.candidatesChecked++','\n            ;(globalThis as any).__P12_MATCH4?.(l, this.minLen)\n            if (this.matchStats) this.matchStats.candidatesChecked++')
 }
 return s
}
