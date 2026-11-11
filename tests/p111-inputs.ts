/** Deterministic small inputs, shared by immutable historical-reference generation
 * and current-code tests. No corpus and no actual input over 48 KiB. */
import e24 from './e24-v17-fixture.json'
export function compatibilityInputs() {
  const prose = new TextEncoder().encode('A small packet carries words, numbers, and repeated context. The decoder must recover every byte exactly. Versioned models keep the stream unambiguous.\n')
  const text = Uint8Array.from({length:49152},(_,i)=>prose[i%prose.length])
  const periodic = Uint8Array.from({length:32768},(_,i)=>(i*7+(i>>>8))&63)
  let seed=0x12345678
  const mixed=Uint8Array.from({length:40960},(_,i)=>{
    seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5
    return i<16384?seed&255:i<38912?prose[(i-16384)%prose.length]:0
  })
  const many=Uint8Array.from({length:16480},(_,i)=>(i*11+(i>>>5))&127)
  const p=(start:number,end:number,id:number,s=1)=>({start,end,cls:'binary' as const,spec:{id,s,r:1}})
  return [
    {name:'guarded-wordpre',data:Uint8Array.from({length:e24.n},(_,i)=>e24.phrase.charCodeAt(i%e24.phrase.length)),picks:[p(0,e24.n,23)]},
    {name:'adaptive-prose',data:text},
    {name:'adaptive-periodic',data:periodic},
    {name:'adaptive-mixed',data:mixed},
    {name:'guarded-orphans',data:periodic,picks:[p(0,20000,24),p(20000,28192,6,2),p(28192,30240,0),p(30240,31264,2),p(31264,32768,3)]},
    {name:'guarded-many-rules',data:many,picks:[p(0,12000,24),...Array.from({length:70},(_,i)=>p(12000+i*64,12064+i*64,6,i+1))]},
  ]
}
export function rawCompatibilityInput() {
  return Uint8Array.from({length:128},(_,i)=>(i*23+(i>>3))&255)
}
