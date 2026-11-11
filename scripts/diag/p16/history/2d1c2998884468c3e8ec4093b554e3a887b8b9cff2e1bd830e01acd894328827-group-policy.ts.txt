// P13 candidate scheduling only. Probes may omit a candidate, never authorize
// adoption: the caller must retain and compare the real full base stream.
export type GroupKernel = 'v15' | 'v20'
export const GROUP_KERNEL_MIN_BYTES = 256 * 1024
export const GROUP_KERNEL_PROBE_BYTES = 192 * 1024
export const GROUP_KERNEL_MIN_GAIN = 0.0015
export const BCJ_UPGRADE_MIN_BYTES = 32 * 1024
export interface GroupCandidateOptions { allowBcjUpgrade?: boolean; screen?: boolean }
export interface KernelVariant {
  spec: { id:number; s:number; r:number }
  kernel: GroupKernel
  payload: Uint8Array
  flags: number
}
export interface KernelScreen {
  kind: 'raw' | 'wordpre'
  sampleBytes: number
  trials: { kernel: GroupKernel; spec: { id:number; s:number; r:number }; bytes: number | null }[]
  selected: number[]
  fullBytes: number
  /** WORD-PRE admission only: these are body-only prefix CM costs, not
   * complete-container prices. Full dictionary/framing is charged at adoption. */
  wordPreGate?: {
    policy: 'p12-contiguous-body'
    dictionaryBytes: number
    rawPrefixBytes: number
    tokenPrefixBytes: number
    eligible: number[]
    plainBytes: (number | null)[]
    bodyBytes: (number | null)[]
  }
}

/** Clear >=0.15% win => one full candidate. Ambiguity retains all eligible
 * candidates; invalid/absent trials can never win. Stable order resolves ties. */
export function clearProbeWinners(costs: readonly (number | null)[]): number[] {
  const eligible=costs.map((n,i)=>({n,i})).filter((x):x is {n:number;i:number}=>typeof x.n==='number'&&Number.isFinite(x.n)&&x.n>0)
    .sort((a,b)=>a.n-b.n||a.i-b.i)
  if(eligible.length<2)return eligible.map(x=>x.i)
  return eligible[1].n-eligible[0].n>=eligible[1].n*GROUP_KERNEL_MIN_GAIN
    ? [eligible[0].i] : eligible.map(x=>x.i).sort((a,b)=>a-b)
}

/** Head/middle/tail of the logical ordered group, <=192 KiB total. Retains real
 * region seams and original absolute positions (BCJ), never transforms across
 * invented boundaries. Alignment is relative to each original region. */
export function groupKernelSample(parts: readonly Uint8Array[], positions: readonly number[], alignment=1,
  budget=GROUP_KERNEL_PROBE_BYTES): {parts:Uint8Array[];positions:number[];bytes:number} {
  if(!Number.isSafeInteger(alignment)||alignment<1||!Number.isSafeInteger(budget)||budget<3*alignment)throw Error('无效分组内核探针预算')
  const n=parts.reduce((sum,p)=>sum+p.length,0)
  if(n<=budget)return {parts:[...parts],positions:parts.map((_,i)=>positions[i]??0),bytes:n}
  const take=Math.floor(budget/3/alignment)*alignment
  const starts=[0,Math.floor((n-take)/2/alignment)*alignment,n-take]
  const out:Uint8Array[]=[],absolute:number[]=[]
  for(const start of starts) {
    let logical=0
    for(let i=0;i<parts.length;i++) {
      const part=parts[i],lo=Math.max(0,start-logical),hi=Math.min(part.length,start+take-logical)
      if(hi>lo) {
        const a=Math.ceil(lo/alignment)*alignment,b=Math.floor(hi/alignment)*alignment
        if(b>a){out.push(part.subarray(a,b));absolute.push((positions[i]??0)+a)}
      }
      logical+=part.length
      if(logical>=start+take)break
    }
  }
  return {parts:out,positions:absolute,bytes:out.reduce((sum,p)=>sum+p.length,0)}
}
