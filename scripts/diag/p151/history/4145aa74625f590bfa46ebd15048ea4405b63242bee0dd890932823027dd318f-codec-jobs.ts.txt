// 供并行任务使用的纯函数入口。
//
// 这里的三个函数直接转发到 codec.ts 的内部同步实现，主线程与 worker 用的是
// 同一份代码，因此结果逐字节一致；区别只在于不做进度回调（worker 里没有 UI）。
import { chooseSpecSync, encodeGroupSync, encodeSpecsSync, groupV15CandidatesSync, CLS_BY_CODE, type Spec, type Trial } from './codec'
import type { GroupCandidate, SpecData, TrialData } from './parallel'
import type { GroupCandidateOptions } from './group-policy'
import { payloadModelFlags } from './payload-model'

const toSpec = (d: SpecData): Spec => ({ id: d.id, s: d.s, r: d.r })
const fromTrial = (t: Trial): TrialData => ({
  spec: { id: t.spec.id, s: t.spec.s, r: t.spec.r },
  ratio: t.ratio,
  payloadSize: t.payloadSize ?? 0,
  sampleLen: t.sampleLen ?? 0,
  sampleStart: t.sampleStart,
  sampleStarts: t.sampleStarts,
  probeSize: t.probeSize,
  probeLen: t.probeLen,
  fullSize: t.fullSize,
  modelFlags: t.modelFlags,
})

export function chooseSpecForJob(
  seg: Uint8Array, cls: number, bestS: number, sampleLimit: number, base: number, inputBytes = seg.length,
): { kind: 'chooseSpec'; spec: SpecData; trials: TrialData[] } {
  // 类别必须还原成字符串：analyze/detectAnchors 里用的是 `cls === 'text'` 这样的
  // 精确比较，传数字码会静默走另一条分支（anchor 模式位会从 0 变成 128）。
  const name = CLS_BY_CODE[cls]
  if (!name) throw new Error(`未知区域类别码 ${cls}`)
  const { spec, trials } = chooseSpecSync(seg, name, bestS, sampleLimit, base, inputBytes)
  return {
    kind: 'chooseSpec',
    spec: { id: spec.id, s: spec.s, r: spec.r },
    trials: trials.map(fromTrial),
  }
}

export function encodeGroupForJob(
  parts: Uint8Array[], spec: SpecData, positions: number[], ends: number[], skipBase = false, options?:GroupCandidateOptions,
): { kind: 'encodeGroup'; bytes: Uint8Array; modelFlags: number; cost: Float32Array; fragments: number; cand: GroupCandidate | null } {
  // 成本仓必须与主线程逐位一致：按同样的逻辑块边界重建一次（ends 由主线程算好传进来）。
  const cost = new Float32Array(skipBase ? 0 : ends.length)
  const sp = toSpec(spec)
  const bytes = skipBase ? new Uint8Array(0) : encodeGroupSync(parts, sp, positions, { values: cost, blockSize: 512, ends: Uint32Array.from(ends) })
  // P4-3：v15 / WORD-PRE 候选就在同一个任务里算好。主线程拿到后只做择优，
  // 因此分组编码阶段不再有"worker 一遍 v13 + 主线程一遍 v15"的双倍串行耗时。
  const cand = groupV15CandidatesSync(parts, sp, positions,options)
  return {
    kind: 'encodeGroup', bytes, modelFlags: payloadModelFlags(bytes), cost, fragments: ends.length,
    cand: cand ? { spec: { id: spec.id, s: spec.s, r: spec.r }, alt: cand.alt, wordPre: cand.wordPre, rawLen: cand.rawLen,
      screening:cand.screening,variants:cand.variants,v20:cand.v20,wordPreV20:cand.wordPreV20,v20Flags:cand.v20?payloadModelFlags(cand.v20):0,wordPreV20Flags:cand.wordPreV20?payloadModelFlags(cand.wordPreV20):0,
      altFlags: cand.alt ? payloadModelFlags(cand.alt) : 0, wordPreFlags: cand.wordPre ? payloadModelFlags(cand.wordPre) : 0 } : null,
  }
}

export function encodeSpecsForJob(seg: Uint8Array, specs: SpecData[], base: number): { kind: 'encodeSpecs'; sizes: number[] } {
  return { kind: 'encodeSpecs', sizes: encodeSpecsSync(seg, specs.map(toSpec), base) }
}
