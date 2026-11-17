import { groupKernelSample, clearProbeWinners, GROUP_KERNEL_MIN_BYTES, GROUP_KERNEL_PROBE_BYTES, BCJ_UPGRADE_MIN_BYTES, type GroupKernel, type KernelScreen, type KernelVariant, type GroupCandidateOptions } from './group-policy'
import { ByteWriter } from './byte-writer'
import { V21_FLAG_CONTEXTS, GROUP_CONTEXT_MASK, GROUP_CONTEXT_EXT_BIT, GROUP_MATCH_DIST_BIT, GROUP_CONTEXT_SHIFT, contextCodeOf, contextFromGroupBits, contextUpgradeWins, CONTEXT_MIN_BYTES, CONTEXT_SCREEN_MIN_BYTES, CONTEXT_PROBE_BYTES, type CMContext, type CMOptions } from './context-policy'
import { payloadModelFlags, markPayloadModel, inheritPayloadModel } from './payload-model'
import { MAX_SINGLE_CM_BYTES, MAX_OUTPUT_BYTES } from './limits'
import { detectRec2, rec2Forward, rec2Inverse } from './rec2'
import { bitplaneEntropyGate, bitplaneStoreTrigger, bitplaneFullProof, encodeBitplanesBitCM, BITPLANE_BYTE_CM, BITPLANE_BIT_CM, BITPLANE_PERIOD_CM, decodeBitplanes, encodePeriodBytes, decodePeriodBytes } from './bitplane'
import { encodeTranspose2d, decodeTranspose2d } from './transpose2d'
import { fitMicroSeed, microFwd, microInv, microWeights, MICRO_SEED_BYTES } from './micro'
import { encodePeeledTranspose, decodePeeledTranspose, encodePeeledAnchor, decodePeeledAnchor, inspectPeeledTranspose, inspectPeeledAnchor, type SubPeelInfo, type AnchorSubInfo } from './sub-peel'
import { encodeAnchor, decodeAnchor, anchorRowCount, anchorPotential, MAX_ANCHOR_ROWS } from './anchor'
import { analyze, detectAnchors, detectLagCandidates, detectRecordStride, detectWide16Lag, BLOCK, type Analysis, type Cls } from './analyze'
import { crc32c, crcTrailer, readCrcTrailer, containerHasChecksum } from './container'
import {
  type CompressionLevel,
  currentCompressionLevel,
  deadlineClear,
  deadlineHit,
  deadlineSet,
  pruningLevel,
  setActiveCompressionLevel,
} from './planner'
import { encodeCM, decodeCM, encodeCMDual, encodeCMContextDual, a2Suppress, transposeInnerSuppress, encodingModelFlags, withContainerModel, withCMBlockSize, withCMProbe, HUGE_CM_MIN_BYTES, V20_FLAG_TRANSFORMS, V20_FLAG_CM, V22_FLAG_MATCH_DISTANCE, isAPMKernel, cmV20Tuning, cmV22Tuning, transformsV20Enabled, modelTuning, a2Tuning, setStrictPriors, strictPriorsOn, setContainerChecksum, containerChecksumOn, type CostBins, type CMVariant, type Profile } from './coder'
import { wordPreFwdSampled, wordPreInv, dictHeaderLen, collapseWithDict, type WordPreResult } from './wordpre'
const ENABLE_WORDPRE = true
import { deltaFwd, deltaInv, medFwd, medInv, d16Fwd, d16Inv, bcjFwd, bcjInv, bcjMsbFwd, bcjMsbInv, wide16Fwd, wide16Inv, wordRowDelta, anchorFoldFwd, anchorFoldInv } from './transforms'
import { CM_FAMILIES, isFamilyCM } from './unify'
import { threadCount, type JobPayload, type JobReply } from './parallel'
import { closeNodePool, nodeParallelReady, runNodeJobs } from './parallel-node'

import { ID } from './container/format'
export { ID }

export interface CodecInfo {
  short: string
  name: string
  desc: string
  color: string
}

export const CODECS: Record<number, CodecInfo> = {
  0: { short: 'STORE', name: '原样存储', desc: '高熵噪声:任何模型都无法预测,直接放弃压缩以免膨胀', color: '#94a3b8' },
  1: { short: 'FILL', name: '常量填充', desc: '整个区域只是同一个字节,只记一个字节 + 长度', color: '#22d3ee' },
  2: { short: 'RLE', name: '游程编码', desc: '(字节, 重复次数) 对,适合长重复段', color: '#2dd4bf' },
  3: { short: 'O0', name: '零阶熵编码', desc: '只学习字节频率分布的算术编码', color: '#a3e635' },
  4: { short: 'CM-TEXT', name: '文本上下文混合', desc: '1~6 阶上下文 + 词模型 + 匹配模型的逐比特混合', color: '#fbbf24' },
  5: { short: 'CM-BIN', name: '二进制上下文混合', desc: '稀疏/跳跃上下文 + 长匹配模型,捕捉通用结构', color: '#fb7185' },
  6: { short: 'DELTA', name: '差分 + 残差模型', desc: '按检测到的步长做差分,把连续变化压成小残差', color: '#818cf8' },
  7: { short: 'GRAD-2D', name: '二维梯度预测', desc: '检测行跨度 → 把一维字节还原成二维网格,用左/上/左上邻居预测', color: '#c084fc' },
  8: { short: 'LIN-16', name: '16位采样线性预测', desc: '按 16 位小端采样做一/二阶线性预测(音频类)', color: '#60a5fa' },
  9: { short: 'TRANSPOSE', name: '定长记录按列分流', desc: '按记录步长转置，逐列选择原样、填充、游程、上下文或差分编码', color: '#f472b6' },
  10: { short: 'TRANSPOSE-G', name: '定长记录分组分流', desc: '自适应组合相邻列并联合编码，保留记录内的跨列关联', color: '#e879f9' },
  31: { short:'WIDE-16', name:'宽行 16 位图像预测', desc:'宽行检测后按实压选择二维 MED 或 16 位差分', color:'#c084fc' },
  33: { short:'BITPLANE', name:'位平面', desc:'选择性位平面压缩', color:'#818cf8' },
  32: { short:'REC2', name:'二滞后递推残差', desc:'高熵序列的有界递推检测和可逆残差', color:'#818cf8' },
  23: { short:'CM-TEXT3', name:'九上下文词模型', desc:'词与稀疏字符上下文', color:'#fbbf24' },
  24: { short:'CM-BIN3', name:'九上下文结构模型', desc:'结构相位与稀疏上下文', color:'#fb7185' },
  25: { short:'BCJ3', name:'BCJ 九上下文', desc:'BCJ 与增强二进制模型', color:'#fb923c' },
  26: { short:'GRAD-2D3', name:'相位隔离二维残差', desc:'字节相位和二维梯度上下文', color:'#c084fc' },
  27: { short:'DELTA3', name:'相位隔离差分残差', desc:'字节相位和多阶邻居上下文', color:'#818cf8' },
  28: { short:'SUB-TRANSPOSE3', name:'增强定长子通道', desc:'增强上下文子通道', color:'#fb923c' },
  29: { short:'SUB-ANCHOR3', name:'增强锚点子通道', desc:'增强上下文锚点通道', color:'#34d399' },
  30: { short:'TRANSPOSE-G3', name:'增强分组转置', desc:'组内逆序与相位上下文', color:'#e879f9' },
  22: { short: 'TRANSPOSE-2D', name: '逆序转置与二维上下文', desc: '列采样剥离及二维跨列上下文，实际比较传统转置', color: '#e879f9' },
  18: { short: 'CM-TEXT2', name: '词级上下文混合', desc: '词前缀与跨词上下文混合', color: '#fbbf24' },
  19: { short: 'CM-BIN2', name: '结构相位上下文混合', desc: '四字节结构相位上下文', color: '#fb7185' },
  20: { short: 'BCJ2', name: '结构相位 BCJ', desc: 'BCJ 变换与结构相位上下文', color: '#fb923c' },
  21: { short: 'GRAD-2D2', name: '二维残差上下文', desc: 'MED 残差与二维垂直上下文', color: '#c084fc' },
  17: { short: 'MICRO-LIN', name: '现场拟合微种子预测', desc: '区域内用邻居拟合量化线性权重，保存 5 字节种子并编码可逆残差', color: '#fbbf24' },
  15: { short: 'SUB-TRANSPOSE', name: '定长子通道分流', desc: '同源列按模态分流，比较独立与共享模型', color: '#fb923c' },
  16: { short: 'SUB-ANCHOR', name: '锚点子通道分流', desc: '同源锚点列跨区域聚合，独立模型编码', color: '#34d399' },
  14: { short: 'PEEL', name: '递归地形剥离', desc: '按定长记录分列，对每列再次扫描地形并逐子区域试编码（最多一层）', color: '#a78bfa' },
  13: { short: 'ANCHOR-FOLD', name: '自定界语法锚点折叠', desc: '保持原始长度的变长行/列折叠，再以共享上下文模型编码', color: '#34d399' },
  12: { short: 'ANCHOR-ALIGN', name: '语法锚点变长对齐', desc: '按锚点划分变长行，记录行长并将前 32 字节按列组编码，余下字节顺序编码', color: '#22d3ee' },
  11: { short: 'BCJ-x86', name: '相对跳转坐标变换', desc: 'E8/E9 rel32 加上全局字节偏移，再由二进制模型编码', color: '#fb923c' },
}

export interface Spec {
  id: number
  s: number
  r: number
}

/** These are identity BIN IDs, not STORE/BCJ or a transformed inner bin stream. */
/**
 * v22 eligibility, decided by the CM profile the group will actually run, not by
 * the transform id: `xform-bin`/`xform-bin-stride4` feed an identity BIN model, so
 * those qualify too; native res/res2d rows (GRAD-2D3 without a switch, WIDE-16) do
 * not. Residual streams are excluded on principle — their values cluster at
 * 0/+1/-1, so four-byte collisions happen by coincidence rather than by LZ
 * repetition and the distance carries no information (measured: mr-mid +7 B).
 */
export function matchDistProfileAllowed(id: number, context?: CMContext): boolean {
  // Every one of these contexts runs the identity BIN CM below, so the distance-split
  // match table applies exactly as it does to a plain BIN group. `bin-stride4` was
  // missing from this list, which silently denied v22 to every BCJ/BCJ2/BCJ3 group
  // (ooffice: all 13 groups, 262 KiB of x86) even after the v21 gate let them in.
  if (context === 'xform-bin' || context === 'xform-bin-stride4' || context === 'bin-stride4') return true
  if (context === 'wide-geom') return false
  const TEXT = [ID.TEXT, ID.TEXT_V2, ID.TEXT_V3] as number[]
  const BIN = [ID.BIN, ID.BIN_V2, ID.BIN_V3] as number[]
  return TEXT.includes(id) || BIN.includes(id) || id === ID.TRANSPOSE_GROUP_V3
}

export function contextSpecAllowed(context: CMContext, sp: Spec, wordPre = false): boolean {
  // v21 6/7: the SAME residual transform the selected rule already uses, fed to
  // an identity BIN v20 model (mode 7 adds the stride-4 H[8] context).
  if (context === 'xform-bin' || context === 'xform-bin-stride4')
    return !wordPre && ([ID.DELTA, ID.DELTA_V3, ID.TRANSPOSE_2D, ID.GRAD_V3] as number[]).includes(sp.id)
  // BCJ / BCJ2 / BCJ3 are identity `bin` streams once the reversible E8/E9 filter has
  // run, so the stride-4 context is exactly as applicable to them as to BIN itself —
  // and they carry most of the bytes in x86-heavy corpora (ooffice: 85 %, AITDCC/H:
  // 99.6 % were stuck at v20 because this list omitted them).
  // `BCJ_V3 s=2` is the carry-preserving MSB variant: same filtered length, same
  // `bin` profile, only a different E8/E9 operand convention — so `s` may be 1 or 2.
  if (context === 'bin-stride4') return !wordPre && (sp.id === ID.TRANSPOSE_GROUP_V3
    ? sp.s >= 2 && sp.s <= 64 && sp.r === 1
    : ([ID.BIN, ID.BIN_V2, ID.BIN_V3] as number[]).includes(sp.id) && sp.s === 1 && sp.r === 1
      || ([ID.BCJ, ID.BCJ_V2, ID.BCJ_V3] as number[]).includes(sp.id) && (sp.s === 1 || (sp.id === ID.BCJ_V3 && sp.s === 2)) && sp.r === 1)
  if (context === 'text-sparse5') return !wordPre && ([ID.TEXT, ID.TEXT_V2, ID.TEXT_V3] as number[]).includes(sp.id) && sp.s === 1 && sp.r === 1
  // P17.7: the line/field column predictors run the same `text` CM on the same
  // raw text stream as text-sparse5 — they substitute three of that model's nine
  // contexts, so the eligibility rule is identical (no WORD-PRE dictionary).
  if (context === 'text-linecol' || context === 'text-lexcol' || context === 'text-tabcol' || context === 'text-vertcol') return !wordPre && ([ID.TEXT, ID.TEXT_V2, ID.TEXT_V3] as number[]).includes(sp.id) && sp.s === 1 && sp.r === 1
  // P18.0: universal low-cardinality symbol modes. Same `text` CM on the same raw
  // bytes (no WORD-PRE dictionary); the cardinality check itself is done by the
  // screen from the actual data, so wire legality only needs the rule shape.
  if (context === 'sym-2bit' || context === 'sym-5bit' || context === 'sym-5bit-gap') return !wordPre && ([ID.TEXT, ID.TEXT_V2, ID.TEXT_V3] as number[]).includes(sp.id) && sp.s === 1 && sp.r === 1
  if (context === 'wide-geom') return !wordPre && sp.id === ID.WIDE_GRAD && sp.s >= 6 && sp.s <= 8 && sp.r >= 256 && sp.r <= 8192 && sp.r % 2 === 0
  if (context === 'wp-merge') return wordPre && sp.id === ID.TEXT_V3 && sp.s === 1 && sp.r === 1
  // P17.6: the word-trigram H[8] is orthogonal to WORD-PRE dictionary collapsing.
  // On raw text/source code (no dictionary) the same `text` CM runs with
  // wordTokens = true, so the v21 wire header (context code, 0x4000 absent)
  // already represents it — no new context code is needed.
  if (context === 'wp-token3') {
    const textSpec = ([ID.TEXT, ID.TEXT_V2, ID.TEXT_V3] as number[]).includes(sp.id) && sp.s === 1 && sp.r === 1
    return wordPre ? sp.id === ID.TEXT_V3 && sp.s === 1 && sp.r === 1 : textSpec
  }
  return false
}
function checkContextSpec(options: CMOptions | undefined, sp: Spec, kernel: CMVariant, wordPre = false): void {
  if (options?.context && (kernel !== 'v20' || !contextSpecAllowed(options.context, sp, wordPre))) throw Error('v21 上下文与组规则不兼容')
}
/** Only for explicitly validated identity BIN context candidates/controls. */
function joinContextBin(parts: readonly Uint8Array[]): Uint8Array {
  if(parts.length===1)return parts[0]
  const joined=new Uint8Array(parts.reduce((n,p)=>n+p.length,0))
  let at=0;for(const p of parts){joined.set(p,at);at+=p.length}
  return joined
}

/**
 * BCJ groups reach the `bin-stride4` context as a *declared* reversible filter plus an
 * identity BIN model. The context path used to feed the raw, unfiltered bytes to the
 * BIN model — the E8/E9 transform was simply skipped — so the stream disagreed with
 * its own spec, and (measured on ooffice) the "candidate" was 9.3 % larger than the
 * v20 container it was supposed to improve. Keeping the filter on both sides makes
 * the context path a strict model substitution on top of the transform the group
 * already declares.
 */
function contextFilterForward(part: Uint8Array, sp: Spec, position = 0): Uint8Array {
  if (sp.id === ID.BCJ || sp.id === ID.BCJ_V2 || sp.id === ID.BCJ_V3)
    return (sp.id === ID.BCJ_V3 && sp.s === 2 ? bcjMsbFwd : bcjFwd)(part, position)
  return part
}
function contextFilterInverse(part: Uint8Array, sp: Spec, position = 0): Uint8Array {
  if (sp.id === ID.BCJ || sp.id === ID.BCJ_V2 || sp.id === ID.BCJ_V3)
    return (sp.id === ID.BCJ_V3 && sp.s === 2 ? bcjMsbInv : bcjInv)(part, position)
  return part
}
function joinContextBinFiltered(parts: readonly Uint8Array[], sp: Spec, positions?: number[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (let i = 0; i < parts.length; i++) {
    joined.set(contextFilterForward(parts[i], sp, positions?.[i] ?? 0), at)
    at += parts[i].length
  }
  return joined
}

function fmtAnchor(b:number):string {
  if (b===10) return "'\\n'"
  if (b===9) return "'\\t'"
  if (b===13) return "'\\r'"
  if (b>=32 && b<=126) return `'${String.fromCharCode(b)}'`
  return `0x${b.toString(16).padStart(2,'0')}`
}
export function specLabel(sp: Spec): string {
  const c = CODECS[sp.id].short
  if (sp.id === ID.WIDE_GRAD) return `${c}(${['','D16','MED8','MED16','GRAD332','AVG16','ZZ-GRAD332','ZZ-AVG16','ZZ-MED16'][sp.s]}, 行${sp.r})`
  if (sp.id === ID.BCJ_V3 && sp.s === 2) return `${c}(MSB25)`
  if (sp.id === ID.MICRO) return `${c}(步长${sp.s}, 行${sp.r})`
  if ((sp.id === ID.SUB_TRANSPOSE || sp.id === ID.SUB_TRANSPOSE_V3)) return `${c}(步长${sp.s}, ${sp.r & 1 ? 'TEXT' : 'BIN'})`
  if ((sp.id === ID.SUB_ANCHOR || sp.id === ID.SUB_ANCHOR_V3)) return `${c}(${fmtAnchor(sp.s)}, 0x${(sp.r & 127).toString(16).padStart(2,'0')})`
  if (sp.id === ID.PEEL) return `${c}(步长${sp.s})`
  if (sp.id === ID.ANCHOR_FOLD) {
    const raw=sp.r&127, mode=sp.r&128 ? 'BIN' : 'TEXT'
    return raw>=32 || raw===9 ? `ANCHOR-GRID(行${fmtAnchor(sp.s)}, 列${fmtAnchor(raw)}, ${mode})` : `ANCHOR-JAGGED(锚${fmtAnchor(sp.s)}, 宽${raw}, ${mode})`
  }
  if (sp.id === ID.ANCHOR) return `${c}(锚点0x${(sp.s - 1).toString(16).padStart(2,'0')})`
  if (sp.id === ID.TRANSPOSE || sp.id === ID.TRANSPOSE_GROUP || sp.id === ID.TRANSPOSE_2D || sp.id === ID.TRANSPOSE_GROUP_V3) return `${c}(步长${sp.s})`
  if ((sp.id === ID.DELTA || sp.id === ID.DELTA_V3)) return `${c}(步长${sp.s})`
  if (sp.id === ID.GRAD || sp.id === ID.GRAD_V2 || sp.id === ID.GRAD_V3 || sp.id === ID.WIDE_GRAD) return `${c}(步长${sp.s}, 行${sp.r})`
  if (sp.id === ID.D16) return `${c}(${sp.s}声道, ${sp.r}阶)`
  return c
}

const sameSpec = (a: Spec, b: Spec) => a.id === b.id && a.s === b.s && a.r === b.r

/** Stream rules whose encoder consumes the group's members as one flat
 * concatenation (in ascending segment order) and slices the decoded stream by
 * `rawLen`. Two contiguous members of the same group with the same rule are
 * therefore indistinguishable from a single longer member: the seam is not in
 * the wire format at all. Used by the post-plan coalescer below. */
// Rules whose transform runs over the whole GROUP stream (or over nothing at all),
// so re-cutting the header at a different boundary cannot change a single decoded
// byte. `BCJ*` is deliberately absent: it converts E8/E9 words relative to each
// PART's absolute position, so the boundaries are part of the bitstream contract.
/**
 * 只有**无状态**规则可以安全合并相邻分段：编码端把它们当作一条连续的 CM 流，
 * 解码端切分时不施加任何逐段变换，因此分段边界怎么合并都不影响字节。
 *
 * DELTA/GRAD/D16/ANCHOR_FOLD 带状态（差分链、中值预测链、折叠字典），
 * 编码端是**逐分片**作用再拼接，解码端也是逐分片求逆 —— 边界即语义。
 * 把它们放进这个集合会在合并后丢失边界：`multiChannel(3,16384)` 的
 * 49,152 B 流就是在此处被并成 1 段，解码端对整个 49,152 B 求一次逆变换，
 * 从第一个边界 3,584 = 7*512 之后全错（P29.3 发现的往返缺陷，P29.4b 修复）。
 */
const CONCAT_INVARIANT_IDS = new Set<number>([
  ID.STORE, ID.RLE, ID.O0, ID.TEXT, ID.BIN, ID.TEXT_V2, ID.BIN_V2, ID.TEXT_V3, ID.BIN_V3,
])

/**
 * Merge adjacent plan segments that are contiguous, belong to the same group
 * and share a concatenation-invariant rule. Pure plan bookkeeping: no payload is
 * re-encoded, and every group's payload/spec/kernel/context metadata is kept
 * untouched. Returns `adopted: false` (and the inputs) when the header does not
 * actually shrink, so the caller can gate on real bytes.
 */
type CoalesceFields = { rawLen?: number; compLen?: number }
export function coalesceContiguousPlanSegments<T extends PlanSegment & CoalesceFields>(dataLen: number, segs: readonly T[], groups: readonly PlanGroup[]):
  { segs: T[]; groups: PlanGroup[]; adopted: boolean } {
  const owner = new Int32Array(segs.length).fill(-1)
  for (let gi = 0; gi < groups.length; gi++) for (const m of groups[gi].members) if (m >= 0 && m < segs.length) owner[m] = gi
  const out: T[] = [], source: number[] = [], mapped = new Int32Array(segs.length).fill(-1)
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i], prev = out.length ? out[out.length - 1] : undefined, prevSrc = source[source.length - 1]
    const merge = !!prev && prev.end === seg.start && owner[i] === owner[prevSrc] && owner[i] >= 0
      && sameSpec(prev.spec, seg.spec) && CONCAT_INVARIANT_IDS.has(seg.spec.id)
    if (merge) {
      prev!.end = seg.end
      prev!.rawLen = (prev!.rawLen ?? 0) + (seg.rawLen ?? 0)
      prev!.compLen = (prev!.compLen ?? 0) + (seg.compLen ?? 0)
      mapped[i] = out.length - 1
      continue
    }
    out.push({ ...seg, spec: { ...seg.spec } })
    source.push(i)
    mapped[i] = out.length - 1
  }
  if (out.length === segs.length) return { segs: segs as T[], groups: groups as PlanGroup[], adopted: false }
  const nextGroups = groups.map(g => {
    const members: number[] = []
    let last = -1
    for (const m of g.members) {
      const to = mapped[m]
      if (to < 0 || to === last) continue
      members.push(to); last = to
    }
    return { ...g, spec: { ...g.spec }, members }
  })
  const adopted = planHeader(dataLen, out, nextGroups).length < planHeader(dataLen, segs, groups).length
  return adopted ? { segs: out, groups: nextGroups, adopted } : { segs: segs as unknown as T[], groups: groups as PlanGroup[], adopted: false }
}

// ---------- 变长整数 ----------
function putVar(out: number[], v: number) {
  while (v >= 128) {
    out.push((v % 128) | 128)
    v = Math.floor(v / 128)
  }
  out.push(v)
}
function varintBytes(n:number):number { let bytes=1;while(n>=128){n=Math.floor(n/128);bytes++}return bytes }
function getVar(d: Uint8Array, st: { p: number }): number {
  let v = 0
  let mul = 1
  for (;;) {
    if (st.p >= d.length) throw new Error('容器数据被截断')
    const b = d[st.p++]
    v += (b & 127) * mul
    if (!Number.isSafeInteger(v)) throw new Error('变长整数溢出')
    if (b < 128) return v
    mul *= 128
    if (!Number.isSafeInteger(mul) || !Number.isSafeInteger(v)) throw new Error('变长整数溢出')
  }
}

// ---------- 单区域编解码 ----------
function rleEnc(d: Uint8Array): Uint8Array {
  const out = new ByteWriter()
  let i = 0
  while (i < d.length) {
    let j = i + 1
    while (j < d.length && d[j] === d[i]) j++
    out.push(d[i])
    let run = j - i
    while (run >= 128) { out.push((run % 128) | 128); run = Math.floor(run / 128) }
    out.push(run)
    i = j
  }
  return out.finish()
}
function rleDec(p: Uint8Array, n: number): Uint8Array {
  const o = new Uint8Array(n)
  const st = { p: 0 }
  let w = 0
  while (st.p < p.length && w < n) {
    const b = p[st.p++]
    const run = getVar(p, st)
    if (run <= 0 || run > n - w) throw new Error('RLE 游程越界')
    o.fill(b, w, w + run)
    w += run
  }
  if (w !== n || st.p !== p.length) throw new Error('RLE 长度校验失败')
  return o
}

export function encodeSpec(data: Uint8Array, sp: Spec, costOut?: Float32Array, off = 0, position = 0): Uint8Array {
  return withCMBlockSize(data.length, () => encodeSpecImpl(data, sp, costOut, off, position))
}
function encodeSpecImpl(data: Uint8Array, sp: Spec, costOut?: Float32Array, off = 0, position = 0): Uint8Array {
  const n = data.length
  let payload: Uint8Array
  let cm = true
  switch (sp.id) {
    case ID.STORE:
      cm = false
      payload = data.slice()
      break
    case ID.FILL:
      cm = false
      payload = Uint8Array.of(data[0])
      break
    case ID.RLE:
      cm = false
      payload = rleEnc(data)
      break
    case ID.O0:
      payload = encodeCM(data, 'o0', 1, 1, costOut, off)
      break
    case ID.WIDE_GRAD: case ID.TEXT_V3: case ID.BIN_V3: case ID.BCJ_V3: case ID.GRAD_V3: case ID.DELTA_V3:
      return encodeTerrainGroup([data],sp,costOut ? costOut.subarray(off,off+data.length) : undefined,undefined,undefined,[position])
    case ID.TEXT_V2:
      payload = encodeCM(data, 'text', 1, 1, costOut, off, undefined, undefined, true)
      break
    case ID.BIN_V2:
      payload = encodeCM(data, 'bin', 1, 1, costOut, off, undefined, undefined, true)
      break
    case ID.BCJ_V2:
      payload = encodeCM(bcjFwd(data, position), 'bin', 1, 1, costOut, off, undefined, undefined, true)
      break
    case ID.GRAD_V2:
      payload = encodeCM(medFwd(data, sp.s, sp.r), 'res2d', sp.s, sp.r, costOut, off, undefined, undefined, true, sp.r)
      break
    case ID.TEXT:
      payload = encodeCM(data, 'text', 1, 1, costOut, off)
      break
    case ID.BIN:
      payload = encodeCM(data, 'bin', 1, 1, costOut, off)
      break
    case ID.DELTA:
      payload = encodeCM(deltaFwd(data, sp.s), 'res', sp.s, 1, costOut, off)
      break
    case ID.GRAD:
      payload = encodeCM(medFwd(data, sp.s, sp.r), 'res2d', sp.s, sp.r, costOut, off)
      break
    case ID.D16:
      payload = encodeCM(d16Fwd(data, sp.s, sp.r), 'res', 2 * sp.s, 1, costOut, off)
      break
    case ID.TRANSPOSE:
      return encodeTransposeGroup([data], sp.s, costOut ? {values:costOut, blockSize:1, offset:off} : undefined)
    case ID.TRANSPOSE_GROUP:
      return encodeGroupedTranspose([data], sp.s, costOut ? {values:costOut, blockSize:1, offset:off} : undefined)
    case ID.TRANSPOSE_GROUP_V3:
      return encodeTerrainGroup([data],sp,costOut ? costOut.subarray(off,off+data.length) : undefined)
    case ID.TRANSPOSE_2D:
      return encodeTerrainGroup([data],sp,costOut ? costOut.subarray(off,off+data.length) : undefined)
    case ID.MICRO:
      return encodeMicroGroup([data],sp,costOut ? {values:costOut,blockSize:1,offset:off} : undefined)
    case ID.SUB_TRANSPOSE_V3:
    case ID.SUB_ANCHOR_V3:
    case ID.SUB_TRANSPOSE:
    case ID.SUB_ANCHOR: {
      const payload=encodeSubGroups([data],sp)
      if(costOut) for(let i=0;i<n;i++) costOut[off+i]=payload.length*8/Math.max(1,n)
      return payload
    }
    case ID.PEEL:
      return encodePeel([data],sp.s,costOut ? {values:costOut,blockSize:1,offset:off} : undefined)
    case ID.ANCHOR_FOLD:
      payload = encodeCM(anchorFoldFwd(data,sp.s,sp.r), sp.r&128 ? 'bin' : 'text')
      cm = false // Fold reorders bytes: report an explicitly uniform estimate.
      break
    case ID.ANCHOR:
      cm = false
      payload = encodeAnchor(data, sp.s - 1)
      break
    case ID.BCJ:
      payload = encodeCM(bcjFwd(data, position), 'bin', 1, 1, costOut, off)
      break
    default:
      throw new Error('未知编码器')
  }
  if (!cm && costOut) for (let i = 0; i < n; i++) costOut[off + i] = (payload.length * 8) / Math.max(1, n)
  return payload
}

export function decodeSpec(p: Uint8Array, n: number, sp: Spec, position = 0): Uint8Array {
  return withCMBlockSize(n, () => decodeSpecImpl(p, n, sp, position))
}
function decodeSpecImpl(p: Uint8Array, n: number, sp: Spec, position = 0): Uint8Array {
  switch (sp.id) {
    case ID.STORE:
      // P7-0：STORE 段必须原样拷贝。`slice(0,n)` 在载荷被截短时会静默返回更短的
      // 数组，调用方的 `set()` 于是留下零字节——这种"看起来解压成功"的损坏比抛错
      // 危险得多，所以长度不符一律拒绝。
      if (p.length !== n) throw new Error('STORE 载荷长度与声明长度不符')
      return p.slice(0, n)
    case ID.FILL:
      // 空载荷 + 非零长度过去会静默返回全 0（p[0] === undefined），把"坏容器"
      // 伪装成"解压成功"。v1 的 FILL 至少要有 1 个字节的填充值。
      if (n > 0 && p.length === 0) throw new Error('Invalid FILL payload')
      return new Uint8Array(n).fill(p[0] ?? 0)
    case ID.RLE:
      return rleDec(p, n)
    case ID.O0:
      return decodeCM(p, n, 'o0').slice()
    case ID.WIDE_GRAD: case ID.TEXT_V3: case ID.BIN_V3: case ID.BCJ_V3: case ID.GRAD_V3: case ID.DELTA_V3:
      return decodeTerrainGroup(p,[n],sp,undefined,[position])[0]
    case ID.TEXT_V2:
      return decodeCM(p, n, 'text', 1, 1, undefined, true).slice()
    case ID.BIN_V2:
      return decodeCM(p, n, 'bin', 1, 1, undefined, true).slice()
    case ID.BCJ_V2:
      return bcjInv(decodeCM(p, n, 'bin', 1, 1, undefined, true), position)
    case ID.GRAD_V2:
      return medInv(decodeCM(p, n, 'res2d', sp.s, sp.r, undefined, true, sp.r), sp.s, sp.r)
    case ID.TEXT:
      return decodeCM(p, n, 'text').slice()
    case ID.BIN:
      return decodeCM(p, n, 'bin').slice()
    case ID.DELTA:
      return deltaInv(decodeCM(p, n, 'res', sp.s, 1), sp.s)
    case ID.GRAD:
      return medInv(decodeCM(p, n, 'res2d', sp.s, sp.r), sp.s, sp.r)
    case ID.D16:
      return d16Inv(decodeCM(p, n, 'res', 2 * sp.s, 1), sp.s, sp.r)
    case ID.TRANSPOSE:
      return decodeTransposeGroup(p, [n], sp.s)[0]
    case ID.TRANSPOSE_GROUP:
      return decodeGroupedTranspose(p, [n], sp.s)[0]
    case ID.TRANSPOSE_GROUP_V3:
      return decodeTerrainGroup(p,[n],sp)[0]
    case ID.TRANSPOSE_2D:
      return decodeTerrainGroup(p,[n],sp)[0]
    case ID.MICRO:
      return decodeMicroGroup(p,[n],sp)[0]
    case ID.SUB_TRANSPOSE_V3:
    case ID.SUB_ANCHOR_V3:
    case ID.SUB_TRANSPOSE:
    case ID.SUB_ANCHOR:
      return decodeSubGroups(p,[n],sp)[0]
    case ID.PEEL:
      return decodePeel(p,[n],sp.s)[0]
    case ID.ANCHOR_FOLD:
      return anchorFoldInv(decodeCM(p,n,sp.r&128 ? 'bin' : 'text'),sp.s,sp.r)
    case ID.ANCHOR:
      return decodeAnchor(p, n, sp.s - 1)
    case ID.BCJ:
      return bcjInv(decodeCM(p, n, 'bin'), position)
    default:
      throw new Error('未知编码器')
  }
}

// Delta prediction resets at every source-segment seam, while the column CM is shared.
function columnDelta(input: Uint8Array, lengths: number[], inverse: boolean): Uint8Array {
  const out = new Uint8Array(input.length)
  let pos = 0
  for (const length of lengths) {
    let previous = 0
    for (let i = 0; i < length; i++) {
      const byte = inverse ? (input[pos] + previous) & 255 : input[pos]
      out[pos] = inverse ? byte : (byte - previous) & 255
      previous = byte; pos++
    }
  }
  return out
}
function encodeColumn(input: Uint8Array, mode: number, lengths: number[], onProgress?: (done: number, total: number) => void, kernel:CMVariant=false): Uint8Array {
  if (mode === ID.DELTA) return encodeCM(columnDelta(input, lengths, false), 'res', 1, 1, undefined, 0, undefined, onProgress,kernel)
  if (mode === ID.O0 || mode === ID.BIN) return encodeCM(input, mode === ID.O0 ? 'o0' : 'bin', 1, 1, undefined, 0, undefined, onProgress,kernel)
  return encodeSpec(input, {id:mode, s:1, r:1})
}

// Per-column streams are shared across segments with the same record width.
// Each segment starts a new row; partial trailing rows are kept column by column.
type ColumnCost = CostBins
function fillUniformCosts(cost: CostBins, length: number, bits: number) {
  const count = cost.ends?.length ?? Math.ceil(length / cost.blockSize)
  let prev = 0
  for (let i = 0; i < count; i++) {
    const end = cost.ends ? cost.ends[i] : Math.min(length, (i + 1) * cost.blockSize)
    cost.values[i + (cost.offset ?? 0)] = bits * (end - prev) / Math.max(1, length)
    prev = end
  }
}
// Column weights can also be applied later, so a chosen candidate reuses the
// ones collected during its single encode instead of running the transpose again.
function applyColumnCosts(parts: Uint8Array[], width: number, weights: Float64Array, emptyHeaderBits: number, costs: ColumnCost) {
  const total = parts.reduce((a,p) => a+p.length, 0)
  const count = costs.ends?.length ?? Math.ceil(total / costs.blockSize)
  costs.values.fill(0, costs.offset ?? 0, (costs.offset ?? 0) + count)
  let pos = 0, cycle = 0, bin = 0
  for (const v of weights) cycle += v
  for (const part of parts) {
    let start = 0
    while (start < part.length) {
      const logical = pos + start
      if (costs.ends) { while (bin < costs.ends.length && logical >= costs.ends[bin]) bin++ }
      else bin = Math.floor(logical / costs.blockSize)
      const end = costs.ends ? costs.ends[bin] : Math.min(total, (bin + 1) * costs.blockSize)
      const len = Math.min(end - logical, part.length - start)
      let bits = Math.floor(len / width) * cycle + len * emptyHeaderBits / Math.max(1, total)
      for (let k = 0; k < len % width; k++) bits += weights[(start + k) % width]
      costs.values[bin + (costs.offset ?? 0)] += bits
      start += len
    }
    pos += part.length
  }
}
// Seeds precede one shared arithmetic-coded residual stream, in member order.
// Prediction state resets per region; the entropy model is shared as before.
function encodeMicroGroup(parts:Uint8Array[],sp:Spec,costs?:CostBins,onProgress?:(done:number,total:number)=>void):Uint8Array {
  const n=parts.reduce((a,p)=>a+p.length,0), joined=new Uint8Array(n), seeds=new Uint8Array(parts.length*MICRO_SEED_BYTES)
  let pos=0
  for(let i=0;i<parts.length;i++) {
    const seed=fitMicroSeed(parts[i],sp.s,sp.r);seeds.set(seed,i*MICRO_SEED_BYTES)
    joined.set(microFwd(parts[i],sp.s,sp.r,seed),pos);pos+=parts[i].length
  }
  if(costs) {
    const count=costs.ends?.length ?? Math.ceil(n/costs.blockSize)
    costs.values.fill(0,costs.offset??0,(costs.offset??0)+count)
  }
  const encoded=encodeCM(joined,sp.r===1?'res':'res2d',sp.s,sp.r,undefined,0,costs,onProgress)
  if(costs && n) {
    const count=costs.ends?.length ?? Math.ceil(n/costs.blockSize)
    let part=0, partStart=0, begin=0
    for(let b=0;b<count;b++) {
      const end=costs.ends?costs.ends[b]:Math.min(n,(b+1)*costs.blockSize)
      let p=begin
      while(p<end) {
        while(part<parts.length && partStart+parts[part].length<=p) {partStart+=parts[part].length;part++}
        if(part>=parts.length) throw Error('微种子代价边界错误')
        const len=Math.min(end,partStart+parts[part].length)-p
        costs.values[b+(costs.offset??0)]+=MICRO_SEED_BYTES*8*len/parts[part].length
        p+=len
      }
      begin=end
    }
  }
  const out=new Uint8Array(seeds.length+encoded.length);out.set(seeds);out.set(encoded,seeds.length);return inheritPayloadModel(out, encoded)
}
function decodeMicroGroup(payload:Uint8Array,lengths:number[],sp:Spec,onProgress?:(done:number,total:number)=>void):Uint8Array[] {
  const head=lengths.length*MICRO_SEED_BYTES,n=lengths.reduce((a,b)=>a+b,0)
  if(head>payload.length) throw Error('微种子被截断')
  const residual=decodeCM(payload.subarray(head),n,sp.r===1?'res':'res2d',sp.s,sp.r,onProgress)
  let pos=0
  return lengths.map((len,i)=>{const p=microInv(residual.subarray(pos,pos+len),sp.s,sp.r,payload.subarray(i*MICRO_SEED_BYTES,(i+1)*MICRO_SEED_BYTES));pos+=len;return p})
}
// Bound peak memory by packing whole-region chunks of at most 8 MiB.
// Column models are shared across regions within a chunk, never across chunks.
const MAX_SUB_CHUNK=8*1024*1024
function encodeSubGroups(parts:Uint8Array[],sp:Spec,kernel:CMVariant=false):Uint8Array {
  const out=new ByteWriter();let i=0
  while(i<parts.length) {
    let j=i,size=0
    while(j<parts.length && (j===i || size+parts[j].length<=MAX_SUB_CHUNK)) {size+=parts[j].length;j++}
    if(size>MAX_SUB_CHUNK) throw Error('子通道区域超过资源上限')
    const chunk=parts.slice(i,j), payload=sp.id===ID.SUB_TRANSPOSE || sp.id===ID.SUB_TRANSPOSE_V3 ? encodePeeledTranspose(chunk,sp.s,sp.r&1?'text':'bin',kernel==='v20'?'v20':sp.id===ID.SUB_TRANSPOSE_V3?'v13':false) : encodePeeledAnchor(chunk,sp.s,sp.r,kernel==='v20'?'v20':sp.id===ID.SUB_ANCHOR_V3?'v13':false)
    writeVar(out,j-i);writeVar(out,payload.length);writeBytes(out,payload);i=j
  }
  return out.finish()
}
function decodeSubGroups(payload:Uint8Array,lengths:number[],sp:Spec,kernel:CMVariant=false):Uint8Array[] {
  const out:Uint8Array[]=[],st={p:0};let i=0
  while(i<lengths.length) {
    const count=getVar(payload,st),size=getVar(payload,st)
    if(!count||count>lengths.length-i||size>payload.length-st.p)throw Error('无效子通道块')
    const lens=lengths.slice(i,i+count)
    if(lens.reduce((a,b)=>a+b,0)>MAX_SUB_CHUNK)throw Error('子通道区域超过资源上限')
    const sub=payload.subarray(st.p,st.p+size)
    const decoded=sp.id===ID.SUB_TRANSPOSE || sp.id===ID.SUB_TRANSPOSE_V3 ? decodePeeledTranspose(sub,lens,sp.s,sp.r&1?'text':'bin',kernel==='v20'?'v20':sp.id===ID.SUB_TRANSPOSE_V3?'v13':false) : decodePeeledAnchor(sub,lens,sp.s,sp.r,kernel==='v20'?'v20':sp.id===ID.SUB_ANCHOR_V3?'v13':false)
    for(const part of decoded) out.push(part)
    i+=count;st.p+=size
  }
  if(st.p!==payload.length)throw Error('子通道块包含多余数据')
  return out
}
// A single bounded peeling layer. The child format has only terminal rules;
// it cannot recurse or introduce another container/version.
const MAX_PEEL_PART = 8 * 1024 * 1024
const MAX_PEEL_CHILD_REGIONS = 128
export interface PeelRegion { start:number; end:number; terrain:Cls | 'whole'; rule:string; payloadSize:number }
export interface PeelColumn { column:number; rawLen:number; payloadSize:number; regions:PeelRegion[] }
function writeBytes(w:ByteWriter, bytes:Uint8Array) { w.append(bytes) }
function writeVar(w:ByteWriter, value:number) { const a:number[]=[]; putVar(a,value); for(const b of a) w.push(b) }
const PEEL_CLASSES = ['fill','noise','text','smooth','repeat','binary','whole'] as const
function childStream(data:Uint8Array, regions:{start:number;end:number;cls:Cls | 'whole'}[]): Uint8Array {
  const writer=new ByteWriter(); writeVar(writer,regions.length)
  for (const region of regions) {
    const part=data.subarray(region.start,region.end), n=part.length
    let id:number=ID.STORE, payload:Uint8Array=part
    let uniform=n>0
    for(let i=1;i<n&&uniform;i++) if(part[i]!==part[0]) uniform=false
    if(uniform) {id=ID.FILL;payload=Uint8Array.of(part[0])}
    else if(n>=32) {
      const rle=encodeSpec(part,{id:ID.RLE,s:1,r:1})
      if(rle.length<payload.length) {id=ID.RLE;payload=rle}
      const sample=part.subarray(0,Math.min(2048,n))
      const modes:number[] = region.cls==='text' ? [ID.TEXT,ID.BIN] : region.cls==='smooth' ? [ID.DELTA,ID.BIN] : [ID.BIN,ID.TEXT]
      let selected=-1, best=Math.min(sample.length,Math.ceil(payload.length*sample.length/n))
      for(const candidate of modes) {
        const size=encodeSpec(sample,{id:candidate,s:1,r:1}).length
        if(size<best) {best=size;selected=candidate}
      }
      if(selected>=0) {
        const packed=encodeSpec(part,{id:selected,s:1,r:1})
        if(packed.length<payload.length) {id=selected;payload=packed}
      }
    }
    writeVar(writer,n); writeVar(writer,PEEL_CLASSES.indexOf(region.cls)); writeVar(writer,id); writeVar(writer,payload.length); writeBytes(writer,payload)
  }
  return writer.finish()
}
function encodePeelColumn(data:Uint8Array): Uint8Array {
  if(!data.length) {const w=new ByteWriter();writeVar(w,0);return w.finish()}
  const analyzed=analyze(data).segs
  const whole: {start:number;end:number;cls:Cls | 'whole'}[] = [{start:0,end:data.length,cls:analyzed.length===1 ? analyzed[0].cls : 'whole'}]
  const single=childStream(data,whole)
  if(analyzed.length<2 || analyzed.length>MAX_PEEL_CHILD_REGIONS) return single
  const separated=childStream(data,analyzed)
  return separated.length<single.length ? separated : single
}
function readPeelColumn(payload:Uint8Array,n:number, collect=false, decode=true):{data:Uint8Array;regions:PeelRegion[]} {
  const st={p:0}, count=getVar(payload,st), output=new Uint8Array(decode?n:0), regions:PeelRegion[]=[]
  if(count>MAX_PEEL_CHILD_REGIONS || count>n || (n>0 && count===0)) throw Error('无效的剥离子区域数')
  let pos=0
  for(let k=0;k<count;k++) {
    const len=getVar(payload,st), terrain=getVar(payload,st),id=getVar(payload,st),pl=getVar(payload,st)
    if(terrain>=PEEL_CLASSES.length || !len || len>n-pos || pl>payload.length-st.p || ![ID.STORE,ID.FILL,ID.RLE,ID.TEXT,ID.BIN,ID.DELTA].includes(id as 0|1|2|4|5|6) || (id===ID.STORE && pl!==len) || (id===ID.FILL && pl!==1)) throw Error('无效的剥离子区域')
    if(decode) output.set(decodeSpec(payload.subarray(st.p,st.p+pl),len,{id,s:1,r:1}),pos)
    st.p+=pl
    if(collect) regions.push({start:pos,end:pos+len,terrain:PEEL_CLASSES[terrain],rule:specLabel({id,s:1,r:1}),payloadSize:pl})
    pos+=len
  }
  if(pos!==n || st.p!==payload.length) throw Error('剥离子流长度错误')
  return {data:output,regions}
}
function encodePeel(parts:Uint8Array[],width:number,costs?:CostBins,onProgress?:(done:number,total:number)=>void):Uint8Array {
  if(!Number.isInteger(width)||width<2||width>64 || parts.some(p=>p.length>MAX_PEEL_PART)) throw Error('剥离步长或区域大小越界')
  const total=parts.reduce((a,p)=>a+p.length,0), out=new ByteWriter(), weights=new Float64Array(width)
  let done=0, emptyHeaderBits=0
  for(let col=0;col<width;col++) {
    const length=parts.reduce((sum,p)=>sum+(p.length>col?Math.floor((p.length-1-col)/width)+1:0),0)
    const data=new Uint8Array(length); let w=0
    for(const part of parts) for(let i=col;i<part.length;i+=width) data[w++]=part[i]
    const packed=encodePeelColumn(data), header:number[]=[]; putVar(header,packed.length)
    for(const b of header) out.push(b); writeBytes(out,packed)
    weights[col]=length?(packed.length+header.length)*8/length:0
    if(!length) emptyHeaderBits+=(packed.length+header.length)*8
    done+=length;onProgress?.(done,total)
  }
  if(costs) applyColumnCosts(parts,width,weights,emptyHeaderBits,costs)
  return out.finish()
}
function decodePeel(payload:Uint8Array,lengths:number[],width:number,onProgress?:(done:number,total:number)=>void):Uint8Array[] {
  if(!Number.isInteger(width)||width<2||width>64 || lengths.some(n=>n>MAX_PEEL_PART)) throw Error('剥离步长或区域大小越界')
  const out=lengths.map(n=>new Uint8Array(n)), total=lengths.reduce((a,b)=>a+b,0),st={p:0};let done=0
  for(let col=0;col<width;col++) {
    const length=lengths.reduce((sum,n)=>sum+(n>col?Math.floor((n-1-col)/width)+1:0),0),size=getVar(payload,st)
    if(size>payload.length-st.p) throw Error('剥离列被截断')
    const colData=readPeelColumn(payload.subarray(st.p,st.p+size),length).data;st.p+=size
    let p=0
    for(const part of out) for(let i=col;i<part.length;i+=width) part[i]=colData[p++]
    done+=length;onProgress?.(done,total)
  }
  if(st.p!==payload.length) throw Error('剥离列尾部多余数据')
  return out
}
// Inspection reads the same validated child framing used by the decoder.
export function inspectPeel(payload:Uint8Array, lengths:number[], width:number):PeelColumn[] {
  if(!Number.isInteger(width)||width<2||width>64 || lengths.some(n=>n>MAX_PEEL_PART)) throw Error('剥离参数越界')
  const st={p:0}, out:PeelColumn[]=[]
  for(let col=0;col<width;col++) {
    const len=lengths.reduce((sum,n)=>sum+(n>col?Math.floor((n-1-col)/width)+1:0),0), size=getVar(payload,st)
    if(size>payload.length-st.p) throw Error('剥离列被截断')
    const child=readPeelColumn(payload.subarray(st.p,st.p+size),len,true,false);st.p+=size
    out.push({column:col,rawLen:len,payloadSize:size,regions:child.regions})
  }
  if(st.p!==payload.length) throw Error('剥离列尾部多余数据')
  return out
}
function columnPrefixLengths(columnLengths: readonly number[], size: number): number[] {
  let remaining = size
  return columnLengths.map(n => { const take = Math.min(n, remaining); remaining -= take; return take })
}
/**
 * Pick a column mode from a bounded sample. The 2 KiB default is kept for
 * ordinary columns; a large column (>=32 KiB, H0 < 7.5, delta not worse than
 * H0+0.1) is screened on 32 KiB so that a near-zero DELTA gain cannot discard
 * the raw CM_BIN column's multi-byte context. The 32 KiB threshold is exactly
 * one column of a 64 KiB s=2 group probe, which is the shape used by the
 * adaptive planner; a 64 KiB gate left those probes on the 2 KiB screen and
 * misclassified a CM_BIN column as DELTA. Both BIN and DELTA are always in
 * the trial set; actual encoded bytes, never entropy alone, decide the mode.
 */
function chooseColumnMode(column: Uint8Array, columnLengths: readonly number[], wideScreen = true): number {
  const length = column.length
  if (!length) return ID.STORE
  let uniform = true
  for (let i = 1; i < length && uniform; i++) if (column[i] !== column[0]) uniform = false
  if (uniform) return ID.FILL
  const baseLen = Math.min(2048, length)
  const baseSample = column.subarray(0, baseLen)
  const baseLengths = columnPrefixLengths(columnLengths, baseLen)
  let screenLen = baseLen
  if (wideScreen && length >= 32768) {
    const rawH = entropy8(baseSample), deltaH = entropy8(columnDelta(baseSample, baseLengths, false))
    if (rawH < 7.5 && deltaH < rawH + 0.1) screenLen = Math.min(length, 32768)
  }
  const sample = column.subarray(0, screenLen)
  const sampleLengths = columnPrefixLengths(columnLengths, screenLen)
  const rawH = entropy8(sample), deltaH = entropy8(columnDelta(sample, sampleLengths, false))
  // Entropy prioritizes the trial order; real encoded bytes decide the winner.
  const modes = deltaH < rawH ? [ID.DELTA, ID.RLE, ID.O0, ID.BIN] : [ID.RLE, ID.O0, ID.BIN, ID.DELTA]
  let best = sample.length, mode: number = ID.STORE
  for (const id of modes) {
    const size = encodeColumn(sample, id, sampleLengths).length
    if (size < best) { best = size; mode = id }
  }
  return mode
}
function encodeTransposeGroup(parts: Uint8Array[], width: number, costs?: ColumnCost, onProgress?: (done: number, total: number) => void, kernel:CMVariant=false, wideScreen=true): Uint8Array {
  if (!Number.isInteger(width) || width < 2 || width > 64) throw new Error('无效的转置步长')
  // A single transposed column stream overfits the second APM stage and the
  // secondary mixer, so every inner CM must be suppressed exactly like the
  // grouped path. Deriving the kernel here (instead of only forwarding the raw
  // argument) keeps the encoder and decoder symmetric for boolean/string
  // kernels alike.
  const cmKernel: CMVariant = kernel === 'v20' ? 'v20' : kernel ? 'v15' : false
  const sup = !!cmKernel && transposeTuning.noApm2
  if (sup) transposeInnerSuppress.depth++
  try {
  const total = parts.reduce((a, p) => a + p.length, 0)
  const writer = new ByteWriter()
  const weights = new Float64Array(width)
  let emptyHeaderBits = 0, completed = 0
  for (let col = 0; col < width; col++) {
    const columnLengths = parts.map(part => part.length > col ? Math.floor((part.length - 1 - col) / width) + 1 : 0)
    const length = columnLengths.reduce((a, b) => a + b, 0)
    const column = new Uint8Array(length)
    let w = 0
    for (const part of parts) for (let i = col; i < part.length; i += width) column[w++] = part[i]
    let mode: number = chooseColumnMode(column, columnLengths, wideScreen)
    let payload = mode === ID.STORE ? column : encodeColumn(column, mode, columnLengths, done => onProgress?.(completed + done, total),cmKernel)
    if (mode !== ID.STORE && payload.length >= length) { mode = ID.STORE; payload = column }
    const header: number[] = [mode]
    putVar(header, payload.length)
    for (const b of header) writer.push(b)
    writer.append(payload)
    weights[col] = length ? (payload.length + header.length) * 8 / length : 0
    if (!length) emptyHeaderBits += header.length * 8
    completed += length
    onProgress?.(completed, total)
  }
  if (costs) applyColumnCosts(parts, width, weights, emptyHeaderBits, costs)
  return writer.finish()
  } finally { if (sup) transposeInnerSuppress.depth-- }
}

function decodeTransposeGroup(payload: Uint8Array, lengths: number[], width: number, onProgress?: (done: number, total: number) => void, kernel:CMVariant=false): Uint8Array[] {
  if (!Number.isInteger(width) || width < 2 || width > 64) throw new Error('无效的转置步长')
  const cmKernel: CMVariant = kernel === 'v20' ? 'v20' : kernel ? 'v15' : false
  const sup = !!cmKernel && transposeTuning.noApm2
  if (sup) transposeInnerSuppress.depth++
  try {
  const parts = lengths.map(n => new Uint8Array(n))
  const total = lengths.reduce((a, b) => a + b, 0), st = {p:0}
  let completed = 0
  for (let col = 0; col < width; col++) {
    const columnLengths = lengths.map(n => n > col ? Math.floor((n - 1 - col) / width) + 1 : 0)
    const length = columnLengths.reduce((a, b) => a + b, 0)
    if (st.p >= payload.length) throw new Error('转置列头被截断')
    const mode = payload[st.p++], pl = getVar(payload, st)
    if (pl > payload.length - st.p) throw new Error('转置列被截断')
    if (![ID.STORE, ID.FILL, ID.RLE, ID.O0, ID.BIN, ID.DELTA].includes(mode as 0 | 1 | 2 | 3 | 5 | 6)) throw new Error('未知转置列编码')
    if ((mode === ID.STORE && pl !== length) || (mode === ID.FILL && (length === 0 || pl !== 1))) throw new Error('转置列长度错误')
    const encoded = payload.subarray(st.p, st.p + pl)
    let decoded: Uint8Array
    if (mode === ID.O0 || mode === ID.BIN || mode === ID.DELTA) {
      const profile = mode === ID.O0 ? 'o0' : mode === ID.BIN ? 'bin' : 'res'
      const bytes = decodeCM(encoded, length, profile, 1, 1, done => onProgress?.(completed + done, total),cmKernel)
      decoded = mode === ID.DELTA ? columnDelta(bytes, columnLengths, true) : bytes
    } else decoded = decodeSpec(encoded, length, {id:mode,s:1,r:1})
    st.p += pl
    let r = 0
    for (const part of parts) for (let i = col; i < part.length; i += width) part[i] = decoded[r++]
    completed += length
    onProgress?.(completed, total)
  }
  if (st.p !== payload.length) throw new Error('转置列包含多余数据')
  return parts
  } finally { if (sup) transposeInnerSuppress.depth-- }
}

// A v5 grouped transpose keeps adjacent columns interleaved within each record.
// This retains cross-column correlations that independent column streams discard.
export const TG_LE32 = 7, TG_LE64 = 8
type ColumnGroup = {start: number; span: number; mode: number; reverse?: boolean}
function groupPartLength(n: number, width: number, start: number, span: number): number {
  return Math.floor(n / width) * span + Math.min(span, Math.max(0, n % width - start))
}
function gatherGroup(parts: Uint8Array[], width: number, start: number, span: number, reverse = false): { data: Uint8Array; lengths: number[] } {
  const lengths = parts.map(p => groupPartLength(p.length, width, start, span))
  const data = new Uint8Array(lengths.reduce((a, b) => a + b, 0))
  let w = 0
  for (const part of parts) for (let row = 0; row < part.length; row += width) {
    const end = Math.min(part.length, row + start + span), begin = Math.min(part.length, row + start)
    if(reverse && end-begin===span) { for(let i=end-1;i>=begin;i--) data[w++]=part[i] }
    else { data.set(part.subarray(begin, end), w); w += end - begin }
  }
  return {data, lengths}
}
function groupDelta(input: Uint8Array, lengths: number[], span: number, inverse: boolean): Uint8Array {
  const out = new Uint8Array(input.length)
  let pos = 0
  for (const len of lengths) {
    for (let i = 0; i < len; i++) {
      const pred = i >= span ? (inverse ? out[pos + i - span] : input[pos + i - span]) : 0
      out[pos + i] = inverse ? (input[pos + i] + pred) & 255 : (input[pos + i] - pred) & 255
    }
    pos += len
  }
  return out
}
function encodeGroupData(input: Uint8Array, mode: number, lengths: number[], span: number, onProgress?: (done: number, total: number) => void, v13 = false, v15: boolean | 'v20' = false, reverse = false, options?:CMOptions): Uint8Array {
  const k: CMVariant = v15==='v20' ? 'v20' : v15 ? 'v15' : v13 ? 'v13' : false
  if (mode === TG_LE32 || mode === TG_LE64) {
    if (!v13 || !transformsV20Enabled() || span !== (mode===TG_LE32 ? 4 : 8)) throw Error('无效 v20 转置差分')
    return markV20Transform(encodeCM(wordRowDelta(input,lengths,span,false,reverse),'bin',span,1,undefined,0,undefined,onProgress,k,span,false,options))
  }
  if (mode === ID.DELTA) return encodeCM(groupDelta(input, lengths, span, false), 'res', span, 1, undefined, 0, undefined, onProgress, k)
  if (mode === ID.O0 || mode === ID.BIN) return encodeCM(input, mode === ID.O0 ? 'o0' : 'bin', v13 && mode===ID.BIN ? span : 1, 1, undefined, 0, undefined, onProgress, k, v13 && mode===ID.BIN ? span : 0,false,mode===ID.BIN?options:undefined)
  return encodeSpec(input, {id:mode,s:1,r:1})
}
function entropy8(d: Uint8Array): number {
  const hist = new Uint32Array(256)
  for (const b of d) hist[b]++
  return entropyFromCounts(hist, d.length)
}
function entropyFromCounts(hist: Uint32Array, total: number): number {
  let h = 0
  for (const count of hist) if (count) { const p = count / total; h -= p * Math.log2(p) }
  return h
}
/**
 * A stride-4 stream whose even/odd sub-columns are really one fundamental
 * stride-2 stream split in two is *harmonic*, not four independent columns.
 * The test is purely statistical (H0/Hd of the four residue classes), bounded
 * to the first 256 KiB, and never looks at a file name or a stored decision.
 * On AITDCC/F the four H0 values are [4.610, 8.000, 4.613, 8.000]; on true
 * stride-4 sources such as E/M the odd half is [8.000, 1.217], i.e. the two
 * odd sub-columns differ by ~6.8 bits/byte and this returns false.
 */
export function isHarmonicStride2Alias(blocks: readonly Uint8Array[]): boolean {
  const total = blocks.reduce((n, b) => n + b.length, 0)
  if (total < 32768) return false
  const cnt = Array.from({ length: 4 }, () => new Uint32Array(256))
  const dcnt = Array.from({ length: 4 }, () => new Uint32Array(256))
  const prev = new Int32Array(4); prev.fill(-1)
  const sampled = Math.min(total, 262144)
  let pos = 0, seen = 0
  for (const block of blocks) {
    if (seen >= sampled) break
    const take = Math.min(block.length, sampled - seen)
    for (let i = 0; i < take; i++, pos++, seen++) {
      const c = pos & 3, b = block[i]
      cnt[c][b]++
      if (prev[c] >= 0) dcnt[c][(b - prev[c]) & 255]++
      prev[c] = b
    }
  }
  if (seen < 32768) return false
  // Normalize every residue class by its own count: a block boundary or a
  // sampled length not divisible by four must not distort an entropy.
  const H0 = cnt.map(h => { const total = h.reduce((a, b) => a + b, 0); return total ? entropyFromCounts(h, total) : 0 })
  const Hd = dcnt.map(h => { const total = h.reduce((a, b) => a + b, 0); return total ? entropyFromCounts(h, total) : 0 })
  return Math.abs(H0[0] - H0[2]) < 0.10 &&
    Math.abs(H0[1] - H0[3]) < 0.10 &&
    Math.abs(Hd[0] - Hd[2]) < 0.10 &&
    Math.abs(Hd[1] - Hd[3]) < 0.10 &&
    Math.abs(H0[0] - H0[1]) > 0.50
}
export function tgPlanningWindow(bytes: number, width: number, v20 = transformsV20Enabled()): number {
  const budget = v20 && bytes >= 131072 ? Math.min(bytes,65536) : Math.min(bytes,16000)
  return Math.floor(budget/width)*width
}
function planColumnGroups(parts: Uint8Array[], width: number, v13 = false, v15: boolean | 'v20' = false): ColumnGroup[] {
  // A wall-clock budget must never leave the segmentation half-built: the DP's
  // costs[]/plans[] arrays are only meaningful once every column has been priced.
  // So the budget skips the search as a whole (the cheap single-group plan is a
  // valid, fully measured fallback) rather than aborting it mid-way.
  if (deadlineHit()) return [{ start: 0, span: width, mode: ID.STORE }]
  // Use a central, record-aligned window from the largest available segment.
  let largest = parts[0] ?? new Uint8Array(0)
  for (const p of parts) if (p.length > largest.length) largest = p
  const sample = sampleWindow(largest, tgPlanningWindow(largest.length,width,v13 && transformsV20Enabled()), width).sample
  const costs = new Float64Array(width + 1), plans: ColumnGroup[][] = Array.from({length:width + 1}, () => [])
  // P30.0：列布局搜索是小表格文件上两万余次探针的真正来源 —— 每个 start 要试
  // 11 个 span × (reverse) × 4~6 个候选，且每个候选都是一次真实编码。
  // 非 max 档位按「先粗后细」裁剪：`fast` 只留 1/2/4/8 四个 span 和两个候选，
  // `balanced` 留 6 个 span、三个候选。`max` 完全不受影响。
  const lvlCols = pruningLevel()
  if (lvlCols > 0 && sample.length >= 4096 && !strictPriorsOn()) {
    // P30.1：可打印 ASCII（表格 / CSV / 日志 / 代码）最终几乎总是被 `text-*`
    // 列上下文拿走（小表格的收益全部来自 text-vertcol，列布局候选全灭）。
    // 在非 max 档位先用样本自身的可打印比例直接否决列布局搜索：
    // 这里只读数据本身，不看文件名、尺寸或外部元信息。
    let printable = 0
    for (let i = 0; i < sample.length; i++) { const b = sample[i]; if ((b >= 0x20 && b <= 0x7e) || b === 9 || b === 10 || b === 13) printable++ }
    if (printable * 20 >= sample.length * 19) return [{ start: 0, span: width, mode: ID.STORE }]
  }
  const spans = lvlCols === 2 ? [1, 2, 4] : lvlCols === 1 ? [1, 2, 3, 4, 6, 8] : [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 64]
  for (let start = width - 1; start >= 0; start--) {
    let best = Infinity, selected: ColumnGroup[] = []
    for (const span of spans) {
      if (start + span > width) continue
      for (const reverse of (v13 && span>=2 && lvlCols === 0 ? [false,true] : [false])) {
        const {data, lengths} = gatherGroup([sample], width, start, span, reverse)
        let size = data.length, mode: number = ID.STORE
        let uniform = data.length > 0
        for (let i = 1; i < data.length && uniform; i++) if (data[i] !== data[0]) uniform = false
        if (uniform) { size = 1; mode = ID.FILL }
        else if (data.length) {
          const rawH = entropy8(data), deltaH = entropy8(groupDelta(data, lengths, span, false))
          // Entropy sets evaluation order; actual byte lengths decide, not entropy alone.
          const options: number[] = lvlCols === 2
            ? (deltaH < rawH ? [ID.DELTA] : [ID.O0])
            : lvlCols === 1
              ? (deltaH < rawH ? [ID.DELTA, ID.O0, ID.BIN] : [ID.O0, ID.BIN, ID.DELTA])
              : deltaH < rawH ? [ID.DELTA, ID.RLE, ID.O0, ID.BIN] : [ID.RLE, ID.O0, ID.BIN, ID.DELTA]
          if (v13 && transformsV20Enabled() && (span===4 || span===8)) options.push(span===4?TG_LE32:TG_LE64)
          // 严格档：列内一律不做模 256 差分 / 跨列算术。DELTA 与 TG_LE* 都是值算术，
          // 置换后同一列的残差完全不同；O0/BIN/STORE/FILL 只依赖当前字节。
          const strictOptions = options.filter(id => id === ID.STORE || id === ID.FILL || id === ID.O0 || id === ID.BIN)
          const useOptions = strictPriorsOn() && strictOptions.length ? strictOptions : options
          for (const candidate of useOptions) {
            const n = encodeGroupData(data, candidate, lengths, span, undefined, v13, v15, reverse).length
            if (n < size) { size = n; mode = candidate }
          }
        }
        const header: number[] = [span, mode]; putVar(header, size)
        const score = size + header.length + costs[start + span]
        if (score < best) { best = score; selected = [{start, span, mode, reverse}, ...plans[start + span]] }
      }
    }
    costs[start] = best; plans[start] = selected
  }
  return plans[0]
}
// Column weights are collected while encoding so that the cost map can be
// filled later without re-running the transpose (they only depend on the
// chosen layout, not on the caller's cost buffer).
interface ColumnWeights { weights: Float64Array; emptyHeaderBits: number }
/** P6-4：转置组内的附加 A/B 开关。 */
export const transposeTuning = {
  /** 转置 + v15 内层是否关掉 a2（结构性规则，编解码两侧对称）。 */
  noApm2: true,
}

/** Encode exactly the requested kernel. The caller already owns the base
 * payload and compares complete costs; never relabel a min(base,v15) payload. */
function encodeGroupedTranspose(parts: Uint8Array[], width: number, costs?: ColumnCost, onProgress?: (done:number,total:number)=>void, v13 = false, collect?: ColumnWeights, v15: boolean | 'v20' = false, options?:CMOptions): Uint8Array {
  // The suppression is a property of the inner single-column CM, not of the v13
  // wire format: ID.TRANSPOSE_GROUP (id 10) runs its inner columns under v15/v20
  // with v13 = false, so gating on `v13` silently left a2/mixer2 enabled there.
  const sup = !!v15 && transposeTuning.noApm2
  if (sup) transposeInnerSuppress.depth++
  try { return encodeGroupedTransposeImpl(parts, width, costs, onProgress, v13, collect, v15, options) }
  finally { if (sup) transposeInnerSuppress.depth-- }
}
function encodeGroupedTransposeImpl(parts: Uint8Array[], width: number, costs?: ColumnCost, onProgress?: (done:number,total:number)=>void, v13 = false, collect?: ColumnWeights, v15: boolean | 'v20' = false, options?:CMOptions): Uint8Array {
  if (!Number.isInteger(width) || width < 2 || width > 64) throw new Error('无效的转置步长')
  const total = parts.reduce((a,p) => a+p.length, 0), writer = new ByteWriter(), weights = new Float64Array(width)
  let done = 0, emptyHeaderBits = 0
  // The small column-layout search NEVER inherits the full group's allocation.
  const columnPlan = withCMProbe(() => planColumnGroups(parts, width, v13, false))
  for (const group of columnPlan) {
    const {data, lengths} = gatherGroup(parts, width, group.start, group.span, group.reverse)
    let mode = group.mode
    if (mode === ID.FILL && data.some(b => b !== data[0])) mode = ID.BIN
    let payload = mode === ID.STORE ? data : withCMBlockSize(total,
      () => encodeGroupData(data, mode, lengths, group.span, n => onProgress?.(done + n, total), v13, v15, !!group.reverse,options))
    if (mode===TG_LE32 || mode===TG_LE64) {
      // Sampling proposes only. Complete channel bytes (including length
      // varint and up to two new outer flag bytes) must beat all plain baselines.
      const price=(p:Uint8Array)=>p.length+varintBytes(p.length)+(payloadModelFlags(p)&V20_FLAG_TRANSFORMS?2:0)
      let bestMode:number=ID.STORE,bestPayload=data
      for(const old of [ID.BIN,ID.DELTA]) {
        const p=withCMBlockSize(total,()=>encodeGroupData(data,old,lengths,group.span,undefined,v13,v15,!!group.reverse,options))
        if(price(p)<price(bestPayload)){bestMode=old;bestPayload=p}
      }
      if(price(payload)>=price(bestPayload)){mode=bestMode;payload=bestPayload}
    }
    if (mode !== ID.STORE && payload.length >= data.length) { mode = ID.STORE; payload = data }
    const header: number[] = [group.span, mode | (group.reverse ? 128 : 0)]; putVar(header, payload.length)
    for (const b of header) writer.push(b)
    writer.append(payload)
    const weight = data.length ? (payload.length + header.length) * 8 / data.length : 0
    for (let c = group.start; c < group.start + group.span; c++) weights[c] = weight
    if (!data.length) emptyHeaderBits += header.length * 8
    done += data.length; onProgress?.(done, total)
  }
  if (costs) applyColumnCosts(parts, width, weights, emptyHeaderBits, costs)
  if (collect) { collect.weights = weights; collect.emptyHeaderBits = emptyHeaderBits }
  return writer.finish()
}
function decodeGroupedTranspose(payload: Uint8Array, lengths: number[], width: number, onProgress?: (done:number,total:number)=>void, v13 = false, v15: boolean | 'v20' = false, options?:CMOptions): Uint8Array[] {
  const sup = !!v15 && transposeTuning.noApm2
  if (sup) transposeInnerSuppress.depth++
  try {
    return withCMBlockSize(lengths.reduce((n, v) => n + v, 0),
      () => decodeGroupedTransposeImpl(payload, lengths, width, onProgress, v13, v15, options))
  } finally {
    if (sup) transposeInnerSuppress.depth--
  }
}
function decodeGroupedTransposeImpl(payload: Uint8Array, lengths: number[], width: number, onProgress?: (done:number,total:number)=>void, v13 = false, v15: boolean | 'v20' = false, options?:CMOptions): Uint8Array[] {
  if (!Number.isInteger(width) || width < 2 || width > 64) throw new Error('无效的转置步长')
  const parts = lengths.map(n => new Uint8Array(n)), total = lengths.reduce((a,b) => a+b,0), st = {p:0}
  let start = 0, done = 0
  while (start < width) {
    if (st.p + 2 > payload.length) throw new Error('转置组头被截断')
    const span = payload[st.p++], flags = payload[st.p++], mode = v13 ? flags & 127 : flags, reverse = v13 && !!(flags&128), pl = getVar(payload, st)
    if (!span || start + span > width || pl > payload.length - st.p) throw new Error('转置组越界')
    const wordDelta=(mode===TG_LE32 && span===4 || mode===TG_LE64 && span===8) && v13 && transformsV20Enabled()
    if (!wordDelta && ![ID.STORE, ID.FILL, ID.RLE, ID.O0, ID.BIN, ID.DELTA].includes(mode as 0|1|2|3|5|6)) throw new Error('未知转置组编码')
    const groupLengths = lengths.map(n => groupPartLength(n, width, start, span)), n = groupLengths.reduce((a,b) => a+b,0)
    if ((mode === ID.STORE && pl !== n) || (mode === ID.FILL && (!n || pl !== 1))) throw new Error('转置组长度错误')
    const encoded = payload.subarray(st.p, st.p + pl); st.p += pl
    let decoded: Uint8Array
    if (wordDelta || mode === ID.O0 || mode === ID.BIN || mode === ID.DELTA) {
      const profile = mode === ID.O0 ? 'o0' : mode === ID.BIN || wordDelta ? 'bin' : 'res'
      const bytes = decodeCM(encoded, n, profile, mode === ID.DELTA || (v13 && (mode===ID.BIN || wordDelta)) ? span : 1, 1, x => onProgress?.(done + x, total), v15==='v20' ? 'v20' : v15 ? 'v15' : v13 ? 'v13' : false, v13 && (mode===ID.BIN || wordDelta) ? span : 0,false,(mode===ID.BIN || wordDelta)?options:undefined)
      decoded = wordDelta ? wordRowDelta(bytes,groupLengths,span,true,reverse) : mode === ID.DELTA ? groupDelta(bytes, groupLengths, span, true) : bytes
    } else decoded = decodeSpec(encoded, n, {id:mode,s:1,r:1})
    let r = 0
    for (const part of parts) for (let row = 0; row < part.length; row += width) {
      const end = Math.min(part.length, row + start + span), begin = Math.min(part.length, row + start)
      if(reverse && end-begin===span) { for(let i=end-1;i>=begin;i--) part[i]=decoded[r++] }
      else { part.set(decoded.subarray(r, r + end - begin), begin); r += end - begin }
    }
    done += n; start += span; onProgress?.(done, total)
  }
  if (st.p !== payload.length) throw new Error('转置组包含多余数据')
  return parts
}

/**
 * P7-0：行预测类规则（D16 / WIDE_GRAD）的 CM 层参数与普通 1D 残差**完全同形**
 * （都是 `('res', 2, 1)`），无法从 profile 区分；而 a2 在 x-ray 这类数据上是
 * 负收益（−4,479 B），在 DELTA_V3 那类数据上是正收益（+1,722 B）。
 * 所以在这里按 **sp.id** 精确抑制：编解码两侧都从同一个 sp 推导，天然对称。
 */
function withRowA2Off<T>(sp: Spec, fn: () => T): T {
  if (sp.id !== ID.D16 && sp.id !== ID.WIDE_GRAD) return fn()
  a2Suppress.depth++
  try { return fn() } finally { a2Suppress.depth-- }
}

const v20Spec = (sp: Spec) => (sp.id === ID.WIDE_GRAD && sp.s >= 3) || (sp.id === ID.BCJ_V3 && sp.s === 2)
const markV20Transform = (p: Uint8Array) => markPayloadModel(p, payloadModelFlags(p) | V20_FLAG_TRANSFORMS)
function checkWide(sp: Spec, lengths: readonly number[]) {
  if (!Number.isInteger(sp.s) || sp.s < 1 || sp.s > (transformsV20Enabled() ? 8 : 2)
    || !Number.isInteger(sp.r) || sp.r < 256 || sp.r > 8192 || sp.r % 2
    || (sp.s >= 3 && lengths.some(n=>n%2))) throw Error('无效宽行预测参数')
}
function encodeWide16(parts: Uint8Array[], sp: Spec, cost?: Float32Array, bins?: CostBins, progress?: (n:number,total:number)=>void, kernel:CMVariant=false, options?:CMOptions, trackFlags=false): Uint8Array {
  const n=parts.reduce((a,b)=>a+b.length,0), joined=new Uint8Array(n), k=isAPMKernel(kernel) ? kernel :'v13'
  let pos=0
  for(const part of parts) {
    const residual=wide16Fwd(part,sp.r,sp.s)
    if(sp.s<6) joined.set(residual,pos)
    else { joined.set(residual.subarray(0,part.length/2),pos/2);joined.set(residual.subarray(part.length/2),n/2+pos/2) }
    pos+=part.length
  }
  if(sp.s<6) return encodeCM(joined,'res2d',2,sp.r,cost,0,bins,progress,k)
  const high=encodeCM(joined.subarray(0,n/2),'res',1,1,undefined,0,undefined,undefined,k)
  const low=encodeCM(joined.subarray(n/2),'res2d',1,sp.r/2,undefined,0,undefined,undefined,k,options?.context==='wide-geom'?sp.r/2:0,false,options)
  const writer=new ByteWriter();writeVar(writer,high.length);writer.append(high);writer.append(low)
  const out=writer.finish()
  if(bins)fillUniformCosts(bins,n,out.length*8)
  if(cost)cost.fill(out.length*8/Math.max(1,n))
  // Keep historical wrappers byte/flag-identical. New v21/control streams retain both planes' actual metadata.
  progress?.(n,n);return options?.context || trackFlags ? inheritPayloadModel(out,high,low) : out
}
function decodeWide16(payload:Uint8Array,lengths:number[],sp:Spec,progress?: (n:number,total:number)=>void,kernel:CMVariant=false,options?:CMOptions):Uint8Array[] {
  const n=lengths.reduce((a,b)=>a+b,0),k=isAPMKernel(kernel) ? kernel :'v13'
  let residual:Uint8Array,high:Uint8Array|undefined,low:Uint8Array|undefined
  if(sp.s<6)residual=decodeCM(payload,n,'res2d',2,sp.r,progress,k)
  else {
    const st={p:0},len=getVar(payload,st)
    if(len<1 || len>=payload.length-st.p)throw Error('宽行平面长度错误')
    high=decodeCM(payload.subarray(st.p,st.p+len),n/2,'res',1,1,undefined,k)
    low=decodeCM(payload.subarray(st.p+len),n/2,'res2d',1,sp.r/2,undefined,k,options?.context==='wide-geom'?sp.r/2:0,false,options)
    residual=new Uint8Array(0)
  }
  let pos=0
  return lengths.map(len=>{
    let part:Uint8Array
    if(sp.s<6)part=residual.subarray(pos,pos+len)
    else {part=new Uint8Array(len);part.set(high!.subarray(pos/2,(pos+len)/2));part.set(low!.subarray(pos/2,(pos+len)/2),len/2)}
    pos+=len;progress?.(pos,n);return wide16Inv(part,sp.r,sp.s)
  })
}

// v3: 变换状态每个区域重置，但残差的 CM 状态由整组共享。
function encodeTerrainGroupImpl(parts: Uint8Array[], sp: Spec, cost?: Float32Array, blockCost?: CostBins, onProgress?: (done: number, total: number) => void, positions?: number[], kernel: CMVariant = false, options?: CMOptions): Uint8Array {
  const n = parts.reduce((sum, p) => sum + p.length, 0)
  if (sp.id === ID.WIDE_GRAD) checkWide(sp, parts.map(p=>p.length))
  if (sp.id === ID.WIDE_GRAD && sp.s>=3) return encodeWide16(parts,sp,cost,blockCost,onProgress,kernel)
  if (sp.id === ID.WIDE_GRAD && sp.s===1) {
    const joined=new Uint8Array(n);let pos=0
    for(const part of parts) {joined.set(d16Fwd(part,1,1),pos);pos+=part.length}
    return encodeCM(joined,'res',2,1,cost,0,blockCost,onProgress,isAPMKernel(kernel) ? kernel :false)
  }
  const v13Kernel: CMVariant = isAPMKernel(kernel) ? kernel : true
  if (sp.id === ID.TRANSPOSE_GROUP_V3) return encodeGroupedTranspose(parts,sp.s,blockCost ?? (cost ? {values:cost,blockSize:1} : undefined),onProgress,true,undefined,kernel==='v20'?'v20':kernel==='v15')
  if (sp.id === ID.TRANSPOSE_2D) {
    const old=encodeGroupedTranspose(parts,sp.s,undefined,undefined,false,undefined,kernel==='v20'?'v20':false), geometric=encodeTranspose2d(parts,sp.s,kernel==='v20'?'v20':true)
    const chosen=geometric.length+1<old.length ? geometric : old, out=new Uint8Array(chosen.length+1)
    out[0]=chosen===geometric ? 1 : 0;out.set(chosen,1);inheritPayloadModel(out, chosen)
    if(blockCost) fillUniformCosts(blockCost,n,out.length*8)
    if(cost) for(let i=0;i<n;i++)cost[i]=out.length*8/Math.max(1,n)
    onProgress?.(n,n);return out
  }
  if (sp.id === ID.MICRO) return encodeMicroGroup(parts,sp,blockCost ?? (cost ? {values:cost,blockSize:1} : undefined),onProgress)
  if (sp.id === ID.SUB_TRANSPOSE || sp.id === ID.SUB_ANCHOR || sp.id === ID.SUB_TRANSPOSE_V3 || sp.id === ID.SUB_ANCHOR_V3) {
    const payload=encodeSubGroups(parts,sp,kernel)
    if(blockCost) fillUniformCosts(blockCost,n,payload.length*8)
    if(cost) for(let i=0;i<n;i++)cost[i]=payload.length*8/Math.max(1,n)
    onProgress?.(n,n);return payload
  }
  if (sp.id === ID.PEEL) {
    const writer=new ByteWriter(); let done=0
    for (const part of parts) {
      const payload=encodePeel([part],sp.s,undefined,(d)=>onProgress?.(done+d,n))
      writeVar(writer,payload.length);writeBytes(writer,payload);done+=part.length
    }
    const payload=writer.finish()
    if(blockCost) fillUniformCosts(blockCost,n,payload.length*8)
    if(cost) for(let i=0;i<n;i++) cost[i]=payload.length*8/Math.max(1,n)
    return payload
  }
  if (sp.id === ID.ANCHOR) {
    const writer = new ByteWriter()
    for (const part of parts) {
      const packed = encodeAnchor(part, sp.s - 1), header: number[] = []
      putVar(header, packed.length)
      for (const b of header) writer.push(b)
      writer.append(packed)
    }
    const result = writer.finish()
    if (blockCost) fillUniformCosts(blockCost, n, result.length * 8)
    if (cost) for (let i=0;i<n;i++) cost[i] = result.length * 8 / Math.max(1,n)
    onProgress?.(n,n)
    return result
  }
  if (sp.id === ID.TRANSPOSE) return encodeTransposeGroup(parts, sp.s, blockCost ?? (cost ? {values:cost, blockSize:1} : undefined), onProgress, kernel==='v20'?'v20':kernel==='v15')
  if (sp.id === ID.TRANSPOSE_GROUP) return encodeGroupedTranspose(parts, sp.s, blockCost ?? (cost ? {values:cost, blockSize:1} : undefined), onProgress, false, undefined, kernel==='v20'?'v20':kernel==='v15')
  const v3 = (sp.id >= ID.TEXT_V3 && sp.id <= ID.DELTA_V3) || sp.id === ID.WIDE_GRAD
  const transformedRule = sp.id === ID.GRAD_V2 || sp.id === ID.BCJ_V2 || sp.id === ID.DELTA || sp.id === ID.GRAD || sp.id === ID.D16 || sp.id === ID.BCJ || sp.id === ID.ANCHOR_FOLD
  if (parts.length === 1 && !transformedRule && !v3) {
    // P9-3.2：单分片的 O0/TEXT/BIN 过去一律落到下面的 encodeSpec，而 encodeSpec 的
    // case ID.TEXT / ID.BIN / ID.O0 都是**不带 kernel 参数**的 encodeCM（本文件 180-184 行），
    // 于是恒定 v9 内核。后果有两层：
    //   ① 直接损失：同一份字节、同一个"恒等 + CM"算子，只换内核就差 3.0 %~7.7 %
    //      （P8 报告 3 §5.8 实测：osdb −3.47 %、dickens −3.01 %、nci −7.70 %）；
    //   ② 结构性锁死：groupV15Candidates 的兜底重编码（本文件 1886 行）会再次落进
    //      这个分支、kernel 被丢掉 → alt 恒等于 base → chooseGroupV15 永不采纳，
    //      于是"单分片 CM 组"根本拿不到 v15（不是测了没赢，是没法测）。
    // 解码端本来就是对称的：decodeTerrainGroupImpl 对 O0/TEXT/BIN 传
    // isAPMKernel(kernel) ? kernel : false，且**没有**单分片特例。所以只需把编码端接上。
    // 映射与解码端逐字对齐；kernel 为 false（默认路径）时行为与改动前逐字节相同。
    if (kernel && legacyCmProfile(sp)) {
      const profile = legacyCmProfile(sp) as Profile
      return tagLegacyCm(encodeCM(parts[0], profile, 1, 1, cost, 0, blockCost, onProgress, isAPMKernel(kernel) ? kernel : false, 0, false, legacyCmOptions(profile, options)), profile, options)
    }
    if (blockCost && legacyCmProfile(sp)) {
      const profile = legacyCmProfile(sp) as Profile
      return tagLegacyCm(encodeCM(parts[0], profile, 1, 1, cost, 0, blockCost, onProgress), profile, options)
    }
    const payload = encodeSpec(parts[0], sp, cost)
    if (blockCost) fillUniformCosts(blockCost, n, payload.length * 8)
    return payload
  }
  const joined = new Uint8Array(n)
  let pos = 0
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi]
    let transformed = part
    if (sp.id === ID.ANCHOR_FOLD) transformed = anchorFoldFwd(part,sp.s,sp.r)
    else if (sp.id === ID.BCJ || sp.id === ID.BCJ_V2 || sp.id === ID.BCJ_V3) transformed = (sp.id===ID.BCJ_V3 && sp.s===2 ? bcjMsbFwd : bcjFwd)(part, positions?.[pi] ?? 0)
    if (sp.id === ID.DELTA || sp.id === ID.DELTA_V3) transformed = deltaFwd(part, sp.s)
    else if (sp.id === ID.GRAD || sp.id === ID.GRAD_V2 || sp.id === ID.GRAD_V3 || sp.id === ID.WIDE_GRAD) transformed = medFwd(part, sp.s, sp.r)
    else if (sp.id === ID.D16) transformed = d16Fwd(part, sp.s, sp.r)
    joined.set(transformed, pos); pos += part.length
  }
  if (sp.id === ID.ANCHOR_FOLD) {
    const payload = encodeCM(joined,sp.r&128 ? 'bin' : 'text',1,1,undefined,0,undefined,onProgress)
    if (blockCost) fillUniformCosts(blockCost,n,payload.length*8)
    if (cost) for (let i=0;i<n;i++) cost[i]=payload.length*8/Math.max(1,n)
    return payload
  }
  if (v3) {
    const payload = encodeCM(joined,sp.id===ID.TEXT_V3?'text':sp.id===ID.GRAD_V3||sp.id===ID.WIDE_GRAD?'res2d':sp.id===ID.DELTA_V3?'res':'bin',sp.id===ID.GRAD_V3||sp.id===ID.WIDE_GRAD||sp.id===ID.DELTA_V3?sp.s:1,sp.id===ID.GRAD_V3||sp.id===ID.WIDE_GRAD?sp.r:1,cost,0,blockCost,onProgress,isAPMKernel(kernel) ? kernel :'v13',0,false,
      (() => { const o: any = options?.matchDist ? {matchDist:true} : {}; if (sp.id === ID.BCJ_V3 && isAPMKernel(kernel)) o.bcj = true; return o })())
    // The flag must travel with the payload it describes; planHeader refuses a group
    // whose matchDist metadata does not match what the payload actually declared.
    return options?.matchDist ? markPayloadModel(payload,payloadModelFlags(payload)|V22_FLAG_MATCH_DISTANCE) : payload
  }
  if (sp.id === ID.BCJ_V2 || sp.id === ID.BIN_V2 || sp.id === ID.TEXT_V2 || sp.id === ID.GRAD_V2) {
    // The decoder branch for these rules already forwarded `options`; the encoder
    // did not, which is the mirror image of the id 4/5 defect (encode without the
    // second table, decode with it). Both sides now derive from legacyCmOptions.
    const profile: Profile = sp.id === ID.TEXT_V2 ? 'text' : sp.id === ID.GRAD_V2 ? 'res2d' : 'bin'
    return tagLegacyCm(encodeCM(joined, profile, sp.id === ID.GRAD_V2 ? sp.s : 1, sp.id === ID.GRAD_V2 ? sp.r : 1, cost, 0, blockCost, onProgress, v13Kernel, sp.id === ID.GRAD_V2 ? sp.r : 0, false, legacyCmOptions(profile, options)), profile, options)
  }
  // BCJ identity `bin` stream: forward the options so the v21 stride-4 context and the
  // v22 second distance table reach it the same way they reach BIN.
  if (sp.id === ID.BCJ) return encodeCM(joined, 'bin', 1, 1, cost, 0, blockCost, onProgress, isAPMKernel(kernel) ? kernel : false, 0, false, legacyCmOptions('bin', options))
  if (sp.id === ID.DELTA) return encodeCM(joined, 'res', sp.s, 1, cost, 0, blockCost, onProgress, isAPMKernel(kernel) ? kernel : false)
  if (sp.id === ID.GRAD) return encodeCM(joined, 'res2d', sp.s, sp.r, cost, 0, blockCost, onProgress, isAPMKernel(kernel) ? kernel : false)
  if (sp.id === ID.D16) return encodeCM(joined, 'res', 2 * sp.s, 1, cost, 0, blockCost, onProgress, isAPMKernel(kernel) ? kernel : false)
  if ((kernel || blockCost) && legacyCmProfile(sp)) {
    const profile = legacyCmProfile(sp) as Profile
    return tagLegacyCm(encodeCM(joined, profile, 1, 1, cost, 0, blockCost, onProgress, isAPMKernel(kernel) ? kernel : false, 0, false, legacyCmOptions(profile, options)), profile, options)
  }
  const payload = encodeSpec(joined, sp, cost)
  if (blockCost) fillUniformCosts(blockCost, n, payload.length * 8)
  return payload
}


/**
 * P4-2：解码 WORD-PRE 封装的分组载荷。
 *
 * 词元流长度在容器里没有单独记录，但它是**自定界**的：CM 解码需要提前知道
 * 输出长度，因此编码端把词元流长度写在载荷最前面的 4 字节定长前缀里。
 */
/**
 * 旧版身份规则（O0/TEXT/BIN）走 CM 内核时的 (profile, options) 交接点。
 *
 * 这三条规则**不经过** `decodeTerrainGroupImpl` 末尾的 v3/V2 分支，而是各自
 * 单独一路，历史上编码端与解码端是两份手写代码。P17.1 给单分片编码端接上
 * `matchDist` 时只改了编码端，解码端漏改 —— 于是 `AITDCC/I`
 * （`segs:1, id:4 CM-TEXT, context:undefined, matchDist:true`）编码时用第二张
 * 距离表、解码时用第一张，解出 3,295,751 B 却全错，且不触发任何头部异常。
 *
 * 两处必须逐字一致，所以现在只有这一个来源：任何一侧要改，另一侧自动跟随。
 */
function legacyCmProfile(sp: Spec): Profile | null {
  return sp.id === ID.O0 ? 'o0' : sp.id === ID.TEXT ? 'text' : sp.id === ID.BIN ? 'bin' : null
}
/**
 * 载荷必须**自带**它实际用到的格式标志：`planHeader` 会拿载荷的 modelFlags 与
 * 组的 `matchDist` 元数据对账，探针编码又不持有容器模型。三处旧规则分支过去
 * 各自决定要不要打这个标记，v3 分支打了、身份规则分支没打 —— 又是同一类漂移。
 */
function tagLegacyCm(payload: Uint8Array, profile: Profile, options?: CMOptions): Uint8Array {
  return legacyCmOptions(profile, options)
    ? markPayloadModel(payload, payloadModelFlags(payload) | V22_FLAG_MATCH_DISTANCE) : payload
}

/** `matchDist` 只对 text/bin 有效（O0 内核不接受），与 matchDistProfileAllowed 同口径。 */
function legacyCmOptions(profile: Profile, options?: CMOptions): CMOptions | undefined {
  return options?.matchDist && (profile === 'text' || profile === 'bin') ? { matchDist: true } : undefined
}

export function encodeTerrainGroup(parts: Uint8Array[], sp: Spec, cost?: Float32Array, blockCost?: CostBins, onProgress?: (done: number, total: number) => void, positions?: number[], kernel: CMVariant = false, options?: CMOptions): Uint8Array {
  checkContextSpec(options,sp,kernel)
  if (v20Spec(sp) && !transformsV20Enabled()) throw Error('v20 变换不能用于旧容器')
  const payload = withCMBlockSize(parts.reduce((n, p) => n + p.length, 0),
    () => withRowA2Off(sp, () => {
      if(options?.context==='xform-bin'||options?.context==='xform-bin-stride4') {
        const inner=options.context==='xform-bin-stride4'?{context:'bin-stride4' as const}:undefined
        if(sp.id===ID.TRANSPOSE_2D) {
          const coded=encodeTranspose2d(parts,sp.s,'v20',inner),p=new Uint8Array(coded.length+1);p[0]=1;p.set(coded,1);return markPayloadModel(p,payloadModelFlags(coded)|V21_FLAG_CONTEXTS)
        }
        const joined=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0
        for(const part of parts){const residual=sp.id===ID.GRAD_V3?medFwd(part,sp.s,sp.r):deltaFwd(part,sp.s);joined.set(residual,at);at+=part.length}
        const p=encodeCM(joined,'bin',1,1,cost,0,blockCost,onProgress,'v20',0,false,inner)
        return markPayloadModel(p,payloadModelFlags(p)|V21_FLAG_CONTEXTS)
      }
      if(options?.context==='wide-geom') { checkWide(sp,parts.map(p=>p.length));return encodeWide16(parts,sp,cost,blockCost,onProgress,kernel,options) }
      if(options?.context==='text-sparse5'||options?.context==='wp-token3'||options?.context==='text-linecol'||options?.context==='text-lexcol'||options?.context==='text-tabcol'||options?.context==='text-vertcol'||options?.context==='sym-2bit'||options?.context==='sym-5bit'||options?.context==='sym-5bit-gap')
        return encodeCM(joinContextBin(parts),'text',1,1,cost,0,blockCost,onProgress,kernel,0,options.context==='wp-token3',options)
      if(options?.context==='bin-stride4' && sp.id===ID.TRANSPOSE_GROUP_V3) return encodeGroupedTranspose(parts,sp.s,blockCost ?? (cost ? {values:cost,blockSize:1} : undefined),onProgress,true,undefined,'v20',options)
      if(options?.context==='bin-stride4') {
        // Every eligible ID is identity BIN *after* its own reversible filter, so
        // BCJ/BCJ2/BCJ3 keep their E8/E9 transform here (contextFilterForward).
        // joinForSpec is deliberately restricted to the old v3 dual-kernel topology,
        // so it cannot join BIN5/19.
        return encodeCM(joinContextBinFiltered(parts,sp,positions),'bin',1,1,cost,0,blockCost,onProgress,kernel,0,false,options)
      }
      return encodeTerrainGroupImpl(parts, sp, cost, blockCost, onProgress, positions, kernel, options)
    }))
  return v20Spec(sp) ? markV20Transform(payload) : payload
}

function decodeTerrainGroupWordPre(payload: Uint8Array, n: number, lengths: number[], sp: Spec, onProgress?: (done: number, total: number) => void, positions?: number[], kernel:CMVariant='v15', options?:CMOptions): Uint8Array[] {
  if (payload.length < 4) throw new Error('词元分组载荷被截断')
  const bodyLen = (payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24)) >>> 0
  if (bodyLen < 1 || bodyLen > MAX_OUTPUT_BYTES) throw new Error('词元流长度非法')
  // `wordPreFwd` 对 n 字节的输入最多产生 2n + 65536 字节的词元体，所以声明长度
  // 超过这个上界一定是伪造的头。没有这条校验时，一个 19 字节的容器可以声明
  // 512 MiB 让算术解码器空转十几分钟（Red-Team D1）。
  let totalRaw = 0
  for (const len of lengths) totalRaw += len
  if (bodyLen > totalRaw * 2 + 65536) throw new Error('词元流长度超出该分组的上界')
  if (totalRaw > 0 && bodyLen === 0) throw new Error('词元流长度为空')
  const body = decodeCM(payload.subarray(4), bodyLen, 'text', 1, 1, onProgress, kernel==='v20'?'v20':'v15', 0, true, options)
  const hl = dictHeaderLen(body)
  if (hl < 0 || hl > body.length) throw new Error('词元词典头非法')
  const joined = wordPreInv(body.subarray(0, hl), body.subarray(hl), n)
  let pos = 0
  return lengths.map((len, index) => {
    const part = joined.subarray(pos, pos + len); pos += len
    const how = sp.id
    if (how === ID.BCJ || how === ID.BCJ_V2 || how === ID.BCJ_V3) return (sp.id===ID.BCJ_V3 && sp.s===2 ? bcjMsbInv : bcjInv)(part, positions?.[index] ?? 0)
    if (how === ID.DELTA || how === ID.DELTA_V3) return deltaInv(part, sp.s)
    if (how === ID.GRAD || how === ID.GRAD_V2 || how === ID.GRAD_V3 || how === ID.WIDE_GRAD) return medInv(part, sp.s, sp.r)
    if (how === ID.D16) return d16Inv(part, sp.s, sp.r)
    return part
  })
}

export function decodeTerrainGroup(payload: Uint8Array, lengths: number[], sp: Spec, onProgress?: (done: number, total: number) => void, positions?: number[], kernel: CMVariant = false, wordPre = false, options?:CMOptions): Uint8Array[] {
  checkContextSpec(options,sp,kernel,wordPre)
  return withCMBlockSize(lengths.reduce((n, v) => n + v, 0),
    () => withRowA2Off(sp, () => {
      if(options?.context==='xform-bin'||options?.context==='xform-bin-stride4') {
        const inner=options.context==='xform-bin-stride4'?{context:'bin-stride4' as const}:undefined
        if(sp.id===ID.TRANSPOSE_2D){if(payload[0]!==1)throw Error('无效二维转置上下文模式');return decodeTranspose2d(payload.subarray(1),lengths,sp.s,'v20',inner)}
        const joined=decodeCM(payload,lengths.reduce((a,b)=>a+b,0),'bin',1,1,onProgress,'v20',0,false,inner);let at=0
        return lengths.map(len=>{const p=joined.subarray(at,at+len);at+=len;return sp.id===ID.GRAD_V3?medInv(p,sp.s,sp.r):deltaInv(p,sp.s)})
      }
      if(options?.context==='wide-geom') {checkWide(sp,lengths);return decodeWide16(payload,lengths,sp,onProgress,kernel,options)}
      if((options?.context==='text-sparse5'||options?.context==='wp-token3'||options?.context==='text-linecol'||options?.context==='text-lexcol'||options?.context==='text-tabcol'||options?.context==='text-vertcol'||options?.context==='sym-2bit'||options?.context==='sym-5bit'||options?.context==='sym-5bit-gap') && !wordPre) {
        const joined=decodeCM(payload,lengths.reduce((a,b)=>a+b,0),'text',1,1,onProgress,kernel,0,options.context==='wp-token3',options)
        let p=0;return lengths.map(n=>{const part=joined.subarray(p,p+n);p+=n;return part})
      }
      if(options?.context==='bin-stride4' && sp.id===ID.TRANSPOSE_GROUP_V3) return decodeGroupedTranspose(payload,lengths,sp.s,onProgress,true,'v20',options)
      if(options?.context==='bin-stride4') {
        const joined=decodeCM(payload,lengths.reduce((a,b)=>a+b,0),'bin',1,1,onProgress,kernel,0,false,options)
        let p=0
        // Mirror of the encoder: undo the group's own reversible filter per fragment.
        return lengths.map((len,i)=>{const filtered=joined.subarray(p,p+len);p+=len
          return contextFilterInverse(filtered,sp,positions?.[i]??0)})
      }
      if(options?.context) return decodeTerrainGroupWordPre(payload,lengths.reduce((a,b)=>a+b,0),lengths,sp,onProgress,positions,kernel,options)
      return decodeTerrainGroupImpl(payload, lengths, sp, onProgress, positions, kernel, wordPre, options)
    }))
}

function decodeTerrainGroupImpl(payload: Uint8Array, lengths: number[], sp: Spec, onProgress?: (done: number, total: number) => void, positions?: number[], kernel: CMVariant = false, wordPre = false, options?: CMOptions): Uint8Array[] {
  let n = lengths.reduce((sum, len) => sum + len, 0)
  if(sp.id===ID.BITPLANE) {
    if(kernel!=='v20'||wordPre||sp.s!==1||(sp.r!==BITPLANE_BYTE_CM&&sp.r!==BITPLANE_BIT_CM&&sp.r!==BITPLANE_PERIOD_CM))throw Error('无效位平面解码参数')
    const joined=sp.r===BITPLANE_PERIOD_CM?decodePeriodBytes(payload,n):decodeBitplanes(payload,n,sp.r);let at=0
    return lengths.map(len=>{const part=joined.subarray(at,at+len);at+=len;return part})
  }
  if(sp.id===ID.REC2) {
    if(kernel!=='v20'||wordPre||sp.s!==1||sp.r!==1||n>MAX_OUTPUT_BYTES-3)throw Error('无效 REC2 解码参数')
    const joined=rec2Inverse(decodeCM(payload,n+3,'bin',1,1,onProgress,'v20'),n)
    let at=0;return lengths.map(len=>{const part=joined.subarray(at,at+len);at+=len;return part})
  }
  // P4-2：载荷被 WORD-PRE 封装过。词典头在明文里是自定界的，但它是**编码后**
  // 的数据，无法从这里直接读——所以真实做法是：先按词元流的长度解一遍。
  // 词元流长度不可预知，这里把解码拆成两步（见下方 wordPreUnwrap）。
  if (wordPre) return decodeTerrainGroupWordPre(payload, n, lengths, sp, onProgress, positions, kernel, options)
  if (sp.id === ID.WIDE_GRAD) checkWide(sp,lengths)
  if (sp.id === ID.WIDE_GRAD && sp.s>=3) return decodeWide16(payload,lengths,sp,onProgress,kernel)
  if (sp.id === ID.WIDE_GRAD && sp.s===1) {
    const joined=decodeCM(payload,n,'res',2,1,onProgress,isAPMKernel(kernel) ? kernel :false);let pos=0
    return lengths.map(len=>{const part=d16Inv(joined.subarray(pos,pos+len),1,1);pos+=len;return part})
  }
  if (sp.id === ID.TRANSPOSE_GROUP_V3) return decodeGroupedTranspose(payload,lengths,sp.s,onProgress,true,kernel==='v20'?'v20':kernel==='v15')
  if (sp.id === ID.TRANSPOSE_2D) {
    if(!payload.length || payload[0]>1) throw Error('无效二维转置模式')
    const result=payload[0] ? decodeTranspose2d(payload.subarray(1),lengths,sp.s,kernel==='v20'?'v20':true) : decodeGroupedTranspose(payload.subarray(1),lengths,sp.s,onProgress,false,kernel==='v20'?'v20':false)
    onProgress?.(n,n);return result
  }
  if (sp.id === ID.MICRO) return decodeMicroGroup(payload,lengths,sp,onProgress)
  if (sp.id === ID.SUB_TRANSPOSE || sp.id === ID.SUB_ANCHOR || sp.id === ID.SUB_TRANSPOSE_V3 || sp.id === ID.SUB_ANCHOR_V3) {
    const decoded=decodeSubGroups(payload,lengths,sp,kernel);onProgress?.(n,n);return decoded
  }
  if (sp.id === ID.PEEL) {
    const st={p:0}, out:Uint8Array[]=[];let done=0
    for(const len of lengths) {
      const size=getVar(payload,st)
      if(size>payload.length-st.p) throw Error('剥离区域被截断')
      out.push(decodePeel(payload.subarray(st.p,st.p+size),[len],sp.s,d=>onProgress?.(done+d,n))[0])
      st.p+=size;done+=len
    }
    if(st.p!==payload.length) throw Error('剥离区域含多余数据')
    return out
  }
  if (sp.id === ID.ANCHOR) {
    const st={p:0}, out:Uint8Array[] = []; let done=0
    for (const len of lengths) {
      const size=getVar(payload,st)
      if (size>payload.length-st.p) throw Error('锚点区域被截断')
      out.push(decodeAnchor(payload.subarray(st.p,st.p+size),len,sp.s-1)); st.p+=size
      done+=len; onProgress?.(done,n)
    }
    if (st.p!==payload.length) throw Error('锚点组包含多余数据')
    return out
  }
  if (sp.id === ID.TRANSPOSE) return decodeTransposeGroup(payload, lengths, sp.s, onProgress, kernel==='v20'?'v20':kernel==='v15')
  // P6-4：id 10 也能以 v15 内核编码（见编码端），解码必须同步用同一内核。
  if (sp.id === ID.TRANSPOSE_GROUP) return decodeGroupedTranspose(payload, lengths, sp.s, onProgress, false, kernel==='v20'?'v20':kernel==='v15')
  let joined: Uint8Array
  if ((sp.id>=ID.TEXT_V3 && sp.id<=ID.DELTA_V3) || sp.id===ID.WIDE_GRAD) joined=decodeCM(payload,n,sp.id===ID.TEXT_V3?'text':sp.id===ID.GRAD_V3||sp.id===ID.WIDE_GRAD?'res2d':sp.id===ID.DELTA_V3?'res':'bin',sp.id===ID.GRAD_V3||sp.id===ID.WIDE_GRAD||sp.id===ID.DELTA_V3?sp.s:1,sp.id===ID.GRAD_V3||sp.id===ID.WIDE_GRAD?sp.r:1,onProgress,isAPMKernel(kernel) ? kernel :'v13',0,false,sp.id === ID.BCJ_V3 && isAPMKernel(kernel) ? { ...options, bcj: true } : options)
  else if (sp.id === ID.BCJ_V2 || sp.id === ID.BIN_V2 || sp.id === ID.TEXT_V2 || sp.id === ID.GRAD_V2)
    joined = decodeCM(payload, n, sp.id === ID.TEXT_V2 ? 'text' : sp.id === ID.GRAD_V2 ? 'res2d' : 'bin', sp.id === ID.GRAD_V2 ? sp.s : 1, sp.id === ID.GRAD_V2 ? sp.r : 1, onProgress, isAPMKernel(kernel) ? kernel : true, sp.id === ID.GRAD_V2 ? sp.r : 0, false, options)
  else if (sp.id === ID.ANCHOR_FOLD) joined = decodeCM(payload,n,sp.r&128 ? 'bin' : 'text',1,1,onProgress)
  else if (sp.id === ID.BCJ) joined = decodeCM(payload, n, 'bin', 1, 1, onProgress, isAPMKernel(kernel) ? kernel : false, 0, false, legacyCmOptions('bin', options))
  else if (sp.id === ID.DELTA) joined = decodeCM(payload, n, 'res', sp.s, 1, onProgress, isAPMKernel(kernel) ? kernel : false)
  else if (sp.id === ID.GRAD) joined = decodeCM(payload, n, 'res2d', sp.s, sp.r, onProgress, isAPMKernel(kernel) ? kernel : false)
  else if (sp.id === ID.D16) joined = decodeCM(payload, n, 'res', 2 * sp.s, 1, onProgress, isAPMKernel(kernel) ? kernel : false)
  else if (legacyCmProfile(sp)) {
    // The encoder honours `matchDist` here; decoding without it silently uses the
    // first distance table and produces the right LENGTH of wrong bytes.
    const profile = legacyCmProfile(sp) as Profile
    joined = decodeCM(payload, n, profile, 1, 1, onProgress, isAPMKernel(kernel) ? kernel : false, 0, false, legacyCmOptions(profile, options))
  } else joined = decodeSpec(payload, n, sp)
  let pos = 0
  return lengths.map((len, index) => {
    const part = joined.subarray(pos, pos + len); pos += len
    if (sp.id === ID.ANCHOR_FOLD) return anchorFoldInv(part,sp.s,sp.r)
    if (sp.id === ID.BCJ || sp.id === ID.BCJ_V2 || sp.id === ID.BCJ_V3) return (sp.id===ID.BCJ_V3 && sp.s===2 ? bcjMsbInv : bcjInv)(part, positions?.[index] ?? 0)
    if (sp.id === ID.DELTA || sp.id === ID.DELTA_V3) return deltaInv(part, sp.s)
    if (sp.id === ID.GRAD || sp.id === ID.GRAD_V2 || sp.id === ID.GRAD_V3 || sp.id === ID.WIDE_GRAD) return medInv(part, sp.s, sp.r)
    if (sp.id === ID.D16) return d16Inv(part, sp.s, sp.r)
    return part
  })
}

// ---------- 自动选择 ----------
const SAMPLE = 40000
// 区域类别必须跨线程传递，用数字码而不是字符串（体积与比较都更省）。
const CLS_CODE: Record<Cls, number> = { fill: 0, noise: 1, text: 2, smooth: 3, repeat: 4, binary: 5 }
// 反向表：worker 收到数字码后必须还原成字符串，否则 `cls === 'text'` 之类的
// 精确比较会静默走错分支（曾经导致 anchor 模式位从 0 变成 128）。
export const CLS_BY_CODE: readonly Cls[] = ['fill', 'noise', 'text', 'smooth', 'repeat', 'binary']
export interface Trial {
  spec: Spec
  label: string
  ratio: number // 压缩后/原始(在采样上)
  sampleLen?: number
  payloadSize?: number
  sampleStart?: number
  sampleStarts?: number[]
  fullSize?: number
  probeSize?: number // 大区域连续热身缓冲区上的实测字节数
  probeLen?: number  // 该热身缓冲区的字节长度（用于把字节数换算成比例）
  probeRate?: number // P7-1：归一化字节率 size/len，跨不同对齐粒度的公平比较口径
  modelFlags?: number
}

// Select a contiguous central window aligned to both the prediction stride and row
// width. Do not splice unrelated image rows or record phases into one trial.
export function sampleWindow(seg: Uint8Array, sampleLimit: number, alignment = 1): { sample: Uint8Array; start: number } {
  if (seg.length <= sampleLimit) return { sample: seg, start: 0 }
  const step = Math.max(1, Math.floor(alignment))
  // Keep whole rows/records where possible; retain a useful sample if the
  // alignment itself is larger than the sample budget.
  const size = step * 4 <= sampleLimit ? Math.floor(sampleLimit / step) * step : sampleLimit
  const start = Math.floor(((seg.length - size) / 2) / step) * step
  return { sample: seg.subarray(start, start + size), start }
}
// Multiple independently encoded windows avoid artificial joins and reset model
// state at each sample boundary. Keep at least four aligned rows per window.
export function sampleWindows(seg: Uint8Array, budget: number, alignment: number, maxWindows = 3): {sample: Uint8Array; start: number}[] {
  const unit = Math.max(1, Math.floor(alignment))
  if (maxWindows <= 1) return [sampleWindow(seg, budget, unit)]
  const piece = Math.floor(Math.floor(budget / 3) / unit) * unit
  if (seg.length <= budget * 6 || piece < unit * 4) return [sampleWindow(seg, budget, unit)]
  return [0.25, 0.5, 0.75].map(f => {
    const start = Math.floor(((seg.length - piece) * f) / unit) * unit
    return {sample:seg.subarray(start, start + piece), start}
  })
}
function gcd(a: number, b: number): number { while (b) { const t = a % b; a = b; b = t } return a }
/** P9 defaults requested for local acceptance; legacy diagnostic switches remain available. */
export const planTuning = {
  /** P13: bounded kernel screening, with exact full-base fallback. */
  groupKernelScreen: true,
  /** Recheck BCJ25 at merged-group scale, independently of tiny segment choices. */
  bcjGroupUpgrade: true,
  /** P7-1：大区域复核按每个候选的专属对齐粒度切探针 + 归一化字节率比较。 */
  perCandidateAlign: true,
  /** P7-2：候选池按多维特征并集生成（不再被 analyze 的单一 kind 封锁）。 */
  featureCandidates: true,
  /** P17.7: 'noise' pools also try DELTA at the lowest-entropy small stride. */
  pocketDeltaCandidates: true,
  /** P17.7: carve low-entropy pockets out of coarse incompressible segments. */
  pocketCarve: true,
  /** P17.9: after the carve, re-price small non-STORE groups with stronger codecs. */
  groupCodecUpgrade: true,
  /** P7-3：孤儿小分组坍缩进主力共享 CM 组（真实 A/B，严格更小才吸收）。 */
  orphanConsolidation: true,
  /**
   * P9-1：孤儿组吸收的体积上限（P7 = 128 KiB）。
   * samba / mozilla 的次要组落在 150 KB ~ 2 MB，全部从 P7 的 128 KiB 门槛下漏网。
   */
  orphanMaxBytes: 2 * 1024 * 1024,
  /** Both limits are strict: <2 MiB AND <20% of the input. */
  orphanMaxFraction: 0.2,
  /** P11 large-file cap; inputs <8 MiB additionally retain P10's cap24. */
  orphanMaxCount: 64,
  /**
   * P9-1：是否允许吸收 STORE / RLE 这类"裸存"组（P7 = 不允许）。
   * STORE 段的字节本来就是原样存盘，恒等并入主力 CM 流不丢任何信息，
   * 却能省掉一整份规则头 + 一次冷启动。
   */
  orphanAllowRawStore: true,
  /** Historical diagnostic knob, retained for old scripts only; never authorizes adoption. */
  orphanSliceProbe: 256 * 1024,
  /**
   * P9-1：整文件单组兜底门。吸收完仍有 >1 个非 FILL 组时，用一段跨组交界的
   * 代表性切片比较"保留多组独立编码" vs "全部并成单一 TEXT_V3 / BIN_V3 组"。
   * 这针对 samba 那 143,316 B 的实验潜力（P8 §5：整份 samba 用单一 TEXT_V3 是
   * 3,503,477 B，现状 3,646,793 B）；候选最终须通过完整容器比较。
   */
  macroUniformGate: true,
  /**
   * P16.2：宏门采样预算（有信息量的字节数，FILL 不计）。
   *
   * 这是**生产值**，不是测试捷径：192 KiB 同时是分组内核探针预算，所以宏门的
   * 定价成本与 P13 的内核筛选同一量级。它必须可调，否则"原始跨度远大于预算、
   * 窗口只能覆盖部分分片"这条分支在生产规模下无法被有界测试覆盖
   * （1.2 MiB 跨度 × 10 条候选 ≈ 2 分钟，见 P16.2 报告）。调小它只会让门看得
   * 更少、更容易返回 null，不会放宽任何采纳条件：最终仍由完整容器严格更小裁决。
   */
  macroProbeBytes: GROUP_KERNEL_PROBE_BYTES,
  /** Bypass sample screening for small files OR text-dominant terrain. */
  macroDirectMaxBytes: 25 * 1024 * 1024,
  macroTextBypass: true,
  /**
   * P9-3.1：把 TRANSPOSE_GROUP_V3(30) 直接放进候选池。
   *
   * 现状：id 30 只在**分组编码阶段**由 `encodePlanTranspose` 从 TRANSPOSE 派生出来
   * （三种布局取小）。但**采样阶段**比的是 legacy TRANSPOSE，于是当 TG_V3 本该大胜时，
   * TRANSPOSE 在采样里就已经输给了 BIN_V3 —— TG_V3 连上场机会都没有。
   * `encodeSpec` / `decodeSpec` 两侧都已支持 id 30（codec.ts:198 / 270），
   * 且它已在 `V15_PROFILES` 名单里，所以放进候选池不需要任何格式改动。
   */
  candidateTgV3: true,
  /**
   * P9-3.2：允许单分片 TEXT / BIN / O0 参与 v15 择优。
   * P7 在 `groupV15Candidates` 里直接早退，理由是"v15 候选与 v13 载荷必然逐字节相同"。
   */
  v15SinglePlain: true,
  /** P9-4.2：采样预算下限（P7 = 4096）。 */
  sampleFloor: 8192,
  /** P9-4.2：采样预算上限（P7 = 16000）。 */
  sampleCap: 16000,
  /**
   * P9-4.2：段数 <= 4 且单段 >= 1 MiB 时允许的采样上限（0 = 关闭，沿用 sampleCap）。
   * nci / reymont / dickens / webster 这类"整份文件就 1 个段"的文件，
   * 一条规则要作用于几十 MB，却只拿到 16 KB 证据。
   */
  soloSampleCap: 65536,
  /**
   * P9-4.3a：从候选生成里剔除 P8 §6.4 普查中**零命中**的历史 ID：
   * RLE / ANCHOR / ANCHOR_FOLD / MICRO / GRAD / GRAD_V2 / PEEL / WIDE_GRAD /
   * SUB_TRANSPOSE_V3（O0 保留给"纯白噪声"兜底分支）。
   * 这 9 个 ID 在该普查切片中胜出 0 次；其它偏移/整文件仍有风险，不能宣称只省时间不改体积。
   * 任务书原清单里的 TEXT_V2（39 次胜出）不在零命中之列，已移到 3b。
   */
  dropZeroHitIds: true,
  /**
   * P9-4.3b：进一步剔除被 V3 支配的 v1/v2 代 ID（TEXT / BIN / DELTA / BCJ /
   * TEXT_V2 / BIN_V2 / GRAD_V2）。这批**不是**零命中（BIN_V2 胜 50 次、覆盖 8.95 % 字节），
   * 所以有体积风险，必须单独归因，不能和 3a 混在一起。
   */
  dropLegacyV12Ids: false,
  /**
   * P8-环节四 诊断开关：把 `chooseSpecImpl` 里那一串经验惩罚系数
   * （1.003 / 1.024 / 1.03 / 1.04 / 1.05 / 0.985 …）全部置 1，
   * 只在 realHeaderCosts=false 的历史诊断模式下生效；生产默认走真实头部计费。
   */
  neutralPenalties: false,
  /** Actual serialized header widths, not empirical ratio multipliers. */
  realHeaderCosts: true,
  /** P18.1: screen-then-single-pass fast path for K <= 4 streams. */
  symbolFastPath: true,
}

const DEFAULT_WORKER_TUNING = JSON.stringify({ planTuning, modelTuning, a2Tuning, cmV20Tuning })
export function workerTuningMatchesDefaults(): boolean {
  return JSON.stringify({ planTuning, modelTuning, a2Tuning, cmV20Tuning }) === DEFAULT_WORKER_TUNING
}

/**
 * P30.0：规划器档位。
 *
 * `'max'` 是默认值，且必须与不带 options 的历史调用**逐字节相同**：所有剪枝分支
 * 都以 `activeLevel !== 'max'` 为前置条件，`'max'` 走的是和 P30.0 之前一样的代码路径。
 *
 * `'balanced'` 与 `'fast'` 只减少**搜索**，不改变容器格式：解码端完全不知道档位存在，
 * 任何档位产生的容器都由同一个 `decompress` 解回。
 */
export {
  currentCompressionLevel,
  pruningLevel,
  setActiveCompressionLevel,
  deadlineActive,
} from './planner/budget'
export type { CompressionLevel } from './planner/budget'

export function sampleBudgetForSegment(totalBytes: number, segments: number, segmentBytes: number): number {
  if (planTuning.soloSampleCap > 0 && segments <= 4 && segmentBytes >= 1024 * 1024)
    return Math.min(segmentBytes, planTuning.soloSampleCap)
  const normal = totalBytes > 5 * 1024 * 1024
    ? Math.min(planTuning.sampleCap, Math.max(planTuning.sampleFloor, Math.floor(8 * 1024 * 1024 / Math.max(1, segments))))
    : SAMPLE
  return Math.min(segmentBytes, normal)
}

export function candidateAlignment(sp: Spec, bestS: number): number {
  const base = Math.max(1, bestS)
  if (sp.id === ID.ANCHOR_FOLD) return base
  if (sp.id === ID.PEEL || sp.id === ID.SUB_TRANSPOSE || sp.id === ID.SUB_TRANSPOSE_V3) return base / gcd(base,sp.s) * sp.s
  if (sp.id === ID.SUB_ANCHOR || sp.id === ID.SUB_ANCHOR_V3) return base
  if (sp.id === ID.WIDE_GRAD) return sp.r
  if (sp.id === ID.MICRO) return sp.r===1 ? base : base / gcd(base,sp.r) * sp.r
  const unit = (sp.id === ID.GRAD || sp.id === ID.GRAD_V2 || sp.id === ID.GRAD_V3 || sp.id === ID.WIDE_GRAD) ? Math.max(1, sp.r) : (sp.id === ID.TRANSPOSE || sp.id === ID.TRANSPOSE_GROUP || sp.id === ID.TRANSPOSE_2D) ? Math.max(1, sp.s) : sp.id === ID.D16 ? Math.max(1, 2 * sp.s) : Math.max(1, sp.s)
  return base / gcd(base, unit) * unit
}

// 大区域复核用的一段连续热身缓冲区：拼不出长流时按真实长度截断即可，
// 但不允许跨越区域边界，因此只从区域内部取连续切片。
function largerProbe(seg: Uint8Array, alignment: number): { sample: Uint8Array; start: number } {
  const unit = Math.max(1, Math.floor(alignment))
  const size = Math.min(seg.length, Math.floor((512 * 1024) / unit) * unit)
  if (size < 64 * 1024) return { sample: seg.subarray(0, 0), start: 0 }
  const start = Math.floor(((seg.length - size) / 2) / unit) * unit
  return { sample: seg.subarray(start, start + size), start }
}
// 复核名单只保留“可能真正赢”的规则族，每个族取采样最优的一名。
//
// 直接按采样名次取前几名在这里是错的：osdb 上采样前四名是 CM-BIN、BCJ-x86、
// CM-BIN2、BCJ2，其中两个 BCJ 名次靠前却不是 CM 族成员（族内没有 V3 目标），
// 复核它们要白花两次 512 KB 编码，而它们的比例本来就落后。按族精选后
// osdb 的名单是 {CM-BIN, CM-BIN3, CM-TEXT3} 三个，量级不变、结论不变。
//
// 上限 3 个：CM 族（TEXT/BIN）各一名 + 当前选择；非 CM 规则只有在采样上
// 真的领先最佳 CM 候选时才补进来（此时它确实可能是赢家）。
function probeCandidates(trials: Trial[], best: Trial, adj: (t: Trial) => number): Trial[] {
  const pool = trials.filter(t => t.spec.id !== ID.ANCHOR_FOLD && t.spec.id !== ID.STORE && t.spec.id !== ID.PEEL)
  const byAdj = pool.slice().sort((a, b) => adj(a) - adj(b))
  const picked: Trial[] = []
  const push = (t?: Trial) => { if (t && !picked.includes(t)) picked.push(t) }
  // 1) 当前选择最先占位：它是“不采用”的基线，必须参与比较。
  push(best)
  // 2) 每个 CM 族取两名最优成员（当前选择已占位则补其后的）。
  //    取两名而不是一名是关键：osdb 上 BIN 族的采样最优是 CM-BIN（52.55%），
  //    真正的赢家 CM-BIN3 只有 53.05%，只取一名就会把它排除，结果退回
  //    2,482,070 B。跨代偏差正是短样本最容易搞错的地方，同一族必须留出可比名次。
  for (const family of CM_FAMILIES) {
    let taken = 0
    for (const t of byAdj) {
      if (!family.members.includes(t.spec.id)) continue
      if (picked.includes(t)) { taken++; continue }
      if (taken >= 2) break
      picked.push(t); taken++
    }
  }
  // 3) 非 CM 候选只有在采样上压过全部已选者时才补进来（此时它确实可能赢）。
  if (picked.length < 4) {
    const strongest = picked.map(adj).reduce((a, b) => Math.min(a, b), Infinity)
    const nonCM = byAdj.find(t => !isFamilyCM(t.spec.id))
    if (nonCM && adj(nonCM) < strongest) push(nonCM)
  }
  return picked.slice(0, 4)
}
function encodeProbe(probe: { sample: Uint8Array; start: number }, spec: Spec, base: number): number {
  // Callers already supply the absolute probe start; do not add it twice (BCJ).
  return planTuning.realHeaderCosts ? pricedGroup(probe.sample, spec, base)
    : encodeSpec(probe.sample, spec, undefined, 0, base).length
}

/**
 * P7-2：候选池的"多维特征"。analyze 的 kind 是一个**互斥**标签，用来展示没问题，
 * 但拿它当候选开关就等于假设"零阶熵高 ⇒ 没有可压结构"。高零阶熵并不等于高条件熵：
 * 32 位指令、定长结构体、IEEE-754 尾数字节都是 h0 > 7.3，但 CM-BIN 的 9 个上下文
 * 或一次差分仍能从里面抠出几个点。
 */
function segFeatures(sample: Uint8Array): { h0: number; hd: number; rep: number } {
  const n = sample.length
  if (n === 0) return { h0: 0, hd: 0, rep: 1 }
  const h = new Float64Array(256), hdd = new Float64Array(256)
  let rep = 0
  for (let i = 0; i < n; i++) {
    h[sample[i]]++
    if (i) {
      const d = (sample[i] - sample[i - 1]) & 255
      hdd[d]++
      if (d === 0) rep++
    }
  }
  const ent = (a: Float64Array, total: number) => {
    let e = 0
    for (let i = 0; i < 256; i++) if (a[i]) { const p = a[i] / total; e -= p * Math.log2(p) }
    return e
  }
  return { h0: ent(h, n), hd: ent(hdd, Math.max(1, n - 1)), rep: rep / Math.max(1, n - 1) }
}

/** Order-0 entropy of the first-order delta sequence `data[i] - data[i-s]`.
 *
 * A smooth multi-byte signal (audio ramp, 16/32-bit counter, slowly drifting
 * sensor value) has a byte entropy near 8.0 but a very narrow delta
 * distribution, which is exactly the structure the DELTA family removes. No
 * name, size or offset knowledge is involved: only the sample's own histogram. */
function deltaEntropy(sample: Uint8Array, stride: number): number {
  if (stride <= 0 || sample.length <= stride + 1) return 8
  const h = new Float64Array(256)
  const n = sample.length - stride
  for (let i = stride; i < sample.length; i++) h[(sample[i] - sample[i - stride]) & 255]++
  let e = 0
  for (let i = 0; i < 256; i++) if (h[i]) { const p = h[i] / n; e -= p * Math.log2(p) }
  return e
}

/** Min of H0 and the first-order delta entropies for strides 1, 2 and 4.
 *
 * Used only as a cheap content screen (never as a size decision): a block whose
 * minimum entropy is far below 8 cannot be incompressible white noise. */
function blockMinEntropy(data: Uint8Array, start: number, end: number): number {
  const n = end - start
  if (n < 8) return 8
  const h = new Float64Array(256)
  for (let i = start; i < end; i++) h[data[i]]++
  let best = 0
  for (let i = 0; i < 256; i++) if (h[i]) { const p = h[i] / n; best -= p * Math.log2(p) }
  for (const stride of [1, 2, 4]) {
    const d = deltaEntropy(data.subarray(start, end), stride)
    if (d < best) best = d
  }
  return best
}

/** P37.2：严格零先验模式禁止一切**字节值算术**候选。
 *
 * 取模 256 的差分、梯度、线性预测、位平面拆分都不是双射不变的：
 * 把字节值做一次 S256 置换，`(a-b)&255` 会变成完全不同的数，规模也随之改变，
 * 于是 `C(π(X)) = C(X)` 不可能成立。严格档只保留**顺序/相等结构**相关的候选
 * （转置、锚点、CM 滞后上下文），换来的是一句可被机器验证的保证。
 * 见 PRIOR_REGISTRY.md §1.3。 */
export const STRICT_FORBIDDEN_SPECS = new Set<number>([
  ID.DELTA, ID.DELTA_V3, ID.GRAD, ID.GRAD_V2, ID.GRAD_V3, ID.WIDE_GRAD,
  ID.REC2, ID.BITPLANE, ID.MICRO,
  // 16 位线性预测/定长记录拆分同样按字节值做模 2^16 算术。
  ID.D16,
  // 锚点族把**字节值**写进头部（`r = anchor + 1`，且 r 的编码还受范围约束），
  // 置换后同一个结构可能根本不可编码 —— 这是格式层面的值依赖，必须一起禁掉。
  ID.ANCHOR, ID.ANCHOR_FOLD, ID.SUB_ANCHOR, ID.SUB_ANCHOR_V3,
])

export function strictAllowsSpec(id: number): boolean {
  return !strictPriorsOn() || !STRICT_FORBIDDEN_SPECS.has(id)
}

export function candidatesFor(seg: Uint8Array, cls: Cls, bestS: number, lagSample: Uint8Array): Spec[] {
  const c: Spec[] = []
  const add = (id: number, s = 1, r = 1) => {
    if (!strictAllowsSpec(id)) return
    if (!c.some(sp => sp.id === id && sp.s === s && sp.r === r)) c.push({ id, s, r })
  }
  let uniform = seg.length > 0
  for (let i = 1; i < seg.length && uniform; i++) if (seg[i] !== seg[0]) uniform = false
  if (uniform) return [{ id: ID.FILL, s: 1, r: 1 }]
  // Cheap gate only; the actual trial must beat the other candidates by 2%.
  // Prior registry §1: the E8/E9 relative-call transform is an x86 prior. The
  // strict profile never proposes it, so no BCJ id can enter a v23 container.
  if (!strictPriorsOn() && (cls === 'binary' || cls === 'repeat' || cls === 'noise')) {
    let calls = 0, plausible = 0
    for (let i = 0; i + 4 < lagSample.length; i++) if (lagSample[i] === 0xe8 || lagSample[i] === 0xe9) {
      calls++; if (lagSample[i + 4] === 0 || lagSample[i + 4] === 255) plausible++
      i += 4
    }
    if (calls >= 6 && plausible * 5 >= calls) { add(ID.BCJ); add(ID.BCJ_V2); add(ID.BCJ_V3); if(transformsV20Enabled())add(ID.BCJ_V3,2) }
  }
  // Candidate gates are cheap and bounded; actual sample encoding includes row
  // lengths and stream headers. The whole region must fit the row-count cap.
  if (seg.length >= 8192 && (cls === 'text' || cls === 'binary' || cls === 'repeat' || cls === 'smooth')) {
    // P37.2：锚点是"分隔符候选"，严格档不能写死 `\n`/`;`/`,`/`\0` 这些 ASCII 值。
    // 改为按出现频次排序取前 2 个**不同字节值**（同频按首次出现位置定序），
    // 这样置换后选择的锚点集合与结构完全相同。
    const anchorsStrict: number[] = (() => {
      const freq = new Int32Array(256), first = new Int32Array(256).fill(-1)
      for (let i = 0; i < lagSample.length; i++) { const b = lagSample[i]; if (freq[b]++ === 0) first[b] = i }
      const act: number[] = []
      for (let b = 0; b < 256; b++) if (freq[b] > 0) act.push(b)
      act.sort((a, b) => freq[b] - freq[a] || first[a] - first[b])
      return act.slice(0, 3)
    })()
    const choices = (strictPriorsOn() ? anchorsStrict : cls === 'smooth' ? [10, 60, 59] : [10, 60, 59, 0]).map(anchor => {
      let count=0
      for (const b of lagSample) if (b===anchor) count++
      return {anchor,count, score: count >= 128 ? anchorPotential(lagSample,anchor) : 0}
    }).filter(x => x.count >= 128 && x.score > 0.15 && lagSample.length / x.count >= 8 && lagSample.length / x.count <= 1024)
      .sort((a,b) => b.score-a.score).slice(0,2)
    for (const choice of choices) if (anchorRowCount(seg,choice.anchor) <= MAX_ANCHOR_ROWS) add(ID.ANCHOR,choice.anchor+1)
  }
  const stride = detectRecordStride(seg)
  if (stride && seg.length >= 8192 && seg.length <= MAX_SUB_CHUNK) { add(ID.SUB_TRANSPOSE,stride,cls==='text'?1:2);add(ID.SUB_TRANSPOSE_V3,stride,cls==='text'?1:2) }
  if (stride && stride >= 4 && seg.length >= 8192 && seg.length <= MAX_PEEL_PART) add(ID.PEEL,stride)
  if (stride) { add(ID.TRANSPOSE, stride); if (stride >= 2 && seg.length >= 32768) add(ID.TRANSPOSE_GROUP, stride) }
  // P9-3.1：让 TG_V3 在**采样阶段**就能上场。定长记录（4 字节指令 / 8 字节 double）
  // 是最典型的受益结构，所以除了 detectRecordStride 命中的步长，再固定试一个 s=4。
  if (planTuning.candidateTgV3 && seg.length >= 32768
      && (cls === 'binary' || cls === 'repeat' || cls === 'smooth' || cls === 'noise')) {
    if (stride && stride >= 2 && stride <= 64) add(ID.TRANSPOSE_GROUP_V3, stride)
    add(ID.TRANSPOSE_GROUP_V3, 4)
  }
  // Repeat and binary may be structured images too. Probe separate windows
  // and the entire region; retain distinct, significant row candidates.
  if (cls === 'smooth' || ((cls === 'repeat' || cls === 'binary') && seg.length >= 8192)) {
    const lags = detectLagCandidates(seg, bestS)
    for (const lag of lags) if (lag > 0 && seg.length > lag * 3 && lagSample.length >= lag * 4) {
      add(ID.GRAD, bestS, lag)
      add(ID.GRAD_V2, bestS, lag)
      add(ID.GRAD_V3, bestS, lag)
      if(seg.length<=16*1024*1024 && bestS<=16 && lag<=4096) add(ID.MICRO,bestS,lag)
    }
  }
  if (seg.length>=4*65536 && (cls==='smooth' || cls==='binary' || cls==='repeat' || cls==='noise')) {
    const lag=detectWide16Lag(seg)
    if(lag) { add(ID.WIDE_GRAD,2,lag);add(ID.WIDE_GRAD,1,lag);if(transformsV20Enabled() && seg.length%2===0)for(let mode=3;mode<=8;mode++)add(ID.WIDE_GRAD,mode,lag) }
  }
  switch (cls) {
    case 'noise': {
      // P7-2：噪声区不再"只能用 O0"。只有真正的纯白噪声（h0、hd 都逼近 8 且几乎
      // 没有相等邻接）才独尊 O0；其余一律把 BIN 放进候选池，差分有效时再加 1D 族。
      const f = planTuning.featureCandidates ? segFeatures(lagSample) : null
      const white = !f || (f.h0 > 7.92 && f.hd > 7.92 && f.rep < 0.01)
      if (white) { add(ID.O0); break }
      // 只在"区域够长"时把 BIN 放进来：短噪声区的 40 KB 采样几乎等于全段，
      // 采样结论本来就不该变；而小段一旦改投 CM-BIN，就会被打散进共享 BIN 组，
      // 冷启动假设不成立（samba 2 MiB +447 B）。
      if (seg.length >= 65536) add(ID.BIN)
      add(ID.O0)
      if (f!.hd < f!.h0 - 0.15) { add(ID.DELTA, bestS); add(ID.DELTA_V3, bestS); if (bestS !== 1) add(ID.DELTA, 1) }
      // 小幅慢变信号（相邻样本只差 ±1..±15）在 O0 眼里仍是 7.95 bit/byte 的
      // "噪声"，但差分分布极窄。只有当某个小步长的差分熵确实很低、并且这个
      // 步长不等于最佳同字节步长时才加候选，避免拿噪声采样去赌。
      if (planTuning.pocketDeltaCandidates && seg.length >= 512) {
        let ds = 0, dh = 8
        for (const stride of [1, 2, 4]) {
          const e = deltaEntropy(lagSample, stride)
          if (e < dh) { dh = e; ds = stride }
        }
        if (ds && dh < 7.45 && ds !== bestS) { add(ID.DELTA, ds); add(ID.DELTA_V3, ds) }
      }
      break
    }
    case 'text': {
      add(ID.TEXT)
      add(ID.BIN)
      // P7-2：结构化文本（定宽表格 / 日志 / 带行号的转储）也有行宽相关性。
      // 只要 bestS > 1 并且区域够长，就把行预测族放进来一起试。
      // "步长相关且差分确实有收益"才放行——只看 bestS > 1 会让 samba 这类
      // 纯文本里的伪步长把 CM-TEXT3 的主力分组打散（实测 2 MiB +447 B）。
      if (planTuning.featureCandidates && bestS > 1 && seg.length >= 8192
          && (() => { const f = segFeatures(lagSample); return f.hd < f.h0 - 0.15 })()) {
        const lags = detectLagCandidates(seg, bestS)
        for (const lag of lags) if (lag > 0 && seg.length > lag * 3 && lagSample.length >= lag * 4) {
          add(ID.GRAD, bestS, lag); add(ID.GRAD_V2, bestS, lag); add(ID.GRAD_V3, bestS, lag)
        }
      }
      break
    }
    case 'repeat':
      add(ID.BIN)
      add(ID.TEXT)
      add(ID.RLE)
      break
    case 'smooth': {
      if(seg.length>=2048 && seg.length<=16*1024*1024 && bestS<=16) add(ID.MICRO,bestS,1)
      add(ID.DELTA, bestS)
      add(ID.DELTA_V3, bestS)
      if (bestS !== 1) add(ID.DELTA, 1)
      if (bestS === 2) { add(ID.D16, 1, 1); add(ID.D16, 1, 2) }
      if (bestS === 4) { add(ID.D16, 2, 1); add(ID.D16, 2, 2); add(ID.D16, 1, 2) }
      add(ID.BIN)
      break
    }
    default:
      add(ID.BIN)
      add(ID.O0)
      add(ID.TEXT)
      add(ID.RLE)
  }
  if (seg.length >= 2048) for (const anchor of detectAnchors(lagSample,cls)) {
    add(ID.ANCHOR_FOLD,anchor.s,anchor.r)
    const raw=anchor.r&127
    if(seg.length<=MAX_SUB_CHUNK && !((raw>=32||raw===9) && anchor.s===raw)) {add(ID.SUB_ANCHOR,anchor.s,anchor.r);add(ID.SUB_ANCHOR_V3,anchor.s,anchor.r)}
  }
  if (c.some(x => x.id === ID.TEXT)) { add(ID.TEXT_V2);add(ID.TEXT_V3) }
  if (c.some(x => x.id === ID.BIN)) { add(ID.BIN_V2);add(ID.BIN_V3) }
  // P9-4.3：剔除历史陪跑 ID。必须在 v2/v3 派生**之后**做——TEXT_V3 / BIN_V3 是靠
  // "池里有 TEXT / BIN" 派生出来的，先删父 ID 会连带把 V3 一起删掉。
  if (planTuning.dropZeroHitIds || planTuning.dropLegacyV12Ids) {
    const drop = new Set<number>()
    // P8 §6.4 普查（12 文件 × 2 MiB、1,240 个区域决策、2,893 次进池）里**胜出 0 次**的
    // 那 10 个 ID。O0 故意不在此列：它在"纯白噪声"兜底分支里有独立用途，剔除要单独归因。
    // 注意 TEXT_V2 **不属于**零命中（39 次胜出、覆盖 0.69 % 字节），它归 3b；
    // 而 WIDE_GRAD 是零命中（0 次胜出），必须在此列。
    if (planTuning.dropZeroHitIds) for (const id of [ID.RLE, ID.ANCHOR, ID.ANCHOR_FOLD, ID.MICRO,
      ID.GRAD, ID.GRAD_V2, ID.PEEL, ID.WIDE_GRAD, ID.SUB_TRANSPOSE_V3]) drop.add(id)
    // 有胜出记录、但被 V3 支配的 v1/v2 代；单独一个旋钮，体积风险单独归因。
    if (planTuning.dropLegacyV12Ids) for (const id of [ID.TEXT, ID.BIN, ID.DELTA, ID.BCJ,
      ID.TEXT_V2, ID.BIN_V2, ID.GRAD_V2]) drop.add(id)
    // O0 只保留"纯白噪声"那一条兜底路径（上面 white 分支里 add 过就留着）。
    const kept = c.filter(sp => !drop.has(sp.id))
    if (kept.length) return kept
  }
  return c
}

/** P10 byte compatibility below 8 MiB includes its 512 KiB/full rechecks.
 * Large files retain P11's bounded probe policy, even for a small segment.
 * Explicit whole-input size avoids main/worker/segment policy disagreement.
 * Exported for virtual-boundary tests; does not allocate the supplied size. */
export function withChooseSpecPolicy<T>(inputBytes: number, fn: () => T): T {
  if (!Number.isSafeInteger(inputBytes) || inputBytes < 0) throw Error('无效的原始输入长度')
  return inputBytes < HUGE_CM_MIN_BYTES ? withCMBlockSize(0, fn) : withCMProbe(fn)
}
function chooseSpecImpl(seg: Uint8Array, cls: Cls, bestS: number, sampleLimit: number, yieldIfNeeded: (() => Promise<void>) | undefined, onTrial?: (label: string) => void, base = 0, inputBytes = seg.length): { spec: Spec; trials: Trial[] } {
  return withChooseSpecPolicy(inputBytes, () => chooseSpecCore(seg, cls, bestS, sampleLimit, yieldIfNeeded, onTrial, base))
}
function chooseSpecCore(seg: Uint8Array, cls: Cls, bestS: number, sampleLimit: number, yieldIfNeeded: (() => Promise<void>) | undefined, onTrial?: (label: string) => void, base = 0): { spec: Spec; trials: Trial[] } {
  const center = sampleWindow(seg, sampleLimit, bestS)
  const trials: Trial[] = [{ spec: { id: ID.STORE, s: 1, r: 1 }, label: 'STORE', ratio: 1, sampleLen: center.sample.length, payloadSize: center.sample.length, sampleStart: center.start }]
  for (const sp of candidatesFor(seg, cls, bestS, center.sample)) {
    onTrial?.(specLabel(sp))
    yieldIfNeeded?.()
    const budget = sp.id === ID.WIDE_GRAD ? Math.max(sampleLimit, 4*sp.r) : sampleLimit
    // 碎片小区域不必跑满三个窗口：预算本来就按区域数缩小，再按三窗口切分会
    // 让每个窗口短到连模型热身都不够。一个窗口就能把候选排出量级。
    const windows = sampleWindows(seg, budget, candidateAlignment(sp, bestS), seg.length < 32 * 1024 ? 1 : 3)
    let size = 0, sampled = 0, flags = 0
    for (const {sample, start} of windows) {
      const encoded = planTuning.realHeaderCosts
        ? encodeTerrainGroup([sample], sp, undefined, undefined, undefined, [base + start])
        : encodeSpec(sample, sp, undefined, 0, base + start)
      const encodedSize = encoded.length
      flags |= payloadModelFlags(encoded)
      size += encodedSize
      if (!planTuning.realHeaderCosts) {
        if (sp.id === ID.ANCHOR_FOLD || sp.id === ID.PEEL) size += 4
        if (sp.id === ID.ANCHOR) { let v=encodedSize; do { size++; v=Math.floor(v/128) } while (v) }
      }
      sampled += sample.length
      yieldIfNeeded?.()
    }
    trials.push({ spec: sp, label: specLabel(sp), ratio: size / Math.max(1, sampled), sampleLen: sampled, payloadSize: size, sampleStart: windows[0].start, sampleStarts: windows.map(w => w.start), modelFlags: flags })
  }
  const adj = (t: Trial) =>
    planTuning.realHeaderCosts ? selectionRatio(t.spec, t.ratio, seg.length, t.modelFlags)
      : planTuning.neutralPenalties ? t.ratio
      : t.ratio * (cls === 'text' && t.spec.id === ID.BIN ? 1.03 : 1) * (t.spec.id === ID.MICRO ? 1.03 : (t.spec.id === ID.SUB_TRANSPOSE || t.spec.id === ID.SUB_ANCHOR || t.spec.id === ID.SUB_TRANSPOSE_V3 || t.spec.id === ID.SUB_ANCHOR_V3) ? 1.006 : t.spec.id === ID.PEEL ? 1.04 : t.spec.id === ID.ANCHOR ? (seg.length <= 1024 * 1024 ? 1.024 : 1.05) : t.spec.id === ID.BCJ ? 1.024 : t.spec.id === ID.STORE ? 1 : 1.003)
  // ANCHOR_FOLD 的准入门槛（1.5% 优势）同样受 neutralPenalties 控制。
  const unpenalized = planTuning.realHeaderCosts || planTuning.neutralPenalties
  const foldGate = unpenalized ? 1 : 0.985
  const full = (sp: Spec, legacyExtra = 0) => planTuning.realHeaderCosts
    ? pricedGroup(seg, sp, base) : encodeSpec(seg, sp, undefined, 0, base).length + legacyExtra
  let best = trials[0]
  for (const t of trials) if (t.spec.id !== ID.ANCHOR_FOLD && adj(t) < adj(best) - 1e-9) best = t
  for (const t of trials) if (t.spec.id === ID.ANCHOR_FOLD && adj(t) < adj(best) * foldGate) best = t
  // A modest region whose peel sample is near the winner merits a real
  // whole-region comparison: mixed child terrains can be missed by sampling.
  const peelTrial = trials.find(t => t.spec.id === ID.PEEL)
  if (peelTrial && seg.length <= 512 * 1024 && peelTrial.ratio < best.ratio * 1.06) {
    let runner = best
    if (runner.spec.id === ID.PEEL) {
      runner = trials.find(t => t.spec.id !== ID.PEEL && t.spec.id !== ID.ANCHOR_FOLD)!
      for (const t of trials) if (t.spec.id !== ID.PEEL && t.spec.id !== ID.ANCHOR_FOLD && adj(t) < adj(runner)) runner=t
    }
    const a=full(peelTrial.spec, 4)
    yieldIfNeeded?.()
    const b=full(runner.spec)
    peelTrial.fullSize=a;runner.fullSize=b
    if(a*(unpenalized?1:1.02)<b) best=peelTrial
    else if(best.spec.id===ID.PEEL) best=runner
  }
  // SUB_* 是多流变换：每个剥离列各自付一遍模型热身，而采样窗口很短，所以它的
  // 样本比总是被系统性高估；单流的 TRANSPOSE_GROUP 只热身一次。这与 PEEL /
  // MICRO / WIDE_GRAD 的"热身成本因候选而异"是同一个偏差，因此用同一条规则处理：
  // 当 SUB 在样本上贴近胜者时，用**整区域**实测决定胜负，而不是相信样本序。
  const subTrial = trials.find(t => t.spec.id === ID.SUB_TRANSPOSE || t.spec.id === ID.SUB_TRANSPOSE_V3)
  if (subTrial && seg.length <= 1024 * 1024 && adj(subTrial) < adj(best) * 1.06) {
    let better = trials.find(t => t !== subTrial && t.spec.id !== ID.ANCHOR_FOLD)!
    for (const t of trials) if (t !== subTrial && t.spec.id !== ID.ANCHOR_FOLD && adj(t) < adj(better)) better = t
    const a = full(subTrial.spec)
    yieldIfNeeded?.()
    const b = full(better.spec)
    subTrial.fullSize = a; better.fullSize = b
    if (a < b) best = subTrial
    else if (best === subTrial) best = better
  }
  if (best.spec.id === ID.ANCHOR_FOLD && seg.length <= 1024 * 1024) {
    let runner = trials.find(t => t.spec.id !== ID.ANCHOR_FOLD)!
    for (const t of trials) if (t.spec.id !== ID.ANCHOR_FOLD && adj(t) < adj(runner)) runner = t
    const a = full(best.spec, 4)
    yieldIfNeeded?.()
    const b = full(runner.spec)
    best.fullSize = a; runner.fullSize = b
    if (a >= b * foldGate) best = runner
  }
  if(best.spec.id===ID.MICRO && seg.length<=1024*1024) {
    let runner=trials.find(t=>t.spec.id!==ID.MICRO)!
    for(const t of trials) if(t.spec.id!==ID.MICRO && adj(t)<adj(runner)) runner=t
    const a=full(best.spec)
    yieldIfNeeded?.()
    const b=full(runner.spec)
    best.fullSize=a;runner.fullSize=b
    if(a*(unpenalized?1:1.02)>=b) best=runner
  }
  if (best.spec.id === ID.WIDE_GRAD && seg.length <= 1024*1024) {
    // Different candidates may have very different sampling warm-up costs.
    // Check several runners on the complete region, not just the sample winner.
    const runners=trials.filter(t=>t.spec.id!==ID.WIDE_GRAD).sort((a,b)=>adj(a)-adj(b)).slice(0,6)
    const wide=best, a=full(wide.spec)
    wide.fullSize=a
    for(const runner of runners) {
      yieldIfNeeded?.()
      const b=full(runner.spec)
      runner.fullSize=b
      if(a*(unpenalized?1:1.02)>=b && (best===wide || b < best.fullSize!)) best=runner
    }
  }
  // For modest segments guard against sample overfitting with full standalone
  // encodes. Shared-model outcomes can still differ across segments.
  if (best.spec.id === ID.ANCHOR && seg.length <= 1024 * 1024) {
    let runner = trials.find(t => t.spec.id !== ID.ANCHOR)!
    for (const t of trials) if (t.spec.id !== ID.ANCHOR && adj(t) < adj(runner)) runner = t
    const a = full(best.spec)
    yieldIfNeeded?.()
    const b = full(runner.spec)
    best.fullSize = a; runner.fullSize = b
    if (a * (unpenalized ? 1 : 1.02) >= b) best = runner
  }
  // 大区域的 40 KB 采样不足以让高阶模型与匹配表收敛（nci 上因此选错 3.8%）。
  // 在采样前几名之间用一段连续热身缓冲区复核：只比采样多花一次数百 KB 的编码，
  // 却能把“短样本欠拟合”与“长流真实表现”区分开。仅当结果明显更好才改写。
  // 仅当区域“本来就是一个大流”时才值得复核：分块型大区域（xml、ooffice、samba）
  // 由大量 1 KB~700 KB 的碎片拼成，中段 512 KB 会横跨许多结构完全不同的碎片，
  // 用它代表整区会在 xml 上选错（+411 B）。碎片占多数时保留采样结论。
  if (seg.length > 1024 * 1024) {
    const ranked = probeCandidates(trials, best, adj)
    // P7-1：每个候选用自己的**专属对齐粒度**切探针。
    //
    // 原来这里只按 `bestS` 切一次 `largerProbe`，然后把同一份缓冲区喂给所有候选。
    // 但 TRANSPOSE(28) / GRAD(r=3800) / D16(2s) / SUB_ANCHOR 这些候选的步长与
    // bestS 不同，切片起点相对它们的结构没有对齐——相位错位会让热身缓冲区里的
    // "行"整体错开，测出来的比例既不代表整区、也系统性偏向恰好与 bestS 对齐的那个。
    // 现在按 `candidateAlignment(spec, bestS)` 分桶缓存探针：每个候选都落在自己
    // 严格对齐（且相对 seg 起点同相位）的连续缓冲区上。
    //
    // 不同桶切出的长度可能相差几个字节，所以优劣一律用**归一化字节率**
    // `size / probe.sample.length` 比较，而不是绝对字节数。
    if (!planTuning.perCandidateAlign) {
      // 旧口径（仅用于 A/B 对照）：一份按 bestS 切的探针喂给所有候选。
      const probe = largerProbe(seg, bestS)
      if (probe.sample.length >= 64 * 1024) {
        let winner: Trial | undefined, winnerSize = Infinity
        for (const t of ranked) {
          const size = encodeProbe(probe, t.spec, base + probe.start)
          t.probeSize = size
          t.probeLen = probe.sample.length
          if (size < winnerSize) { winnerSize = size; winner = t }
        }
        if (winner && winner !== best && winnerSize < (best.probeSize ?? Infinity)) best = winner
      }
      yieldIfNeeded?.()
      return { spec: best.spec, trials: trials.sort((a, b) => a.ratio - b.ratio) }
    }
    const probes = new Map<number, { sample: Uint8Array; start: number }>()
    const probeFor = (align: number) => {
      const key = Math.max(1, Math.floor(align) || 1)
      let p = probes.get(key)
      if (!p) { p = largerProbe(seg, key); probes.set(key, p) }
      return p
    }
    let winner: Trial | undefined, winnerRate = Infinity
    for (const t of ranked) {
      const probe = probeFor(candidateAlignment(t.spec, bestS))
      if (probe.sample.length < 64 * 1024) continue
      const size = encodeProbe(probe, t.spec, base + probe.start)
      t.probeSize = size
      t.probeLen = probe.sample.length
      t.probeRate = size / probe.sample.length
      if (t.probeRate < winnerRate) { winnerRate = t.probeRate; winner = t }
    }
    if (winner) {
      // 严格更小（按归一化率）才改写：探针是连续缓冲区 + 充分热身，比 40 KB 采样
      // 更接近整区真实表现。
      const bestRate = best.probeRate ?? Infinity
      if (winner !== best && winnerRate < bestRate) best = winner
    }
    yieldIfNeeded?.()
  }
  return { spec: best.spec, trials: trials.sort((a, b) => a.ratio - b.ratio) }
}
// 主线程走 async 包装：每处理完一个候选/区域让出一次执行权，保持 UI 响应。
async function chooseSpec(seg: Uint8Array, cls: Cls, bestS: number, sampleLimit: number,
  yieldIfNeeded: (() => Promise<void>) | undefined, onTrial?: (label: string) => void, base = 0, inputBytes = seg.length,
): Promise<{ spec: Spec; trials: Trial[] }> {
  const out = chooseSpecImpl(seg, cls, bestS, sampleLimit, yieldIfNeeded, onTrial, base, inputBytes)
  await yieldIfNeeded?.()
  return out
}

// ---------- 主流程 ----------
export interface SegResult {
  start: number
  end: number
  cls: Cls
  spec: Spec
  label: string
  rawLen: number
  compLen: number
  trialBytes?: number
  trials: Trial[]
  peel?: PeelColumn[]
  subPeel?: SubPeelInfo | AnchorSubInfo
  micro?: {weights:number[];scale:number}
  /** Actual selected payload semantics (v18 low bits; v19 only for 24/23). */
  modelFlags?: number
  context?: CMContext
}

export interface Compressed {
  container: Uint8Array
  analysis: Analysis
  segs: SegResult[]
  blockCost: Float32Array // 压缩后每块 bits/byte
  blockSeg: Int32Array // 每块所属区域
  overhead: number
  /** 仅宏门提出候选时存在；比较的是两份已实际序列化的完整容器。 */
  macroComparison?: MacroComparison
  /** Exact post-family baseline vs a bounded batch of minor-group absorptions. */
  orphanComparison?: MacroComparison
  guardStats?: GuardStats
  wideComparison?: MacroComparison
  contextComparison?: ContextComparison
  /** P17.7: conservative low-entropy pocket carve-out inside coarse STORE/O0 groups. */
  pocketComparison?: PocketComparison
  /** P17.9: exact post-carve group codec upgrades (strict container shrinkage only). */
  groupCodecComparison?: GroupCodecComparison
  bcjComparison?: { baselineBytes: number; candidateBytes: number; accepted: boolean; seams: number }
  rec2Comparison?: { baselineBytes:number; candidateBytes?:number; accepted:boolean; params?:{op:number;a:number;b:number}; error?:string }
}

export interface PocketComparison {
  baselineBytes: number
  candidateBytes: number
  accepted: boolean
  scannedBytes: number
  pockets: { start: number; end: number; parent: number; spec: Spec; payloadBytes: number }[]
  buckets?: { key: string; oldPayload: number | null; newPayload: number; members: number }[]
  error?: string
}

export interface MacroComparison {
  baselineBytes: number
  baselineHeaderBytes: number
  baselineVersion: number
  candidateBytes: number | null
  candidateHeaderBytes: number | null
  candidateVersion: number | null
  contextMacroProbe?: {sampleBytes:number;textBytes:number;binBytes:number;winner:number;alternateBytes?:number;skipped?:string;error?:string}
  accepted: boolean
  proposal: Spec
  sample?: { offset: number; bytes: number; separateBytes: number; uniformBytes: number }
  /** Raw probe-window extent; `sample.bytes` is the informative share of it. */
  sampleSpanBytes?: number
  reusedProbePayload: boolean
  screen?: 'direct' | 'sample'
  rewrittenSegments?: number
  orphanGroups?: number
  error?: string
}

interface PreparedSegment extends PlanSegment { trials: Trial[] }
interface MacroSeed {
  key: string
  flags: number
  payload: Uint8Array
  v15?: boolean
  used: boolean
}
interface MacroProposal {
  spec: Spec
  /** Absent = all non-FILL segments; present = orphan target plus eligible members. */
  members?: Set<number>
  orphanGroups?: number
  screen?: 'direct' | 'sample'
  sample?: MacroComparison['sample']
  /** Raw byte extent of the probe window (may include FILL runs, see `sample`). */
  spanBytes?: number
  seed?: MacroSeed
}
// 只在本次输入内复用；同时匹配规则、原始位置、片段边界和模型配置。
function groupInputKey(spec: Spec, parts: readonly { start: number; end: number }[]): string {
  return `${spec.id},${spec.s},${spec.r}|${parts.map(p => `${p.start}:${p.end}`).join(',')}`
}

/** A dictionary key identifies one independent stream, not just a codec name.
 * Late transpose promotions and cached aliases must never steal another group's
 * key. Keep initial keys reserved, and claim new keys before they are reused.
 * This is a format invariant, not an extra compression heuristic. Exported for
 * bounded tests of both ordinary and >=1 MiB promotion/cache call sites. */
export function planSpecReservations<T extends { spec: Spec }>(groups: readonly T[]) {
  const owners = new Map<string, T>()
  for (const g of groups) {
    const key = groupInputKey(g.spec, [])
    if (owners.has(key)) throw Error('初始方案规则重复')
    owners.set(key, g)
  }
  const available = (group: T, spec: Spec) => {
    const owner = owners.get(groupInputKey(spec, []))
    return owner === undefined || owner === group
  }
  return {
    available,
    claim(group: T, spec: Spec): void {
      if (!available(group, spec)) throw Error('不能覆盖另一组的方案规则')
      owners.set(groupInputKey(spec, []), group)
    },
  }
}

// A plan starts after the existing anchor-unification pass. It is an explicit
// assignment, not a request to rerun candidate selection or anchor optimization.
export interface PlanSegment { start:number; end:number; cls:Cls; spec:Spec; trialBytes?:number; compLen?:number
  /** P18.5: low-cardinality plans pin their exact v20 CM context. */
  context?: CMContext }
export interface PlanCost { totalBytes:number; headerBytes:number; payloadBytes:number; groupCount:number; segmentCount:number }
// reusePayload：载荷已在同族归一阶段按同一规则编码完成，序列化时直接复用。
interface EncodedGroup {
  spec: Spec; payload: Uint8Array; v15?: boolean; wordPre?: boolean; cost: Float32Array
  // An unavailable s2 target is not a measured rejection. Reconsider that
  // candidate if a later guarded plan frees the dictionary identity.
  bcjUpgradeChecked?: boolean
}
type GroupCache = Map<string, EncodedGroup>
type EncodedWork = { bytes: Uint8Array; cost: Float32Array; cand: GroupCandidates | null }
export type GroupJobRunner = (jobs: readonly JobPayload[], loads: readonly number[], data: Uint8Array) => Promise<JobReply[] | null>
export interface GuardStats {
  orphanTrials: number; macroTrials: number; macroPrefetched: number; macroReused: number
  workerJobs: number; workerFallbacks: number; reusedGroups: number; reusedFamilyBases: number
  familyTrials: number; rejectedFamilyTrials: number; reusedTrialBases: number; candidateOnlyJobs: number
}
interface GroupPrefetch { key: string; job: JobPayload; load: number }
interface EncodeRun {
  bases: Map<string, { bytes: Uint8Array; cost: Float32Array }>; reuseGuardBases: boolean
  work: Map<string, EncodedWork>; prefetch?: GroupPrefetch; initial: boolean; batchGuards: boolean
  stats: GuardStats; runner?: GroupJobRunner
}
function newEncodeRun(batchGuards: boolean, runner?: GroupJobRunner, reuseGuardBases = true): EncodeRun {
  return { work: new Map(), bases: new Map(), reuseGuardBases, initial: true, batchGuards, runner, stats: {
    orphanTrials: 0, macroTrials: 0, macroPrefetched: 0, macroReused: 0,
    workerJobs: 0, workerFallbacks: 0, reusedGroups: 0, reusedFamilyBases: 0,
    familyTrials: 0, rejectedFamilyTrials: 0, reusedTrialBases: 0, candidateOnlyJobs: 0,
  } }
}
function finalGroupKey(g: PlanGroup, segs: readonly PlanSegment[]): string {
  return `${encodingModelFlags()}:${+planTuning.v15SinglePlain}:${+planTuning.realHeaderCosts}|${groupInputKey(g.spec, g.members.map(i => segs[i]))}`
}
interface PlanGroup {
  spec: Spec; members: number[]; payload: Uint8Array; reusePayload?: boolean
  /** 该分组用 v15（APM 校准）内核编码（r 的最高位 0x8000）。 */
  v15?: boolean
  /** Exact base costs captured by family evaluation; avoid a second full pass. */
  baseCost?: Float32Array
  /** Family evaluation already compared real base/v15/WORD-PRE streams. */
  candidatesDone?: boolean
  /** Target-key ownership is assigned before worker dispatch. */
  bcjUpgradeAllowed?: boolean
  /** 该分组载荷经 WORD-PRE 词元坍缩封装（r 的次高位 0x4000）。 */
  wordPre?: boolean
  context?: CMContext
  /** v22: this group's payload used the distance-split match model. */
  matchDist?: boolean
}

/** A bounded batch proposal, NEVER a sampled/extrapolated acceptance decision.
 * The final encoder checks both full payload bytes and the complete container.
 * One batch avoids re-encoding the dominant multi-MiB stream up to 64 times. */
export function orphanProposalForProbe(n: number, merged: readonly PlanSegment[]): { spec: Spec; members: number[]; groups: number } | null {
  const plain = new Set<number>([ID.BIN, ID.TEXT, ID.O0, ID.BIN_V2, ID.TEXT_V2, ID.BIN_V3, ID.TEXT_V3])
  const text = new Set<number>([ID.TEXT, ID.TEXT_V2, ID.TEXT_V3])
  const groups = buildPlanGroups(merged)
  const totals = groups.map(g => g.members.reduce((a, i) => a + merged[i].end - merged[i].start, 0))
  let mainIdx = -1
  for (let i = 0; i < groups.length; i++) if (plain.has(groups[i].spec.id)
    && (mainIdx < 0 || totals[i] > totals[mainIdx])) mainIdx = i
  if (mainIdx < 0) return null
  const spec: Spec = { id: text.has(groups[mainIdx].spec.id) ? ID.TEXT_V3 : ID.BIN_V3, s: 1, r: 1 }
  const structured = new Set<number>([ID.TRANSPOSE, ID.TRANSPOSE_GROUP, ID.TRANSPOSE_2D, ID.TRANSPOSE_GROUP_V3,
    ID.GRAD, ID.GRAD_V2, ID.GRAD_V3, ID.WIDE_GRAD, ID.DELTA, ID.DELTA_V3, ID.D16,
    ID.SUB_TRANSPOSE, ID.SUB_TRANSPOSE_V3, ID.SUB_ANCHOR, ID.SUB_ANCHOR_V3, ID.BCJ, ID.BCJ_V2, ID.BCJ_V3])
  const preserve = (i: number) => structured.has(groups[i].spec.id)
    && groups[i].members.every(j => Number.isFinite(merged[j].compLen) && merged[j].compLen! >= 0)
    && groups[i].members.reduce((sum, j) => sum + merged[j].compLen!, 0) < totals[i] * 0.35
  const eligible = (i: number) => i !== mainIdx && totals[i] > 0 && !preserve(i)
    && totals[i] < planTuning.orphanMaxBytes && totals[i] < n * planTuning.orphanMaxFraction
    && groups[i].spec.id !== ID.FILL
    && (planTuning.orphanAllowRawStore || ![ID.STORE, ID.RLE].includes(groups[i].spec.id as 0 | 2))
  // Upgrading a legacy dominant group must not accidentally absorb an existing
  // V3 group that fails the size/count limits. Leave that case to the macro gate.
  const existingTarget = groups.findIndex((g, i) => i !== mainIdx && groupInputKey(g.spec, []) === groupInputKey(spec, []))
  if (existingTarget >= 0 && !eligible(existingTarget)) return null
  const orphans = groups.map((_, i) => i).filter(eligible)
    .sort((a, b) => (a === existingTarget ? -1 : b === existingTarget ? 1 : totals[a] - totals[b]))
    .slice(0, Math.max(0, Math.floor(Math.min(planTuning.orphanMaxCount, n < HUGE_CM_MIN_BYTES ? 24 : Infinity))))
  if (!orphans.length) return null
  return { spec, members: [mainIdx, ...orphans].flatMap(i => groups[i].members).sort((a, b) => a - b), groups: orphans.length }
}
function consolidateOrphans(n: number, merged: readonly PlanSegment[]): MacroProposal | null {
  const p = orphanProposalForProbe(n, merged)
  return p ? { spec: p.spec, members: new Set(p.members), orphanGroups: p.groups, screen: 'direct' } : null
}

/** Pure policy helper: counts bytes, not segment counts, and allocates no corpus. */
export function macroDirectSpec(n: number, merged: readonly PlanSegment[]): Spec | null {
  const groups = buildPlanGroups(merged)
  if (groups.length < 2) return null
  const terrain = new Map<Cls, number>()
  for (const m of merged) terrain.set(m.cls, (terrain.get(m.cls) ?? 0) + m.end - m.start)
  const textDominant = [...terrain].sort((a, b) => b[1] - a[1])[0]?.[0] === 'text'
  if (!(n <= planTuning.macroDirectMaxBytes || (planTuning.macroTextBypass && textDominant))) return null
  if (textDominant) return { id: ID.TEXT_V3, s: 1, r: 1 }
  const dominant = groups.filter(g => g.spec.id !== ID.FILL).sort((a, b) =>
    b.members.reduce((v, i) => v + merged[i].end - merged[i].start, 0)
    - a.members.reduce((v, i) => v + merged[i].end - merged[i].start, 0))[0]
  return dominant ? { ...dominant.spec } : null
}

function directMacroProposal(n: number, merged: readonly PlanSegment[]): MacroProposal | null {
  const spec = macroDirectSpec(n, merged)
  if (!spec) return null
  if (buildPlanGroups(merged).filter(g => g.spec.id !== ID.FILL).length <= 1
    && merged.every(m => m.spec.id === ID.FILL || groupInputKey(m.spec, []) === groupInputKey(spec, []))) return null
  return { spec, screen: 'direct' }
}
function proposalPlan(merged: readonly PreparedSegment[], proposal: MacroProposal): PreparedSegment[] {
  return merged.map((m, i) => {
    const keep = m.spec.id === ID.FILL || (proposal.members && !proposal.members.has(i))
    return { ...m, spec: { ...(keep ? m.spec : proposal.spec) } }
  })
}
/** Prefetch ONLY a macro required under both orphan acceptance/rejection.
 * No speculation when the batch may collapse to a single unchanged group,
 * change the macro rule, or require the large-binary sample screen. */
function guardPrefetch(n: number, segs: readonly SegResult[], orphan: MacroProposal | null): GroupPrefetch | undefined {
  if (!planTuning.macroUniformGate) return
  const before = directMacroProposal(n, segs)
  if (!before) return
  if (orphan) {
    const after = directMacroProposal(n, proposalPlan(segs, orphan))
    if (!after || groupInputKey(before.spec, []) !== groupInputKey(after.spec, [])) return
  }
  const g: PlanGroup = { spec: before.spec, members: segs.map((s,i) => s.spec.id !== ID.FILL ? i : -1).filter(i => i >= 0), payload: new Uint8Array(0) }
  g.bcjUpgradeAllowed=!!bcjUpgradeSpec(g.spec,g.members.reduce((n,i)=>n+segs[i].rawLen,0))
  const { jobs, loads } = groupJobs([g], segs)
  if (jobs.length === 1) return { key: finalGroupKey(g, segs), job: jobs[0], load: loads[0] }
}

/**
 * P9-1：整文件单组兜底门（Macro Uniform Group Gate）。
 *
 * 孤儿吸收是"把小组并进主力组"，但 samba 那种情况是**主力组本身就不该存在这么多**：
 * P8 §5 实测整份 samba 用单一 TEXT_V3 连续编码是 3,503,477 B，而 2,247 段 / 18 组的
 * 现状是 3,646,793 B —— 流水线**输 143,316 B（3.93 %）**。机制是每组都要重付一次
 * 冷启动（P8 §4.2：每多切一刀值 23~41 KB）。
 *
 * 做法：挑一段**跨组交界**的代表性切片（P13 上限 192 KiB，按段边界对齐），
 * 比较"按当前规则分组各自编码"与"全部并成单一 TEXT_V3 / BIN_V3 连续编码"。
 * 统一方案在切片上更小且超过 0.2% 边际才提出候选；边际不承担不回退保证。
 *
 * 只返回候选，不改原方案。样本边际仅筛选成本，最终完整容器择优负责不回退。
 */
function macroUniformGate(data: Uint8Array, merged: PlanSegment[], onStage?: (msg: string, pct: number) => void): MacroProposal | null {
  const PLAIN_V3: number[] = [ID.TEXT_V3, ID.BIN_V3]
  const groups = buildPlanGroups(merged)
  if (groups.length <= 1) return null
  const direct = directMacroProposal(data.length, merged)
  if (direct) {
    onStage?.(`宏组直接试完整主导规则 ${specLabel(direct.spec)}（不经过小窗口门）`, 50)
    return direct
  }
  if (groups.filter(g => g.spec.id !== ID.FILL).length <= 1) return null
  // 已经全是同一个恒等规则了，没什么可并的。
  const nonFill = merged.filter(m => m.spec.id !== ID.FILL)
  if (!nonFill.length) return null
  if (new Set(nonFill.map(m => `${m.spec.id},${m.spec.s},${m.spec.r}`)).size === 1
      && PLAIN_V3.includes(nonFill[0].spec.id)) return null

  // ---- 选一段"最能体现分组碎片"的窗口：按段边界对齐，含最多不同规则 ----
  //
  // 预算按**有信息量的字节**计量，而不是字节跨度。理由：FILL 段是常量游程，
  // 它不进 `inWin`（下面的分组探针只编非 FILL 分片），所以把它的长度记进预算
  // 只会把真正的合作者挤出窗口，白白让门看不见碎片。改成"窗口内非 FILL 字节
  // ≤ WIN"之后，探针成本的天花板与原来完全相同（仍然 ≤ WIN 字节被编码），
  // 但窗口不会再被一段长常量游程挤掉。
  const WIN = Math.min(data.length, Math.max(16 * 1024, planTuning.macroProbeBytes))
  // 采样门槛按有信息量的字节计：这里要比的是"分开编 vs 并成一组"，0.2% 的
  // 判决边际在 16 KiB 上约 33 B，已经大于实测 ≤30 B 的组间帧头成本，再小的
  // 样本只会被帧头噪声支配。成本上限由 WIN 保证，与这个门槛无关。
  const MIN_PROBE_BYTES = 16 * 1024
  let bestA = 0, bestB = 0, bestScore = -1, bestInfo = 0
  {
    const keys = new Map<string, number>()
    let info = 0, lo = 0
    for (let hi = 0; hi < merged.length; hi++) {
      const add = merged[hi]
      if (add.spec.id !== ID.FILL) {
        info += add.end - add.start
        const key = `${add.spec.id},${add.spec.s},${add.spec.r}`
        keys.set(key, (keys.get(key) ?? 0) + 1)
      }
      while (info > WIN && lo < hi) {
        const drop = merged[lo++]
        if (drop.spec.id !== ID.FILL) {
          info -= drop.end - drop.start
          const key = `${drop.spec.id},${drop.spec.s},${drop.spec.r}`
          const left = (keys.get(key) ?? 0) - 1
          if (left > 0) keys.set(key, left); else keys.delete(key)
        }
      }
      // 分数 = 规则种数 × 覆盖字节；并列时偏向覆盖更多的窗口
      const score = keys.size * 1e9 + info
      if (keys.size >= 2 && info >= MIN_PROBE_BYTES && score > bestScore) {
        bestScore = score; bestA = merged[lo].start; bestB = merged[hi].end; bestInfo = info
      }
    }
  }
  if (bestInfo < MIN_PROBE_BYTES) return null

  // ---- 在窗口上算 sep（按当前规则分组）----
  const inWin = merged.filter(m => m.end > bestA && m.start < bestB && m.spec.id !== ID.FILL)
    .map(m => ({ part: data.subarray(Math.max(m.start, bestA), Math.min(m.end, bestB)), pos: Math.max(m.start, bestA), key: `${m.spec.id},${m.spec.s},${m.spec.r}`, spec: m.spec }))
  if (inWin.length < 2) return null
  const bySpec = new Map<string, typeof inWin>()
  for (const x of inWin) { const a = bySpec.get(x.key) ?? []; a.push(x); bySpec.set(x.key, a) }
  if (bySpec.size < 2) return null
  let sep = 0
  try {
    for (const arr of bySpec.values()) {
      sep += probeGroupStream(arr.map(x=>x.part),arr[0].spec,arr.map(x=>x.pos)).cost
    }
  } catch { return null }
  // Probe prices use real serializer widths; exact bitmap/container cost is checked later.

  // ---- 在同样的字节上算 uni（单一恒等规则、单组连续编码）----
  const allParts = inWin.map(x => x.part)
  const allPos = inWin.map(x => x.pos)
  // 候选统一规则：恒等两条 + 定长记录转置族。
  //
  // 为什么必须带上转置（实测依据，probe-p9-macro，mozilla 中部 1 MiB）：
  //   流水线 298,718 / TG_V3(s=4) 272,370（−26,348 B，−8.82 %）/ BIN_V3 299,234（+516）
  // 只试 TEXT_V3/BIN_V3 时，门看到的最好选择比流水线还差 → 正确地拒绝 →
  // 那 26 KB 全部留在桌上。报告 2 §3.4 报的 −20,644 B 就是这一笔。
  //
  // 反过来 samba 上所有统一规则都更差（TEXT_V3 +919 B、TG_V3(s=4) +19,605 B），
  // 所以不能"无条件并组"；下面的边际只筛选候选，最终由完整容器比较兜底。
  const uniCands: Spec[] = PLAIN_V3.map(id => ({ id, s: 1, r: 1 }))
  {
    // 步长来源（三个都只反映窗口里真实存在的结构，不凭空试无效转置）：
    //   1) detectRecordStride 对窗口数据本身的判定（与 candidatesFor 同一个探测器）；
    //   2) 窗口内已有转置族规则的 spec.s（线上已经认为它是记录宽）；
    //   3) 定长记录的典型宽度 4 / 8。
    const strides = new Set<number>([4, 8])
    try {
      // 在**被定价的那份字节**上探测步长，而不是原始跨度：窗口可以横跨很长的
      // FILL 游程（常量不参与定价，也不该参与步长判定），按原始跨度扫会把
      // 无关的常量拉进探测器。拼接后仍限 64 KiB，探测成本与窗口跨度脱钩。
      const joined = new Uint8Array(Math.min(64 * 1024, allParts.reduce((n, p) => n + p.length, 0)))
      let at = 0
      for (const p of allParts) {
        if (at >= joined.length) break
        const take = Math.min(p.length, joined.length - at)
        joined.set(p.subarray(0, take), at); at += take
      }
      if (at) {
        const st = detectRecordStride(joined.subarray(0, at))
        if (st >= 2 && st <= 64) strides.add(st)
      }
    } catch { /* 探测失败就只用 4/8 */ }
    for (const m of merged) {
      if (m.end <= bestA || m.start >= bestB) continue
      if ((m.spec.id === ID.TRANSPOSE || m.spec.id === ID.TRANSPOSE_GROUP
        || m.spec.id === ID.TRANSPOSE_GROUP_V3 || m.spec.id === ID.TRANSPOSE_2D
        || m.spec.id === ID.SUB_TRANSPOSE || m.spec.id === ID.SUB_TRANSPOSE_V3)
        && m.spec.s >= 2 && m.spec.s <= 64) strides.add(m.spec.s)
    }
    for (const st of strides) {
      uniCands.push({ id: ID.TRANSPOSE_GROUP_V3, s: st, r: 1 })
      uniCands.push({ id: ID.TRANSPOSE_GROUP, s: st, r: 1 })
    }
  }
  let bestUni = -1, bestUniSpec: Spec | null = null, bestPayload: Uint8Array | null = null, bestApm=false
  for (const sp of uniCands) {
    try {
      const probed=probeGroupStream(allParts,sp,allPos)
      if(bestUni<0||probed.cost<bestUni){bestUni=probed.cost;bestUniSpec=probed.spec;bestPayload=probed.payload;bestApm=probed.apm}
    } catch { /* 该规则不适用 */ }
  }
  if (bestUni < 0 || !bestUniSpec) return null

  // 样本筛选门槛仍保持原值；不能用这条边际代替后面的完整容器比较
  const margin = Math.max(64, Math.ceil(sep * 0.002))
  if (bestUni + margin >= sep) return null

  const spec: Spec = { ...bestUniSpec }
  // 只有窗口包含候选组的每个完整原分片，载荷才可直接复用。不能拿前缀、
  // 拼接后同长度或不同边界的编码冒充全组。id 10 仍需三布局择优，不借用此缓存。
  const complete = inWin.length === nonFill.length && inWin.every((x, i) =>
    x.pos === nonFill[i].start && x.part.length === nonFill[i].end - nonFill[i].start)
  const seed = complete && bestPayload && allParts.reduce((n,p)=>n+p.length,0) < 512 * 1024 && spec.id !== ID.TRANSPOSE_GROUP
    ? { key: groupInputKey(spec, nonFill), flags: encodingModelFlags(), payload: bestPayload, v15:bestApm, used: false }
    : undefined
  onStage?.(`宏组候选 ${specLabel(spec)}（切片 ${sep} → ${bestUni} B，待完整容器复核）`, 50)
  // `bytes` is the INFORMATION actually priced (non-FILL bytes inside the window),
  // not the raw span. The window may straddle a long constant run; that run is never
  // encoded by either side of the comparison, so reporting it would overstate the
  // evidence. `spanBytes` keeps the raw extent for diagnostics.
  return { spec, screen: 'sample',
    sample: { offset: bestA, bytes: bestInfo, separateBytes: sep, uniformBytes: bestUni },
    spanBytes: bestB - bestA, seed }
}


function mergePlanSegments<T extends PlanSegment>(data:Uint8Array, picks:readonly T[]):T[] {
  const merged:T[]=[]
  for(const p of picks) {
    const last=merged[merged.length-1]
    const canMergeSub=!!last && (p.spec.id===ID.SUB_ANCHOR || p.spec.id===ID.SUB_TRANSPOSE || p.spec.id===ID.SUB_ANCHOR_V3 || p.spec.id===ID.SUB_TRANSPOSE_V3) && p.end-last.start<=MAX_SUB_CHUNK
    if(last && sameSpec(last.spec,p.spec) && (canMergeSub || (p.spec.id!==ID.ANCHOR && p.spec.id!==ID.PEEL && p.spec.id!==ID.SUB_TRANSPOSE && p.spec.id!==ID.SUB_ANCHOR && p.spec.id!==ID.SUB_ANCHOR_V3 && p.spec.id!==ID.SUB_TRANSPOSE_V3 && p.spec.id!==ID.MICRO)) && (p.spec.id!==ID.FILL || data[last.start]===data[p.start])) {
      if(p.end-p.start>last.end-last.start) last.cls=p.cls
      last.end=p.end
    } else merged.push({...p})
  }
  return merged
}
function buildPlanGroups(segs:readonly PlanSegment[]):PlanGroup[] {
  const groups=new Map<string,PlanGroup>()
  for(let i=0;i<segs.length;i++) {
    const spec=segs[i].spec, key=`${spec.id},${spec.s},${spec.r}`
    let g=groups.get(key)
    if(!g) {g={spec,members:[],payload:new Uint8Array(0)};groups.set(key,g)}
    g.members.push(i)
  }
  return [...groups.values()].sort((a,b)=>b.members.length-a.members.length)
}
// ---- 并行任务入口（给 worker 用）-------------------------------------------
// 这些函数与主流程调用的是同一份实现，只是不做进度回调。
// chooseSpecSync 直接跑完 chooseSpec 的整条试探链（含大区域 512 KB 复核），
// 因为它内部所有 await 只是让出执行权，不影响计算结果。
export type { Cls }
export function chooseSpecSync(seg: Uint8Array, cls: Cls, bestS: number, sampleLimit: number, base: number, inputBytes = seg.length): { spec: Spec; trials: Trial[] } {
  return chooseSpecImpl(seg, cls, bestS, sampleLimit, undefined, undefined, base, inputBytes)
}
export function encodeGroupSync(parts: Uint8Array[], spec: Spec, positions: number[], blockCost?: CostBins): Uint8Array {
  return encodeTerrainGroup(parts, spec, undefined, blockCost, undefined, positions)
}
export function encodeSpecsSync(seg: Uint8Array, specs: Spec[], base: number): number[] {
  return withCMProbe(() => specs.map(sp => encodeSpec(seg, sp, undefined, 0, base).length))
}

// 锚点归一用的筛选探针：取第一个区域的中段若干字节，保持在区域内部，
// 不制造人工相邻；长度不足时返回空数组表示跳过筛选。
function anchorUnifyProbe(parts: Uint8Array[]): Uint8Array {
  const first = parts[0]
  const size = Math.min(first.length, 64 * 1024)
  if (size < 8 * 1024) return first.subarray(0, 0)
  const start = Math.floor((first.length - size) / 2)
  return first.subarray(start, start + size)
}

// 试算样本：只编码各成员区域头部一小段，用来在花掉全量编码时间（大区域上
// 要几十秒）之前判断“统一”是否可能更小。样本上的差距远大于 0.2% 时结论与
// 全量一致；不确定的一律进入全量编码，由严格择优兜底。
/** Only a screening estimate; adoption still needs a real full container.
 * Legacy raw codecs retain their original protocol; only APM-capable groups
 * get v15/v20 alternatives. No blanket replacement of historical kernels. */
function probeGroupStream(parts:Uint8Array[],spec:Spec,positions:number[]) {
  const n=parts.reduce((a,p)=>a+p.length,0)
  const specs=[spec],upgrade=bcjUpgradeSpec(spec,n)
  if(upgrade)specs.push(upgrade)
  let best: {payload:Uint8Array;spec:Spec;apm:boolean;cost:number}|undefined
  for(const sp of specs)for(const kernel of (V15_PROFILES.has(sp.id)?[false,'v15',...(cmV20Tuning.enabled?['v20']:[])]:[false]) as CMVariant[]) {
    const payload=withCMProbe(()=>encodeTerrainGroup(parts,sp,undefined,undefined,undefined,positions,kernel))
    const apm=isAPMKernel(kernel),cost=payload.length+selectionHeaderBytes(sp,n,payload.length,payloadModelFlags(payload),apm)
    if(!best||cost<best.cost)best={payload,spec:sp,apm,cost}
  }
  return best!
}
function sampleFamilyBytes(members:PlanGroup[],segs:SegResult[],target:Spec,data:Uint8Array):{unified:number;separate:number;raw:number}|undefined{
  const indices=members.flatMap(g=>g.members).sort((a,b)=>a-b)
  const sample=groupKernelSample(indices.map(i=>data.subarray(segs[i].start,segs[i].end)),indices.map(i=>segs[i].start))
  if(sample.bytes<32*1024)return undefined
  const groupByMember=new Map<number,PlanGroup>()
  for(const g of members)for(const i of g.members)groupByMember.set(i,g)
  const groups=new Map<PlanGroup,{parts:Uint8Array[];positions:number[]}>()
  let si=0
  for(let p=0;p<sample.parts.length;p++) {
    while(si+1<indices.length&&segs[indices[si]].end<=sample.positions[p])si++
    const g=groupByMember.get(indices[si])!,row=groups.get(g)??{parts:[],positions:[]}
    row.parts.push(sample.parts[p]);row.positions.push(sample.positions[p]);groups.set(g,row)
  }
  let separate=0
  for(const [g,row] of groups)separate+=probeGroupStream(row.parts,g.spec,row.positions).cost
  return {unified:probeGroupStream(sample.parts,target,sample.positions).cost,separate,raw:sample.bytes}
}

// 合并同一 family 的纯 CM 分组，前提是统一后的完整载荷更小。
// 严格择优（unified < separate）保证最坏情况下不会比原方案差；
// 失败的尝试只多花一次编码，不改动分组、ID 或容器格式。
async function unifyFamilies(data:Uint8Array,groups:PlanGroup[],segs:SegResult[],onStage:((msg:string,pct:number)=>void)|undefined,yieldIfNeeded:()=>Promise<void>,run?:EncodeRun):Promise<PlanGroup[]>{
  const matches=(g:PlanGroup,f:typeof CM_FAMILIES[number])=>f.members.includes(g.spec.id) && (g.spec.s===1 || (f.name==='BCJ'&&g.spec.s===2)) && g.spec.r===1
  if(groups.filter(g=>isFamilyCM(g.spec.id)).length<2) return groups
  let out=groups.slice()
  for(const family of CM_FAMILIES){
    // 族内只有 1 个活跃分组（或成员规则全同）时统一必然不会更小，
    // 这里在分配任何载荷、跑任何编码之前直接跳过，代价只有一次 filter。
    const members=out.filter(g=>matches(g,family))
    if(members.length<2) continue
    // 先用“还没编码”的载荷长度做门槛判断；这里只用来决定是否值得多跑一遍。
    const raw=members.reduce((sum,g)=>sum+g.members.reduce((a,i)=>a+segs[i].rawLen,0),0)
    if(raw<32*1024) continue
    onStage?.(`同族规则归一 ${family.name} · ${members.length} 组`,50)
    yieldIfNeeded?.()
    const target:Spec={id:family.target,s:1,r:1}
    const memberOrder=members.flatMap(g=>g.members).sort((a,b)=>a-b)
    const parts=memberOrder.map(i=>data.subarray(segs[i].start,segs[i].end))
    // Preflight before encoding full separate streams. Screen rejection never
    // rewrites the plan; final per-group encoding still runs its own candidates.
    const trial=withCMProbe(()=>sampleFamilyBytes(members,segs,target,data))
    if(trial && trial.unified>=trial.separate*1.02){
      onStage?.(`同族规则归一 ${family.name} · 试算未通过（${trial.unified} ≥ ${trial.separate} B / ${trial.raw} B）`,50)
      yieldIfNeeded?.()
      continue
    }
    // 现有各独立分组的真实字节；未编码的在此刻按同一路径编码。
    let separate=0
    const familyKeys=planSpecReservations(out)
    for(const g of members){
      if(!g.payload||g.payload.length===0) {
        const ends = logicalGroupEnds(g, segs)
        g.baseCost = new Float32Array(ends.length)
        g.payload=encodeTerrainGroup(g.members.map(i=>data.subarray(segs[i].start,segs[i].end)),g.spec,
          undefined,{values:g.baseCost,blockSize:BLOCK,ends:Uint32Array.from(ends)},undefined,g.members.map(i=>segs[i].start))
      }
      g.v15 = chooseGroupV15(g.members.map(i=>data.subarray(segs[i].start,segs[i].end)),g,g.members.map(i=>segs[i].start),undefined,sp=>familyKeys.available(g,sp))
      familyKeys.claim(g,g.spec)
      for(const i of g.members){segs[i].spec=g.spec;segs[i].label=specLabel(g.spec)}
      g.candidatesDone = true
      g.reusePayload = true // selected stream + its exact kernel/WORD-PRE metadata
      separate+=g.payload.length
    }
    const unifiedEnds = logicalGroupEnds({ spec: target, members: memberOrder, payload: new Uint8Array(0) }, segs)
    const unifiedCost = new Float32Array(unifiedEnds.length)
    const unifiedBase = encodeTerrainGroup(parts,target,undefined,{values:unifiedCost,blockSize:BLOCK,ends:Uint32Array.from(unifiedEnds)},undefined,memberOrder.map(i=>segs[i].start))
    const candidate: PlanGroup = {spec:target,members:memberOrder,payload:unifiedBase,baseCost:unifiedCost}
    candidate.v15 = chooseGroupV15(parts,candidate,memberOrder.map(i=>segs[i].start),undefined,
      sp=>!out.some(g=>!members.includes(g)&&groupInputKey(g.spec,[])===groupInputKey(sp,[])))
    candidate.candidatesDone = true
    const unified = candidate.payload
    // Retain exact full bases even when family unification loses. A later
    // orphan/macro job with this exact ordered input must not re-encode it.
    if (run) {
      run.stats.familyTrials++
      if (run.reuseGuardBases) run.bases.set(finalGroupKey({spec:target,members:memberOrder,payload:unified},segs),
        {bytes:unifiedBase,cost:unifiedCost})
      if (unified.length >= separate) run.stats.rejectedFamilyTrials++
    }
    const next = out.filter(g=>!members.includes(g)).concat(candidate).sort((a,b)=>a.members[0]-b.members[0])
    const separateCost = separate + planHeader(data.length,segs,out).length
    const unifiedCostBytes = unified.length + planHeader(data.length,segs,next).length
    if(unified.length>=separate || unifiedCostBytes>=separateCost){ onStage?.(`同族规则归一 ${family.name} · 未采用（${unified.length} ≥ ${separate} B）`,50); await yieldIfNeeded?.(); continue }
    const mergedMembers=memberOrder
    out=out.filter(g=>!members.includes(g))
    out.push({...candidate,reusePayload:true})
    out.sort((a,b)=>Math.min(...a.members)-Math.min(...b.members))
    for(const i of mergedMembers){ segs[i].spec=candidate.spec; segs[i].label=specLabel(candidate.spec) }
    onStage?.(`同族规则归一 ${family.name} · ${separate} → ${unified.length} B`,50)
    yieldIfNeeded?.()
  }
  return out
}
// ===== P2：逐组择优启用 v15（APM/SSE 校准）=====
// 默认按同一序列化器计入 r/配置/载荷长度头；全局合并另有完整容器严格兜底。
// 代价是每个候选分组要多编码一次（v13 与 v15 各一遍）。
/** 递归深度守卫：v15 候选本身也会走 encodeTerrainGroup，不能无限递归。 */
let v15Depth = 0
const V15_PROFILES = new Set<number>([
  ID.TEXT, ID.BIN, ID.O0, ID.TEXT_V2, ID.BIN_V2, ID.TEXT_V3, ID.BIN_V3,
  ID.GRAD, ID.GRAD_V2, ID.GRAD_V3, ID.DELTA, ID.DELTA_V3, ID.BCJ, ID.BCJ_V2, ID.BCJ_V3,
  ID.WIDE_GRAD, ID.TRANSPOSE_GROUP_V3,
  // P6-4：sao 的段规则是 **id 10（v12 的 TRANSPOSE_GROUP）**，原先它不在名单里，
  // chooseGroupV15 直接判否，于是 28 字节定长记录上的 v15 收益一直是死代码。
  ID.TRANSPOSE_GROUP,
  // P17.6: id 9 is the single-column transpose. Its inner columns run the same
  // CM as the grouped path, so v15/v20 (with transposeInnerSuppress) is exactly
  // as applicable; leaving it out made the whole kernel search dead code for
  // `F`/`N`-style two-column streams.
  ID.TRANSPOSE,
])

/**
 * 一个分组的「候选集」：不修改任何分组状态，只产出可比的比特流。
 *
 * P4-3 起这份计算既可以在主线程跑（串行路径），也可以交给 worker 跑
 * （并行分组任务）：worker 把 base（v13）与这里的 alt / wordPre 一起回传，
 * 主线程只做与串行**完全相同**的择优，不再重跑一遍编码。
 */
export interface GroupCandidates {
  /** v15 内核候选（只生成alt；完整base由精确缓存或调用方持有）。 */
  alt: Uint8Array | null
  /** WORD-PRE 词元坍缩候选（仅 TEXT_V3）。 */
  wordPre: Uint8Array | null
  v20?: Uint8Array | null
  wordPreV20?: Uint8Array | null
  /** 拼接后（正向变换之后）的字节数，仅用于诊断统计。 */
  rawLen: number
  screening?: KernelScreen[]
  variants?: KernelVariant[]
}

function bcjUpgradeSpec(spec:Spec,rawBytes:number,allowed=true):Spec|null {
  return allowed&&planTuning.bcjGroupUpgrade&&transformsV20Enabled()&&rawBytes>=BCJ_UPGRADE_MIN_BYTES
    && ([ID.BCJ,ID.BCJ_V2,ID.BCJ_V3] as number[]).includes(spec.id)&&spec.s===1&&spec.r===1
    ? {id:ID.BCJ_V3,s:2,r:1}:null
}

/**
 * 计算分组的 v15 / WORD-PRE 候选。纯函数：只依赖输入字节与规则。
 * 返回 null 表示该规则不参与 v15 择优（未编码任何东西）。
 */
function groupV15Candidates(parts: Uint8Array[], spec: Spec, positions: number[],options:GroupCandidateOptions={}): GroupCandidates | null {
  // 递归守卫：v15 候选内部若再触发择优会无限递归。
  if (v15Depth > 0 || !V15_PROFILES.has(spec.id)) return null
  // 单分片的 TEXT / BIN / O0 主路径走 encodeSpec，而 encodeSpec 不接受内核开关
  // （见 encodeTerrainGroup 顶部的单分片特例）：v15 候选与 v13 载荷必然逐字节
  // 相同。这里直接判否，省掉一次毫无意义的整段编码（osdb 那种单大分组尤其明显）。
  // P9-3.2：P7 在这里直接早退，理由是"单分片 TEXT/BIN/O0 走 encodeSpec，
  // 不接受内核开关，v15 候选与 v13 载荷必然逐字节相同"。但基线载荷用的是 v1 内核，
  // 而 encodeCMDual 的 alt 是真 v15，两者并不同构——早退把这份收益一起丢了。
  // 按用户决定默认开启；代价是这类组多跑一次整段编码，性能留待本地整集验收。
  if (!planTuning.v15SinglePlain && parts.length === 1 && (spec.id === ID.TEXT || spec.id === ID.BIN || spec.id === ID.O0)) return null
  v15Depth++
  try {
    const rawLen=parts.reduce((n,p)=>n+p.length,0), screening:KernelScreen[]=[]
    const kernels:GroupKernel[]=cmV20Tuning.enabled?['v15','v20']:['v15']
    const upgrade=bcjUpgradeSpec(spec,rawLen,options.allowBcjUpgrade!==false)
    const recipes=[...kernels.map(kernel=>({kernel,spec})),...(upgrade?kernels.map(kernel=>({kernel,spec:upgrade})):[])]
    const encode=(ps:Uint8Array[],pos:number[],k:GroupKernel,sp=spec)=>encodeGroupV15(ps,sp,pos,k)
      ?? encodeTerrainGroup(ps,sp,undefined,undefined,undefined,pos,k)
    const priced=(p:Uint8Array,n:number,wp=false,sp=spec)=>p.length+(planTuning.realHeaderCosts
      ? selectionHeaderBytes(sp,n,p.length,payloadModelFlags(p),true,wp):0)
    const alignment=spec.id===ID.WIDE_GRAD?spec.r:spec.id===ID.TRANSPOSE||spec.id===ID.TRANSPOSE_GROUP||spec.id===ID.TRANSPOSE_GROUP_V3?spec.s:1
    const sample=(options.screen??planTuning.groupKernelScreen)&&recipes.length>1&&rawLen>=GROUP_KERNEL_MIN_BYTES
      ? groupKernelSample(parts,positions,alignment):null
    const sampled=sample&&sample.bytes>=32768?sample:null
    const rawCosts=sampled?recipes.map(r=>withCMProbe(()=>priced(encode(sampled.parts,sampled.positions,r.kernel,r.spec),sampled.bytes,false,r.spec))):[]
    const selected=sampled?clearProbeWinners(rawCosts):recipes.map((_,i)=>i)
    let alt:Uint8Array|null=null,v20:Uint8Array|null=null
    const variants:KernelVariant[]=[]
    for(const i of selected){
      const r=recipes[i],p=encode(parts,positions,r.kernel,r.spec)
      if(r.spec!==spec)variants.push({spec:{...r.spec},kernel:r.kernel,payload:p,flags:payloadModelFlags(p)})
      else if(r.kernel==='v15')alt=p;else v20=p
    }
    if(sampled)screening.push({kind:'raw',sampleBytes:sampled.bytes,trials:recipes.map((r,i)=>({...r,spec:{...r.spec},bytes:rawCosts[i]})),selected,fullBytes:rawLen*selected.length})
    let wordPre:Uint8Array|null=null,wordPreV20:Uint8Array|null=null
    if(ENABLE_WORDPRE && spec.id===ID.TEXT_V3) {
      const joined=joinForSpec(parts,spec,positions)
      const pre=joined&&rawLen>=32768?wordPreFwdSampled(joined.data,256*1024):null
      if(sampled) {
        // Admission and kernel scheduling are different decisions. Preserve
        // P12's contiguous raw-prefix -> token-body comparison; neither the
        // representative raw-kernel sample nor an unamortized dictionary is
        // a valid substitute for that proven gate. Follow the raw winners so
        // a decisive v20 result never triggers a redundant full WP-v15 encode.
        const wpScreen=screenWordPreCandidates(joined!.data,pre,kernels,selected)
        for(const i of wpScreen.selected){const p=encodeWordPrePayload(pre!,rawLen,kernels[i]);if(kernels[i]==='v15')wordPre=p;else wordPreV20=p}
        screening.push(wpScreen)
      } else {
        wordPre=wordPreTry(joined,'v15',pre)
        if(cmV20Tuning.enabled)wordPreV20=wordPreTry(joined,'v20',pre)
      }
    }
    return {alt,wordPre,rawLen,v20,wordPreV20,...(screening.length?{screening}:{}),...(variants.length?{variants}:{})}
  } finally {
    v15Depth--
  }
}

/** 供 worker / 诊断使用的公开入口（与主线程调用同一份实现）。 */
export function groupV15CandidatesSync(parts: Uint8Array[], spec: Spec, positions: number[],options?:GroupCandidateOptions): GroupCandidates | null {
  return groupV15Candidates(parts, spec, positions,options)
}

/**
 * 保留真实 base；按有界探针选择 v15/v20/WORD-PRE 与可用 BCJ25 候选，完整成本严格择优。
 * BCJ25 升级只在目标规则键可用时采纳；APM/v20 标记与容器旗标共同决定解码语义。
 *
 * `pre` 是已经算好的候选（并行路径来自 worker）；传 undefined 表示就地计算。
 * 无论候选从哪里来，择优判据都只有一条：**严格更小才替换**。
 */
function chooseGroupV15(parts: Uint8Array[], g: PlanGroup, positions: number[], pre?: GroupCandidates | null,
  available:(spec:Spec)=>boolean=()=>true): boolean {
  if (!V15_PROFILES.has(g.spec.id)) { g.wordPre = false; return false }
  const original=g.spec,rawLen=parts.reduce((n,p)=>n+p.length,0)
  const target=bcjUpgradeSpec(original,rawLen)
  const cand = pre === undefined ? groupV15Candidates(parts, original, positions,{allowBcjUpgrade:!!target&&available(target)}) : pre
  if (!cand) return !!g.v15
  const base=g.payload
  const cost=(p:Uint8Array,sp:Spec,apm:boolean,wp=false)=>p.length+(planTuning.realHeaderCosts
    ? selectionHeaderBytes(sp,rawLen,p.length,payloadModelFlags(p),apm,wp):0)
  let chosen=base,chosenSpec=original,chosenApm=!!g.v15,took=!!g.wordPre,bestCost=cost(base,original,chosenApm,took)
  const consider=(p:Uint8Array|null|undefined,sp=original,wp=false)=>{
    if(!p||!available(sp))return
    const price=cost(p,sp,true,wp)
    if(price<bestCost){chosen=p;chosenSpec=sp;chosenApm=true;took=wp;bestCost=price}
  }
  consider(cand.alt);consider(cand.v20)
  for(const v of cand.variants??[])consider(v.payload,v.spec)
  if(original.id===ID.TEXT_V3){consider(cand.wordPre,original,true);consider(cand.wordPreV20,original,true)}
  if((globalThis as any).__V15_STATS)((globalThis as any).__V15_STATS as any[]).push({
    id:original.id,s:original.s,parts:parts.length,rawBytes:rawLen,base:base.length,
    alt:cand.alt?.length??null,v20:cand.v20?.length??null,wordPre:cand.wordPre?.length??null,wordPreV20:cand.wordPreV20?.length??null,
    variants:cand.variants?.map(v=>({spec:v.spec,kernel:v.kernel,bytes:v.payload.length})),
    screening:cand.screening,took:chosen!==base,selectedSpec:chosenSpec,selectedFlags:payloadModelFlags(chosen),selectedBytes:chosen.length,
  })
  if(chosen!==base){g.payload=chosen;g.spec={...chosenSpec};g.reusePayload=false}
  g.wordPre=took
  return chosenApm
}

/**
 * 对一个分组同时算出 **v13 基线路径** 与 **v15 候选** 两份比特流。
 *
 * 注意：
 *   1. `base` 必须由调用方提供（它来自真实那次 v13 编码）。这里只用双流算
 *      `alt`（v15 候选），省下的是"为了比大小而额外跑的那一遍 v15 完整编码"。
 *   2. **不能**拿这里的 `both.base` 当 v13 载荷：P4-1 的 `mht8` 只在 v15 模型里
 *      生效，它会改变匹配状态 `mlen/mptr`，进而改变 `msm` 的演化；一旦 8 字节
 *      长距匹配命中（真实文本里几乎必然命中），双流的 base 流就不再与单跑
 *      `v13` 逐字节相同。只有 `alt` 与单跑 v15 严格等价（probe-dualmap 验证）。
 */
function encodeGroupDual(parts: Uint8Array[], sp: Spec, positions: number[]): Uint8Array | null {
  const joined = joinForSpec(parts, sp, positions)
  if (!joined) return null
  const prof = dualProfile(sp)
  if (!prof) return null
  const both = withRowA2Off(sp, () => encodeCMDual(joined.data, prof.profile, prof.s, prof.r, 'v15', 0))
  return both.alt
}

/** Production needs only alt. Keep the dual implementation below for independent
 * byte-equivalence probes, never serialize its non-legacy base stream. */
function encodeGroupV15(parts: Uint8Array[], sp: Spec, positions: number[], kernel:'v15'|'v20'='v15'): Uint8Array | null {
  const joined = joinForSpec(parts, sp, positions), prof = dualProfile(sp)
  if (!joined || !prof) return null
  // `BCJ_V3` 的 v20 内核在模型里启用 x86 专用上下文（`bcjOn`），解码端在
  // `decodeTerrainGroup`（src/lib/codec.ts:1416）无条件按同一个谓词打开它。
  // `s = 1`（< 32 KiB 的 x86 流在升级到 `s = 2` 之前）走的正是这条候选编码
  // 路径，因此这里必须传入完全相同的选项，否则编码器用 14 个上下文、解码器
  // 用 25 个，逐字节必然发散。
  const opts = sp.id === ID.BCJ_V3 && isAPMKernel(kernel) ? { bcj: true } as const : undefined
  return withCMBlockSize(joined.data.length, () => withRowA2Off(sp,
    () => encodeCM(joined.data, prof.profile, prof.s, prof.r, undefined, 0, undefined, undefined, kernel, 0, false, opts)))
}

/** 供回归测试：候选编码路径必须与地形编码路径对同一 spec/内核产出相同比特流。 */
export function encodeGroupCandidateForProbe(parts: Uint8Array[], sp: Spec, positions: number[], kernel: 'v15' | 'v20'): Uint8Array | null {
  return encodeGroupV15(parts, sp, positions, kernel)
}

/** 供探针交叉验证：直接调用真实的分组双流入门（含 dualProfile 判定）。 */
export function encodeGroupDualForProbe(parts: Uint8Array[], sp: Spec, positions: number[]) {
  return encodeGroupDual(parts, sp, positions)
}

/** 与 encodeTerrainGroup 相同的拼接/正向变换，返回 null 表示该规则不在双流覆盖范围。 */

/**
 * P4-2：TEXT_V3 分组的 WORD-PRE 候选。
 *
 * 在至多 256 KiB 词典样本上建 v1 词典；body/raw > .85 时拒绝。
 * 每个内核分别通过 192 KiB 前缀的实际 CM 比价，至少赢 1% 才编码完整候选。
 * 最终是否采用仍由完整字典/长度前缀/CM/UCZ 头成本严格择优决定。
 */
function wordPreTry(joined: { data: Uint8Array } | null, kernel:'v15'|'v20'='v15', prepared?:WordPreResult|null): Uint8Array | null {
  if (!joined || joined.data.length < 32768) return null
  const data = joined.data
  // 词表用 256 KB 均匀采样统计：64 KB 太窄（xml 上坍缩率只有 0.97，等于没坍缩）。
  const pre = prepared === undefined ? wordPreFwdSampled(data,256*1024) : prepared
  if (!pre) return null
  const collapse = pre.body.length / data.length
  if (collapse > 0.85) return null
  // 预筛用前缀实测：拿 192 KB 前缀按同一词表坍缩，比一遍 plain / wordpre 的 v15 比特数。
  // 这比"坍缩率阈值"准得多——自然语言（dickens/webster）坍缩率也有 0.69，
  // 但替换后 CM 反而变差，只有真编码一遍才能看出来，而前缀只要 ~1 s。
  const probe = Math.min(192 * 1024, data.length)
  const plainProbe = withCMProbe(() => encodeCM(data.subarray(0, probe), 'text', 1, 1, undefined, 0, undefined, undefined, kernel, 0)).length
  const head = collapseWithDict(data.subarray(0, probe), pre.dict)
  if (!head) return null
  const wpProbe = withCMProbe(() => encodeCM(head, 'text', 1, 1, undefined, 0, undefined, undefined, kernel, 0, true)).length
  if (wpProbe >= plainProbe * 0.99) return null
  return encodeWordPrePayload(pre,data.length,kernel)
}

/** P13.1 decision-only WORD-PRE screen, shared by main thread and workers.
 * The full group is used only for length and its already-built dictionary.
 * CM inputs cover at most one contiguous 192 KiB raw prefix and its tokens.
 * Exported so full-group admission can be verified without full CM encoding. */
export function screenWordPreCandidates(data:Uint8Array,pre:WordPreResult|null,
  kernels:readonly GroupKernel[],rawSelected:readonly number[]):KernelScreen {
  const probe=Math.min(GROUP_KERNEL_PROBE_BYTES,data.length),spec={id:ID.TEXT_V3,s:1,r:1}
  const eligible=[...new Set(rawSelected)].filter(i=>Number.isInteger(i)&&i>=0&&i<kernels.length)
  const plainBytes:(number|null)[]=kernels.map(()=>null),bodyBytes:(number|null)[]=kernels.map(()=>null)
  const head=pre&&data.length>=32768&&pre.body.length/data.length<=0.85
    ?collapseWithDict(data.subarray(0,probe),pre.dict):null
  const costs=kernels.map((kernel,i)=>{
    if(!head||!eligible.includes(i))return null
    const plain=withCMProbe(()=>encodeCM(data.subarray(0,probe),'text',1,1,undefined,0,undefined,undefined,kernel,0)).length
    const body=withCMProbe(()=>encodeCM(head,'text',1,1,undefined,0,undefined,undefined,kernel,0,true)).length
    plainBytes[i]=plain;bodyBytes[i]=body
    // No dictionary or UCZ header here, exactly as in P12 wordPreTry. The
    // later complete payload comparison still includes every actual byte.
    return body<plain*0.99?body:null
  })
  const selected=clearProbeWinners(costs)
  return {kind:'wordpre',sampleBytes:probe,trials:kernels.map((kernel,i)=>({kernel,spec:{...spec},bytes:costs[i]})),
    selected,fullBytes:data.length*selected.length,
    wordPreGate:{policy:'p12-contiguous-body',dictionaryBytes:pre?.header.length??0,rawPrefixBytes:probe,
      tokenPrefixBytes:head?.length??0,eligible,plainBytes,bodyBytes}}
}

function encodeWordPrePayload(pre:Pick<WordPreResult,'header'|'body'>,rawBytes:number,kernel:GroupKernel,options?:CMOptions):Uint8Array {
  const bodyLen = pre.header.length + pre.body.length
  const body = new Uint8Array(bodyLen)
  body.set(pre.header, 0)
  body.set(pre.body, pre.header.length)
  const cm = withCMBlockSize(rawBytes, () => encodeCM(body, 'text', 1, 1, undefined, 0, undefined, undefined, kernel, 0, true, options))
  // 4 字节定长前缀记词元流长度（解码端 CM 需要提前知道输出长度）。
  const out = new Uint8Array(cm.length + 4)
  out[0] = bodyLen & 255; out[1] = (bodyLen >>> 8) & 255; out[2] = (bodyLen >>> 16) & 255; out[3] = (bodyLen >>> 24) & 255
  out.set(cm, 4)
  return inheritPayloadModel(out, cm)
}

function joinForSpec(parts: Uint8Array[], sp: Spec, positions: number[]): { data: Uint8Array } | null {
  if (!dualProfile(sp)) return null
  const n = parts.reduce((sum, p) => sum + p.length, 0)
  if (parts.length === 1) return { data: applyForward(parts[0], sp, positions[0] ?? 0) }
  const joined = new Uint8Array(n)
  let pos = 0
  for (let pi = 0; pi < parts.length; pi++) {
    joined.set(applyForward(parts[pi], sp, positions[pi] ?? 0), pos)
    pos += parts[pi].length
  }
  return { data: joined }
}

function applyForward(part: Uint8Array, sp: Spec, position: number): Uint8Array {
  // WIDE_GRAD 的 s===1 依 encodeTerrainGroup 顶部特例：逐分片 d16Fwd(1,1)。
  if (sp.id === ID.WIDE_GRAD && sp.s === 1) return d16Fwd(part, 1, 1)
  if (sp.id === ID.BCJ || sp.id === ID.BCJ_V2 || sp.id === ID.BCJ_V3) return (sp.id===ID.BCJ_V3 && sp.s===2 ? bcjMsbFwd : bcjFwd)(part, position)
  if (sp.id === ID.DELTA || sp.id === ID.DELTA_V3) return deltaFwd(part, sp.s)
  if (sp.id === ID.GRAD || sp.id === ID.GRAD_V2 || sp.id === ID.GRAD_V3 || sp.id === ID.WIDE_GRAD) return medFwd(part, sp.s, sp.r)
  if (sp.id === ID.D16) return d16Fwd(part, sp.s, sp.r)
  return part
}

/**
 * 双流覆盖的规则 → (profile, s, r)。
 *
 * **只覆盖 v3 系列**（TEXT_V3 / BIN_V3 / GRAD_V3 / DELTA_V3 / WIDE_GRAD）。
 * 旧规则（TEXT/BIN/BCJ/DELTA/GRAD/D16/V2 系列）在 Model 构造时走的是
 * `variant` 为 false 或 true 的**不同上下文拓扑**（nctx、minLen、H[6]/H[7]
 * 的哈希都不一样），与 v15 下的模型演化并不同构，强行共用会改变产物。
 * 这些规则由调用方退回"跑两遍"，正确性优先。
 */
function dualProfile(sp: Spec): { profile: Profile; s: number; r: number } | null {
  const { id, s, r } = sp
  if (v20Spec(sp)) return null // multi-plane framing / transform flag handled by group encoder
  if (id === ID.WIDE_GRAD) {
    // 与 encodeTerrainGroup 的两个分支一一对应。
    return s === 1 ? { profile: 'res', s: 2, r: 1 } : { profile: 'res2d', s, r }
  }
  if (id >= ID.TEXT_V3 && id <= ID.DELTA_V3) {
    const profile: Profile = id === ID.TEXT_V3 ? 'text' : id === ID.GRAD_V3 ? 'res2d' : id === ID.DELTA_V3 ? 'res' : 'bin'
    return { profile, s: id === ID.GRAD_V3 || id === ID.DELTA_V3 ? s : 1, r: id === ID.GRAD_V3 ? r : 1 }
  }
  return null
}

/** Header bytes for a single proposed group, from the production serializer.
 * The payload projection is still a sample estimate; header widths are real
 * varints, never a fixed 1.003/1.03 multiplier or a guessed six-byte dictionary. */
export function selectionHeaderBytes(spec: Spec, n: number, payloadLength: number, flags = 0, v15 = false, wordPre = false, context?:CMContext, matchDist = false): number {
  return planHeader(n, [{ start: 0, end: n, cls: 'binary', spec }], [{
    spec, members: [0], payload: { length: payloadLength }, modelFlags: flags, v15, wordPre, context, matchDist,
  }]).length
}
export function selectionRatio(spec: Spec, ratio: number, n: number, flags = 0): number {
  return ratio + selectionHeaderBytes(spec, n, Math.ceil(ratio * n), flags) / Math.max(1, n)
}
function pricedGroup(data: Uint8Array, spec: Spec, position: number): number {
  const payload = encodeTerrainGroup([data], spec, undefined, undefined, undefined, [position])
  return payload.length + selectionHeaderBytes(spec, data.length, payload.length, payloadModelFlags(payload))
}

// Final serialization and cost evaluation use exactly the same header writer.
type HeaderGroup = Omit<PlanGroup, 'payload'> & { payload: { length: number }; modelFlags?: number }
/** Also exported for metadata-only wire tests; this is the production writer,
 * not a test copy. Virtual header lengths do not encode virtual input bytes. */
export function planHeader(n:number,segs:readonly PlanSegment[],groups:readonly HeaderGroup[]):number[] {
  if (new Set(groups.map(g => groupInputKey(g.spec, []))).size !== groups.length) throw Error('自动转置产生重复的方案规则')
  // Selected streams carry their actual semantics through wrappers and workers.
  // Rejected v15/WP/large-table candidates cannot add an irrelevant config byte.
  for(const g of groups) {
    const flags=g.modelFlags??payloadModelFlags(g.payload)
    if(g.context && (!contextSpecAllowed(g.context,g.spec,!!g.wordPre)||!g.v15||!(flags&V20_FLAG_CM)||!(flags&V21_FLAG_CONTEXTS))) throw Error('无效的 v21 组上下文元数据')
    // The v22 match model only exists inside the v20 kernel and only for text/bin.
    // `flags` here is THIS group's own flag set; the container-level aggregate is not
    // known yet, so the v22 bit is added below from `g.matchDist` itself.
    // WORD-PRE is allowed: it wraps the text token stream and then runs the same
    // `text` CM, so matchDist reaches it through CMOptions exactly as context does.
    if(g.matchDist && (!g.v15 || !(flags&V20_FLAG_CM) || !matchDistProfileAllowed(g.spec.id, g.context)))
      throw Error('无效的 v22 组匹配模型元数据')
    if((g.spec.id===ID.REC2||g.spec.id===ID.BITPLANE) && (g.context || g.wordPre || !g.v15 || g.spec.s!==1 || (g.spec.id===ID.REC2 ? g.spec.r!==1 : (g.spec.r!==BITPLANE_BYTE_CM && g.spec.r!==BITPLANE_BIT_CM && g.spec.r!==BITPLANE_PERIOD_CM)) || (flags&(V21_FLAG_CONTEXTS|V20_FLAG_CM|V20_FLAG_TRANSFORMS))!==(V21_FLAG_CONTEXTS|V20_FLAG_CM|V20_FLAG_TRANSFORMS))) throw Error('无效 REC2 格式标记')
    // v22 nests the whole v21 namespace, so a v22 payload may declare it while the
    // group carries no context code (the flag then only records the format lineage).
    if(!g.context && g.spec.id!==ID.REC2 && g.spec.id!==ID.BITPLANE && (flags&V21_FLAG_CONTEXTS) && !(flags&V22_FLAG_MATCH_DISTANCE)) throw Error('v21 载荷缺少组上下文标记')
  }
  const hasV15 = groups.some(g => g.v15)
  const flags = groups.reduce((f, g) => f | (g.modelFlags ?? payloadModelFlags(g.payload)) | (v20Spec(g.spec) ? V20_FLAG_TRANSFORMS : 0), 0)
  // v23 = strict only, v24 = strict + checksum, v25 = default priors + checksum.
  // Encoding a checksummed container with default priors as v24 would make the
  // decoder build the strict model, so the two axes get distinct versions.
  // v26 = v22 layout + fresh distance buckets. Old v22 containers keep their stale
  // behaviour, so decoding is a pure function of the version byte.
  const ver:number = (flags & V22_FLAG_MATCH_DISTANCE) && !strictPriorsOn()
    ? (containerChecksumOn() ? 27 : 26)
    : containerChecksumOn() ? (strictPriorsOn() ? 24 : 25) : strictPriorsOn() ? 23 : flags & V21_FLAG_CONTEXTS ? 21 : flags & (V20_FLAG_TRANSFORMS | V20_FLAG_CM) ? 20 : flags > 255 ? 19 : flags ? 18
    :hasV15?15:groups.some(g=>g.spec.id===ID.WIDE_GRAD)?14:groups.some(g=>g.spec.id>=ID.TEXT_V3)?13:groups.some(g=>g.spec.id>=ID.TEXT_V2)?12:groups.some(g=>g.spec.id===ID.MICRO)?11:groups.some(g=>g.spec.id===ID.SUB_TRANSPOSE||g.spec.id===ID.SUB_ANCHOR)?10:groups.some(g=>g.spec.id===ID.PEEL)?9:groups.some(g=>g.spec.id===ID.ANCHOR_FOLD)?8:7
  const hdr:number[]=[0x55,0x43,0x5a,ver]
  if (ver >= 19) hdr.push(flags & 255, flags >>> 8)
  else if (ver === 18) hdr.push(flags)
  putVar(hdr,n);putVar(hdr,segs.length);putVar(hdr,groups.length)
  // v15 分组的标记放在 r 的最高位：r 的有效范围是 1..8192，够放。
  // payload 首字节是分组的模式字节（见各 encode*），不能占用。
  // rRaw 0x8000 = APM 内核，0x4000 = WORD-PRE（见 P4-2）。
  // v20 新增 0x10000 指定新 CM；未置位的 APM 组仍用 legacy-v15。
  // v21 的 17..19 位是上下文模式 1..7；低 14 位仍是原 r。
  // r 本身的 0x2000（8192）保持不变；容器旗标是独立的 uint16 字段。
  for(const g of groups){const cc=g.context?contextCodeOf(g.context):undefined;putVar(hdr,g.spec.id);putVar(hdr,g.spec.s);putVar(hdr,(g.spec.r|(g.v15?0x8000:0)|(g.wordPre?0x4000:0)|(g.v15 && ((g.modelFlags??payloadModelFlags(g.payload))&V20_FLAG_CM)?0x10000:0)|(cc?cc.code<<GROUP_CONTEXT_SHIFT:0)|(cc?.ext?GROUP_CONTEXT_EXT_BIT:0)|(g.matchDist?GROUP_MATCH_DIST_BIT:0)));putVar(hdr,g.payload.length)}
  for(const sg of segs) putVar(hdr,sg.end-sg.start)
  let pending=segs.map((_,i)=>i),byte=0,bits=0
  for(let gi=0;gi+1<groups.length;gi++) {
    const members=new Set(groups[gi].members),next:number[]=[]
    for(const i of pending) {if(members.has(i))byte|=1<<bits;else next.push(i);if(++bits===8){hdr.push(byte);byte=0;bits=0}}
    pending=next
  }
  if(bits)hdr.push(byte)
  return hdr
}
// Preserve the existing actual-payload transpose comparison in both paths.
// Choose between the three transpose layouts by encoding each distinct stream
// exactly once. The legacy grouped stream used to be produced twice (once as
// TRANSPOSE_2D's internal comparison candidate and once for the final payload);
// its column weights are now collected during that single pass so the cost map
// can be filled without re-encoding.
export function encodePlanTranspose(parts:Uint8Array[],spec:Spec,costs?:CostBins,available:(spec:Spec)=>boolean=()=>true,basePayload?:Uint8Array):{spec:Spec;payload:Uint8Array} {
  const legacyWeights: ColumnWeights = { weights: new Float64Array(spec.s), emptyHeaderBits: 0 }
  // The "legacy" arm must be encoded with the format the group's OWN spec declares.
  // id 10 and id 9 wire DIFFERENT decoders: id 10 reads grouped column records
  // (span/mode/length per group), id 9 reads one record per column. Producing the
  // id-10 stream and then handing it back under an id-9 spec creates a container
  // that encodes fine and fails to decode (转置列长度错误). Until P17.4 only id 10
  // could reach this function, so the two were interchangeable.
  const legacy = spec.id === ID.TRANSPOSE
    ? encodeTransposeGroup(parts, spec.s, undefined, undefined, false)
    : encodeGroupedTranspose(parts, spec.s, undefined, undefined, false, legacyWeights)
  const geoSpec = { id: ID.TRANSPOSE_2D, s: spec.s, r: 1 }
  const v3Spec = { id: ID.TRANSPOSE_GROUP_V3, s: spec.s, r: 1 }
  // A smaller payload is not a usable candidate if its dictionary identity is
  // already owned by an independently encoded group. Do not merge byte streams.
  const geometric = available(geoSpec) ? encodeTranspose2d(parts, spec.s) : null
  const enhanced = available(v3Spec) ? encodeGroupedTranspose(parts, spec.s, undefined, undefined, true) : null
  const n = parts.reduce((sum, p) => sum + p.length, 0)
  const price = (id: number, p: Uint8Array, prefix = 0) => p.length + prefix + (planTuning.realHeaderCosts
    ? selectionHeaderBytes({ id, s: spec.s, r: 1 }, n, p.length + prefix, payloadModelFlags(p)) : 0)
  const legacyCost = price(spec.id, legacy), geometricCost = geometric ? price(geoSpec.id, geometric, 1) : Infinity
  // A plan may replace the group only when its payload is actually smaller.
  // The callers also price the complete header, but this invariant belongs here
  // so no future caller can adopt a larger plan by looking at the spec alone.
  const finish = (planned: {spec:Spec;payload:Uint8Array}) => basePayload && basePayload.length
    && planned.payload.length >= basePayload.length ? { spec, payload: basePayload } : planned
  if (enhanced && price(v3Spec.id, enhanced) < Math.min(geometricCost, legacyCost))
    return finish({ spec:v3Spec, payload:enhanced })
  if (geometric && geometricCost < legacyCost) {
    const out = new Uint8Array(geometric.length + 1)
    out[0] = 1; out.set(geometric, 1); inheritPayloadModel(out, geometric)
    return finish({ spec:geoSpec, payload:out })
  }
  if (costs) applyColumnCosts(parts, spec.s, legacyWeights.weights, legacyWeights.emptyHeaderBits, costs)
  return finish({ spec, payload:legacy })
}
/** A stride-4 transpose group is only a hypothesis until its fundamental
 * stride is checked. For a harmonic alias, encode the whole group at s=2 with
 * the three real transpose layouts and keep the smallest COMPLETE price. The
 * legacy layout uses the wide (32 KiB) CM_BIN-vs-DELTA column screen, so a
 * near-zero first-order delta gain cannot throw away raw multi-byte context. */
function harmonicStride2Plan(g: PlanGroup, parts: Uint8Array[],
  available:(spec:Spec)=>boolean): { spec: Spec; payload: Uint8Array } | null {
  if (g.spec.s !== 4 || !([ID.TRANSPOSE, ID.TRANSPOSE_GROUP, ID.TRANSPOSE_GROUP_V3] as number[]).includes(g.spec.id)) return null
  if (!isHarmonicStride2Alias(parts)) return null
  const rawLen = parts.reduce((n, p) => n + p.length, 0)
  const candidates: { spec: Spec; payload: Uint8Array; price: number }[] = []
  const consider = (spec: Spec, payload: Uint8Array) => {
    if (!available(spec)) return
    const price = payload.length + selectionHeaderBytes(spec, rawLen, payload.length, payloadModelFlags(payload))
    candidates.push({ spec, payload, price })
  }
  try {
    const legacy = { id: ID.TRANSPOSE, s: 2, r: 1 }
    // De-aliasing decides a FORMAT, so it must be priced with the same CM table
    // tier the final group will use. Without this wrapper a >=4 MiB stride-4
    // group (N) was de-aliased using the small-group block size while the later
    // v20 adoption used the full b23 tier, and the two prices disagreed.
    if (available(legacy)) consider(legacy, withCMBlockSize(rawLen, () => encodeTransposeGroup(parts, 2, undefined, undefined, false, true)))
    const grouped = { id: ID.TRANSPOSE_GROUP, s: 2, r: 1 }
    if (available(grouped)) consider(grouped, withCMBlockSize(rawLen, () => encodeGroupedTranspose(parts, 2, undefined, undefined, false)))
    const enhanced = { id: ID.TRANSPOSE_GROUP_V3, s: 2, r: 1 }
    if (available(enhanced)) consider(enhanced, withCMBlockSize(rawLen, () => encodeGroupedTranspose(parts, 2, undefined, undefined, true)))
  } catch { return null }
  if (!candidates.length) return null
  candidates.sort((a, b) => a.price - b.price || a.payload.length - b.payload.length)
  return { spec: candidates[0].spec, payload: candidates[0].payload }
}
function validPlanSpec(sp:Spec):boolean {
  const {id,s,r}=sp
  if(!Number.isSafeInteger(id)||!CODECS[id]||!Number.isSafeInteger(s)||!Number.isSafeInteger(r)||r<1) return false
  const anchor=id===ID.ANCHOR_FOLD||id===ID.SUB_ANCHOR||id===ID.SUB_ANCHOR_V3
  if(anchor ? s<0||s>255 : s<1) return false
  if(([ID.TRANSPOSE,ID.TRANSPOSE_GROUP,ID.TRANSPOSE_2D,ID.TRANSPOSE_GROUP_V3,ID.PEEL] as number[]).includes(id) && (s<2||s>64||r!==1)) return false
  if(([ID.BCJ,ID.BCJ_V2,ID.TEXT_V2,ID.BIN_V2,ID.TEXT_V3,ID.BIN_V3] as number[]).includes(id) && (s!==1||r!==1)) return false
  if(id===ID.BCJ_V3 && (r!==1 || (s!==1 && !(s===2 && transformsV20Enabled())))) return false
  if(id===ID.ANCHOR && (s>256||r!==1)) return false
  if(anchor && (r>255||!((r&127)>=32||(r&127)===9||((r&127)>=2&&(r&127)<=24)))) return false
  if((id===ID.SUB_TRANSPOSE||id===ID.SUB_TRANSPOSE_V3) && (s<2||s>64||(r!==1&&r!==2))) return false
  if((id===ID.SUB_ANCHOR||id===ID.SUB_ANCHOR_V3)&&((r&127)>=32||(r&127)===9)&&s===(r&127)) return false
  if(id===ID.MICRO && (s>16||r>4096)) return false
  if(id===ID.WIDE_GRAD && ( (s<1||s>(transformsV20Enabled()?8:2))||r<256||r>8192||r%2!==0)) return false
  return true
}
function validatePlan(data: Uint8Array, picks: readonly PlanSegment[]): void {
  let end=0
  for(const p of picks) {
    if(!Number.isSafeInteger(p.start)||!Number.isSafeInteger(p.end)||p.start!==end||p.end<=p.start||p.end>data.length) throw Error('无效的方案区域边界')
    if(!validPlanSpec(p.spec)) throw Error('无效的方案规则')
    if(p.spec.id===ID.FILL) for(let i=p.start+1;i<p.end;i++) if(data[i]!==data[p.start]) throw Error('填充区域不一致')
    end=p.end
  }
  if(end!==data.length) throw Error('方案未覆盖完整输入')
}
/** Encode each real group and measure the exact UCZ header and payload sizes.
 * By default the same adjacent-region merge as compressAdaptive is applied.
 * Set alreadyMerged when evaluating compressAdaptive(...).segs: those are the
 * final boundaries, after encoding-time transpose substitutions, and must not
 * be merged a second time. Anchor unification is intentionally not rerun.
 * This is synchronous and may be expensive; it does not perform a search. */
export function evaluatePlan(data:Uint8Array,picks:readonly PlanSegment[],options:{alreadyMerged?:boolean}={}):PlanCost {
  encodingModelFlags()
  validatePlan(data, picks)
  const segs=options.alreadyMerged ? picks.map(p=>({...p})) : mergePlanSegments(data,picks)
  const groups=buildPlanGroups(segs), reservations=planSpecReservations(groups)
  for(const g of groups) {
    const parts=g.members.map(i=>data.subarray(segs[i].start,segs[i].end))
    const positions=g.members.map(i=>segs[i].start)
    if(g.spec.id===ID.FILL) g.payload=Uint8Array.from(parts.map(p=>p[0]))
    else if(g.spec.id===ID.TRANSPOSE_GROUP && parts.every(p=>p.length<=MAX_SUB_CHUNK)) {
      const encoded=encodePlanTranspose(parts,g.spec,undefined,sp=>reservations.available(g,sp))
      reservations.claim(g,encoded.spec);g.spec=encoded.spec;g.payload=encoded.payload
    } else {
      const ctxSegment=segs[g.members[0]].context
      if(ctxSegment) {
        g.context=ctxSegment
        g.v15=true
        g.payload=encodeTerrainGroup(parts,g.spec,undefined,undefined,undefined,positions,'v20',{context:ctxSegment})
      } else {
        g.payload=encodeTerrainGroup(parts,g.spec,undefined,undefined,undefined,positions)
        if(v15Depth===0) g.v15=chooseGroupV15(parts,g,positions,undefined,sp=>reservations.available(g,sp))
      }
      reservations.claim(g,g.spec)
    }
  }
  const keys=new Set<string>()
  for(const g of groups) {
    const key=`${g.spec.id},${g.spec.s},${g.spec.r}`
    if(keys.has(key)) throw Error('自动转置产生重复的方案规则')
    keys.add(key)
  }
  // The writer serializes the coalesced header for the concatenation-invariant
  // codecs, so the evaluator must price exactly that header while still reporting
  // the caller's own segment/group counts.
  const coalesced=coalesceContiguousPlanSegments(data.length,segs,groups)
  const headerBytes=planHeader(data.length,coalesced.segs,coalesced.groups).length
  const payloadBytes=groups.reduce((sum,g)=>sum+g.payload.length,0)
  return {totalBytes:headerBytes+payloadBytes,headerBytes,payloadBytes,groupCount:groups.length,segmentCount:segs.length}
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

// 归一后要按区域分摊载荷，需要一个"该区域单独压缩时有多大"的相对权重。
// 采样窗口只有十几 KB 且含固定头部开销，直接按它外推会偏得很厉害
// （osdb 10 MB 区域实际 24%，按采样外推会算成 64%）。因此：有 512 KB 连续
// 探针的用探针实测比例，没有的才退回采样比例。
function trialWeight(trials: readonly Trial[], spec: Spec, start: number, end: number): number {
  const chosen = trials.find(t => t.spec === spec) ?? trials.reduce((a, b) => (a.ratio <= b.ratio ? a : b))
  const probe = chosen.probeSize !== undefined && chosen.probeLen ? chosen.probeSize / chosen.probeLen : undefined
  const ratio = probe ?? (chosen.payloadSize ?? 0) / Math.max(1, chosen.sampleLen ?? 0)
  return Math.max(1, Math.round(ratio * (end - start)))
}

/** 把区域试探派给 worker 池；返回按下标排列的结果，失败则返回 null 走串行。 */
async function tryParallelChoose(
  data: Uint8Array, segs: readonly {start:number;end:number;cls:Cls;bestS:number}[],
  sampleLimits: readonly number[], onStage?: (msg: string, pct: number) => void,
): Promise<{ spec: Spec; trials: Trial[] }[] | null> {
  if (!parallelReport.ok) return null
  const jobs: JobPayload[] = segs.map((sg, i) => ({
    kind: 'chooseSpec', cmV20: {...cmV20Tuning}, level: currentCompressionLevel(), strictPrior: strictPriorsOn(), start: sg.start, end: sg.end, cls: CLS_CODE[sg.cls],
    bestS: sg.bestS, sampleLimit: sampleLimits[i], base: sg.start,
  }))
  const loads = segs.map(sg => sg.end - sg.start)
  parallelReport.trace?.(`试探开始 ${segs.length} 区域 / ${threadCount()} 线程`)
  onStage?.(`并行试探 ${segs.length} 个区域（${threadCount()} 线程）…`, 15)
  let replies: JobReply[] | null
  try {
    replies = await runNodeJobs(jobs, loads, data)
  } catch (error) {
    // 并行只是加速手段：任何失败都退回串行，绝不影响产物。
    parallelReport.ok = false
    parallelReport.reason = error instanceof Error ? error.message : String(error)
    return null
  }
  if (!replies) { parallelReport.reason = '任务量不足或环境不支持'; return null }
  parallelReport.used = true
  return replies.map((r, i) => {
    if (!r || r.kind !== 'chooseSpec') throw new Error(`并行试探第 ${i} 项返回异常`)
    return {
      spec: { id: r.spec.id, s: r.spec.s, r: r.spec.r },
      trials: r.trials.map(t => ({
        spec: { id: t.spec.id, s: t.spec.s, r: t.spec.r }, label: specLabel(t.spec),
        ratio: t.ratio, payloadSize: t.payloadSize, sampleLen: t.sampleLen,
        sampleStart: t.sampleStart, sampleStarts: t.sampleStarts,
        probeSize: t.probeSize, probeLen: t.probeLen, fullSize: t.fullSize, modelFlags: t.modelFlags,
      })),
    }
  })
}

function logicalGroupEnds(g: PlanGroup, segs: readonly PlanSegment[]): number[] {
  const ends: number[] = []
  let logical = 0
  for (const i of g.members) for (let p = segs[i].start; p < segs[i].end;) {
    const end = Math.min(segs[i].end, (Math.floor(p / BLOCK) + 1) * BLOCK)
    logical += end - p; ends.push(logical); p = end
  }
  return ends
}

/** 可并行编码的分组：只有"整段独立编码 + 规则无跨组依赖"的那些。 */
function groupJobs(
  unique: readonly PlanGroup[], segs: readonly SegResult[], allowCachedBase = true,
): { jobs: JobPayload[]; index: number[]; loads: number[] } {
  const jobs: JobPayload[] = []
  const index: number[] = []
  const loads: number[] = []
  for (let gi = 0; gi < unique.length; gi++) {
    const g = unique[gi]
    if(g.candidatesDone)continue
    // 这几类在编码期内会被改写规则或需要额外解析，交给串行路径处理：
    // TRANSPOSE_GROUP 要现场比三种布局，MICRO/PEEL/SUB_* 要回读载荷补元数据。
    if ((g.payload.length || g.reusePayload) && (!g.baseCost || !allowCachedBase)) continue
    if (g.spec.id === ID.TRANSPOSE_GROUP || g.spec.id === ID.MICRO || g.spec.id === ID.PEEL) continue
    if (g.spec.id === ID.SUB_TRANSPOSE || g.spec.id === ID.SUB_ANCHOR || g.spec.id === ID.SUB_TRANSPOSE_V3 || g.spec.id === ID.SUB_ANCHOR_V3) continue
    if (g.spec.id === ID.FILL) continue
    const parts = g.members.map(i => [segs[i].start, segs[i].end] as [number, number])
    const positions = g.members.map(i => segs[i].start)
    const ends = logicalGroupEnds(g, segs)
    jobs.push({ kind: 'encodeGroup', cmV20:{...cmV20Tuning}, level: currentCompressionLevel(), strictPrior: strictPriorsOn(), groupOptions:{allowBcjUpgrade:g.bcjUpgradeAllowed===true,screen:planTuning.groupKernelScreen}, parts, spec: { id: g.spec.id, s: g.spec.s, r: g.spec.r }, positions, ends, ...(g.baseCost ? { skipBase: true } : {}) })
    index.push(gi)
    loads.push(g.members.reduce((a, i) => a + segs[i].rawLen, 0))
  }
  return { jobs, index, loads }
}

/** 并行编码独立分组；任务太少或失败时返回 null（调用方走串行）。 */
async function tryParallelGroups(
  data: Uint8Array, unique: readonly PlanGroup[], segs: readonly SegResult[],
  onStage?: (msg: string, pct: number) => void, run?: EncodeRun,
): Promise<(EncodedWork | null)[] | null> {
  const out: (EncodedWork | null)[] = unique.map(() => null)
  const proposed = groupJobs(unique, segs, run?.reuseGuardBases !== false)
  const jobs: JobPayload[] = [], loads: number[] = [], targets: { gi: number; key: string; base?: { bytes: Uint8Array; cost: Float32Array } }[] = []
  for (let k = 0; k < proposed.jobs.length; k++) {
    const gi = proposed.index[k], key = finalGroupKey(unique[gi], segs), saved = run?.work.get(key)
    if (saved) {
      out[gi] = saved; run!.work.delete(key); run!.stats.macroReused++
    } else { jobs.push(proposed.jobs[k]); loads.push(proposed.loads[k]); targets.push({ gi, key, base: unique[gi].baseCost ? { bytes: unique[gi].payload, cost: unique[gi].baseCost! } : undefined }) }
  }
  // Exactly ONE pool invocation: never race two runParallelJobs calls on its
  // shared buffer/listeners. LPT puts independent full candidates on free workers.
  const extra = run?.prefetch
  if (jobs.length && extra && !run!.work.has(extra.key) && !targets.some(t => t.key === extra.key)) {
    const base = run!.bases.get(extra.key)
    const job = base && extra.job.kind === 'encodeGroup' ? { ...extra.job, skipBase: true } : extra.job
    jobs.push(job); loads.push(extra.load); targets.push({ gi: -1, key: extra.key, base })
  }
  if (!jobs.length || (!run?.runner && !nodeParallelReady())) return out
  parallelReport.trace?.(`分组合批 ${jobs.length} 个任务，最大负载 ${Math.max(...loads)} B`)
  onStage?.(`并行编码 ${jobs.length} 个完整分组/候选（${threadCount()} 线程）…`, 50)
  try {
    const replies = await (run?.runner ?? runNodeJobs)(jobs, loads, data)
    if (!replies) return out // threshold/one-core: no speculative serial macro work
    if (replies.length !== jobs.length) throw Error('并行分组返回数量异常')
    const restored = replies.map((r, k): EncodedWork => {
      if (!r || r.kind !== 'encodeGroup' || jobs[k].kind !== 'encodeGroup') throw Error(`并行分组第 ${k} 项返回异常`)
      const spec = (jobs[k] as Extract<JobPayload, {kind:'encodeGroup'}>).spec
      const same = r.cand && groupInputKey(spec, []) === groupInputKey(r.cand.spec, [])
      if (r.cand && !same) throw Error('并行候选规则与任务不一致')
      const job = jobs[k] as Extract<JobPayload, {kind:'encodeGroup'}>
      if (r.cost.length !== (job.skipBase ? 0 : job.ends.length) || (job.skipBase && r.bytes.length)) throw Error('并行base/成本仓与任务不一致')
      for(const v of r.cand?.variants??[]) {
        if(job.groupOptions?.allowBcjUpgrade===false||!bcjUpgradeSpec(spec,job.parts.reduce((n,p)=>n+p[1]-p[0],0))
          ||v.spec.id!==ID.BCJ_V3||v.spec.s!==2||v.spec.r!==1||(v.kernel!=='v15'&&v.kernel!=='v20'))throw Error('无效 BCJ 分组升级候选')
        markPayloadModel(v.payload,v.flags)
      }
      if (r.cand?.alt) markPayloadModel(r.cand.alt, r.cand.altFlags)
      if (r.cand?.wordPre) markPayloadModel(r.cand.wordPre, r.cand.wordPreFlags)
      if (r.cand?.v20) markPayloadModel(r.cand.v20,r.cand.v20Flags ?? 0)
      if (r.cand?.wordPreV20) markPayloadModel(r.cand.wordPreV20,r.cand.wordPreV20Flags ?? 0)
      return { bytes: targets[k].base?.bytes ?? markPayloadModel(r.bytes, r.modelFlags), cost: targets[k].base?.cost ?? r.cost,
        cand: same ? { alt: r.cand!.alt, wordPre: r.cand!.wordPre, rawLen: r.cand!.rawLen, screening:r.cand!.screening, variants:r.cand!.variants, v20:r.cand!.v20,wordPreV20:r.cand!.wordPreV20 } : null }
    })
    for (let k = 0; k < restored.length; k++) {
      const t = targets[k]
      if (t.gi >= 0) out[t.gi] = restored[k]
      else { run!.work.set(t.key, restored[k]); run!.stats.macroPrefetched++ }
    }
    parallelReport.used = true; parallelReport.groups += jobs.length
    if (run) {
      run.stats.workerJobs += jobs.length
      run.stats.candidateOnlyJobs += targets.filter(t => t.base).length
    }
  } catch (error) {
    parallelReport.ok = false
    parallelReport.reason = error instanceof Error ? error.message : String(error)
    if (run) run.stats.workerFallbacks++
    // Completed baseline/cache entries stay valid; missing entries encode serially.
  }
  return out
}

/** 并行状态（用于诊断与降级判断）。 */
export const parallelReport: { ok: boolean; used: boolean; groups: number; reason?: string; trace?: (m: string) => void } = { ok: true, used: false, groups: 0 }

// 从一次分析/选规则得到的计划出发，只做分组编码，不重复扫描和候选试探。
async function encodePreparedPlan(
  data: Uint8Array, analysis: Analysis, merged: readonly PreparedSegment[], serial: boolean,
  onStage: ((msg: string, pct: number) => void) | undefined, yieldIfNeeded: () => Promise<void>, seed?: MacroSeed, cache?: GroupCache, finalAssignments = false, run?: EncodeRun,
): Promise<Compressed> {
  const n = data.length
  const segs: SegResult[] = merged.map(m => ({ start: m.start, end: m.end, cls: m.cls, spec: m.spec, label: specLabel(m.spec), rawLen: m.end - m.start, compLen: 0, trials: m.trials, trialBytes: m.trialBytes }))
  // 2b) 同族 CM 择优归一：仅当统一后实测更小才改写，保证单调不劣。
  const grouped=buildPlanGroups(merged)
  if (seed && seed.flags === encodingModelFlags()) {
    for (const g of grouped) if (g.spec.id !== ID.TRANSPOSE_GROUP &&
      groupInputKey(g.spec, g.members.map(i => segs[i])) === seed.key) {
      g.payload = seed.payload
      g.v15=!!seed.v15
      g.reusePayload = true
      seed.used = true
    }
  }
  // Subsequent guarded proposals must not rewrite unrelated final groups.
  const unique=finalAssignments ? grouped : await unifyFamilies(data, grouped, segs, onStage, yieldIfNeeded, run)
  // Reuse before dispatch so unchanged groups are not redundantly sent to workers.
  const reservations = planSpecReservations(unique)
  const cacheKeys = unique.map(g => finalGroupKey(g, segs))
  const cachedGroups = unique.map((g, i) => {
    const saved = cache?.get(cacheKeys[i])
    if (!saved || !reservations.available(g, saved.spec)) return undefined
    const upgrade=bcjUpgradeSpec(g.spec,g.members.reduce((n,i)=>n+segs[i].rawLen,0))
    if(upgrade && !saved.bcjUpgradeChecked && reservations.available(g,upgrade)) return undefined
    reservations.claim(g, saved.spec)
    return saved
  })
  for(const g of unique) {
    const target=bcjUpgradeSpec(g.spec,g.members.reduce((n,i)=>n+segs[i].rawLen,0))
    g.bcjUpgradeAllowed=!!target&&!g.candidatesDone&&reservations.available(g,target)
    if(g.bcjUpgradeAllowed)reservations.claim(g,target!)
  }
  for (let i = 0; i < unique.length; i++) {
    const saved = cachedGroups[i]
    if (saved) { unique[i].payload = saved.payload; unique[i].reusePayload = true }
    else if (!unique[i].payload.length) {
      const base = run?.bases.get(cacheKeys[i])
      if (base) {
        unique[i].payload = base.bytes; unique[i].baseCost = base.cost; unique[i].reusePayload = true
        run!.stats.reusedTrialBases++
      }
    }
  }
  if (run?.initial && run.batchGuards && !serial && !unique.some(g => g.spec.id === ID.TRANSPOSE_GROUP)) {
    // All remaining encoders retain their rule. No orphan => the direct macro
    // is known before baseline encoding, so it can share the same batch.
    const assigned = segs.map(s => ({ ...s }))
    for (const g of unique) for (const i of g.members) assigned[i].spec = g.spec
    // compLen is still the unencoded zero placeholder here, NOT measured
    // compression. Only the post-encode orphan decision may preserve a cheap
    // structured group; an unknown cost must not authorize an early prefetch.
    const unmeasured = assigned.map(s => ({ ...s, compLen: undefined }))
    if (!planTuning.orphanConsolidation || !consolidateOrphans(n, unmeasured)) run.prefetch = guardPrefetch(n, assigned, null)
  }
  const nb = analysis.blocks.length, blockCost = new Float32Array(nb), blockSeg = new Int32Array(nb)
  // 独立分组的整段编码彼此不共享模型，可以先并行算出"载荷 + 成本仓"，
  // 再按原顺序回写。回写顺序与串行完全一致，因此产物不变。
  const parallelGroups = !serial
    ? await tryParallelGroups(data, unique, segs, onStage, run)
    : null
  for (let gi = 0; gi < unique.length; gi++) {
    const g = unique[gi]
    const len = g.members.reduce((sum, i) => sum + segs[i].rawLen, 0)
    onStage?.(`编码地形 ${gi + 1}/${unique.length} · 0%`, 50 + 35 * gi / unique.length)
    // Logical cost bins end at every segment seam or original 512-byte block edge.
    const fragments: {member:number; block:number; len:number}[] = []
    const ends: number[] = []
    let logical = 0
    for (let j = 0; j < g.members.length; j++) {
      const sg = segs[g.members[j]]
      for (let p = sg.start; p < sg.end;) {
        const end = Math.min(sg.end, (Math.floor(p / BLOCK) + 1) * BLOCK)
        const size = end - p
        fragments.push({member:j, block:Math.floor(p / BLOCK), len:size})
        logical += size; ends.push(logical); p = end
      }
    }
    const groupCost = new Float32Array(fragments.length)
    const costBins: CostBins = {values:groupCost, blockSize:BLOCK, ends:Uint32Array.from(ends)}
    const saved = cachedGroups[gi]
    if (saved) {
      if (run) run.stats.reusedGroups++
      g.spec = { ...saved.spec }; g.payload = saved.payload; g.v15 = saved.v15; g.wordPre = saved.wordPre
      g.reusePayload = false
      groupCost.set(saved.cost)
      for (const i of g.members) { segs[i].spec = g.spec; segs[i].label = specLabel(g.spec) }
    } else if (g.spec.id === ID.TRANSPOSE_GROUP
      && g.spec.s > 1 && g.members.every(i => segs[i].rawLen <= MAX_SUB_CHUNK)) {
      // P17.5: id 9 is deliberately NOT routed here. Its wire format is
      // different from id 10's, and re-planning it on a small column sample
      // regressed AITDCC/N (raw CM_BIN instead of DELTA+CM). It returns to its
      // own generic encoder below, and the complete-payload gate still protects
      // id 10 from a losing layout plan.
      const parts=g.members.map(i=>data.subarray(segs[i].start,segs[i].end))
      const basePayload=g.payload && g.payload.length ? g.payload : undefined
      const encoded=encodePlanTranspose(parts,g.spec,costBins,sp=>reservations.available(g,sp),basePayload)
      const basePrice=basePayload ? basePayload.length+selectionHeaderBytes(g.spec,len,basePayload.length,payloadModelFlags(basePayload),!!g.v15) : Infinity
      const encodedPrice=encoded.payload.length+selectionHeaderBytes(encoded.spec,len,encoded.payload.length,payloadModelFlags(encoded.payload),true)
      // P17.5: never overwrite a retained payload with a larger plan. The
      // returned spec and payload are an inseparable pair; only an actual
      // payload shrink may replace the group.
      if(!basePayload || (encoded.payload.length<basePayload.length && encodedPrice<basePrice)) {
        reservations.claim(g,encoded.spec)
        if(encoded.spec.id!==g.spec.id || encoded.spec.s!==g.spec.s) {
          g.spec=encoded.spec;g.payload=encoded.payload
          fillUniformCosts(costBins,len,g.payload.length*8)
          for(const i of g.members) { segs[i].spec=g.spec;segs[i].label=specLabel(g.spec) }
        } else g.payload=encoded.payload
      }
      // P6-4：sao 就走这一支（整份 7.25 MB ≤ MAX_SUB_CHUNK），而它此前**完全绕过**
      // chooseGroupV15，v15 内核在这类数据上一直是死代码。
      //
      // 只升级到 V3 布局再试 v15：id 10 的列分组计划与 V3 不同，实测 V3 + v15
      // 在 sao 上比 id 10 小 2,562 B，而"id 10 + v15"只小 12 B。整组重编码一次，
      // 只在分组 ≥ 1 MiB 时做（小组的收益抵不上时间）。
      // P17.4: the 1 MiB floor made this whole upgrade dead code below 1 MiB — i.e.
      // on every <=256 KiB slice and on mozilla's 307 KiB TRANSPOSE-G group. `sao`
      // (7.25 MiB) was the only file that ever reached it. A record-layout group
      // earns its keep far below a megabyte; 32 KiB matches the point at which the
      // planner itself starts proposing transpose candidates at all.
      const isTgV3 = g.spec.id === ID.TRANSPOSE_GROUP_V3
      const v3spec = { id: ID.TRANSPOSE_GROUP_V3, s: g.spec.s, r: 1 }
      if ((isTgV3 || g.spec.id === ID.TRANSPOSE_GROUP || g.spec.id === ID.TRANSPOSE) && len >= 32768) {
        // P17.7: price the kernel on the layout that actually won the plan, not
        // only on the V3 alternative. On two-column streams id 10 keeps the
        // columns split while id 30 merges them into one central window, so
        // `encodePlanTranspose` legitimately keeps id 10 — and that winner never
        // reached a kernel search at all. Both layouts are complete payloads of
        // the same group, so they are priced against the same base and only the
        // strictly cheapest one is adopted.
        const layouts: Spec[] = []
        if (V15_PROFILES.has(g.spec.id)) layouts.push({ ...g.spec })
        if (g.spec.id !== ID.TRANSPOSE_GROUP_V3 && reservations.available(g, v3spec)) layouts.push(v3spec)
        for (const layout of layouts) {
        const candidates=groupV15Candidates(parts,layout,g.members.map(i=>segs[i].start))
        for(const cand of [candidates?.alt,candidates?.v20]) {
        if(!cand)continue
        const candidateCost = cand.length + (planTuning.realHeaderCosts
          ? selectionHeaderBytes(layout, len, cand.length, payloadModelFlags(cand), true) : 0)
        const baseCost = g.payload.length + (planTuning.realHeaderCosts
          ? selectionHeaderBytes(g.spec, len, g.payload.length, payloadModelFlags(g.payload),!!g.v15) : 0)
        const took = candidateCost < baseCost
        if ((globalThis as any).__V15_STATS) {
          // P17.4: record the same fields the chooseGroupV15 record uses. The old
          // three-field shape `{id, base, alt}` is why a report once showed
          // `s=undefined / fl=0x0` — those fields were never sampled, not lost.
          ;((globalThis as any).__V15_STATS as any[]).push({ id: g.spec.id, s: g.spec.s,
            parts: g.members.length, rawBytes: len, base: g.payload.length, alt: cand.length,
            selectedSpec: layout, selectedFlags: payloadModelFlags(cand),
            selectedBytes: cand.length, took, source: 'g3-layout-upgrade' })
        }
        if (took) {
          reservations.claim(g,layout)
          g.spec = layout
          g.payload = cand
          g.v15 = true
          fillUniformCosts(costBins, len, g.payload.length * 8)
          for (const i of g.members) { segs[i].spec = g.spec; segs[i].label = specLabel(g.spec) }
        }
        }
        }
      }
      yieldIfNeeded?.()
    } else if (g.spec.id === ID.FILL) {
      g.payload = Uint8Array.from(g.members.map(i => data[segs[i].start]))
      for (let b = 0; b < fragments.length; b++) {
        const f = fragments[b], sg = segs[g.members[f.member]]
        groupCost[b] = 8 * f.len / sg.rawLen
      }
    } else if (g.payload && g.reusePayload) {
      // 同族归一已经用同一路径、同一规则编码过整组，这里直接复用其字节。
      // 成本仍需按“每个区域单独压缩时的相对比例”分摊，否则 segs[].compLen、
      // 逐块成本图和最终容器会与重新编码的结果不一致。
      g.reusePayload = false
      // 复用载荷的分组同样要试 v15：主力分组（往往是唯一的大分组）走的就是这条路。
      if (!g.candidatesDone) g.v15 = chooseGroupV15(g.members.map(i => data.subarray(segs[i].start, segs[i].end)), g, g.members.map(i => segs[i].start), parallelGroups?.[gi]?.cand, sp=>reservations.available(g,sp))
      if (g.baseCost) {
        groupCost.set(g.baseCost)
        if (run) run.stats.reusedFamilyBases++
      } else {
        const weights = g.members.map(i => Math.max(1, segs[i].trialBytes ?? segs[i].rawLen))
        const totalW = weights.reduce((a, b) => a + b, 0)
        let prevShare = 0
        for (let b = 0; b < fragments.length; b++) {
          const f = fragments[b]
          groupCost[b] = g.payload.length * 8 * weights[f.member] / totalW * f.len / segs[g.members[f.member]].rawLen
        }
        let share = 0
        for (let j = 0; j < g.members.length; j++) {
          share += g.payload.length * weights[j] / totalW
          const end = j === g.members.length - 1 ? g.payload.length : Math.round(share)
          segs[g.members[j]].compLen = end - Math.round(prevShare)
          prevShare = share
        }
      }
    } else if (parallelGroups?.[gi]) {
      // 并行结果：载荷用 worker 算好的那份，成本仓按同样逻辑块边界拷回。
      const done = parallelGroups[gi]!
      g.payload = done.bytes
      costBins.values.set(done.cost)
      // P4-3：v15 / WORD-PRE 候选已经由同一个 worker 任务算好（`done.cand`），
      // 这里只做与串行逐字节相同的严格择优，主线程不再重跑一遍编码。
      // 候选缺失（规则不在 v15 覆盖范围）时 chooseGroupV15 会直接返回 false。
      g.v15 = chooseGroupV15(
        g.members.map(i => data.subarray(segs[i].start, segs[i].end)), g,
        g.members.map(i => segs[i].start), done.cand ?? undefined,sp=>reservations.available(g,sp),
      )
    } else {
      const parts = g.members.map(i => data.subarray(segs[i].start, segs[i].end))
      const positions = g.members.map(i => segs[i].start)
      g.payload = encodeTerrainGroup(parts, g.spec, undefined, costBins,
        (done, total) => onStage?.(`编码地形 ${gi + 1}/${unique.length} · ${Math.floor(done / Math.max(1, total) * 100)}%`, 50 + 35 * (gi + done / Math.max(1, total)) / unique.length), positions)
      // P2：同一分组再试一次 v15（APM 校准），只有真的更小才替换。
      // 成本图仍保留 v13 那一份——它只用于后续调度/分块展示，不影响比特流。
      g.v15 = chooseGroupV15(parts, g, positions,undefined,sp=>reservations.available(g,sp))
    }
    // P17.5: harmonic stride de-aliasing. Only transpose groups whose four
    // residue classes are statistically two repeated stride-2 classes enter
    // this path; true stride-4 sources fail the detector and pay nothing.
    if((g.spec.id===ID.TRANSPOSE||g.spec.id===ID.TRANSPOSE_GROUP||g.spec.id===ID.TRANSPOSE_GROUP_V3)
      && g.spec.s===4 && len>=32768) {
      try {
        const parts=g.members.map(i=>data.subarray(segs[i].start,segs[i].end))
        const de=harmonicStride2Plan(g,parts,sp=>reservations.available(g,sp))
        if(de) {
          const oldPrice=g.payload.length+selectionHeaderBytes(g.spec,len,g.payload.length,payloadModelFlags(g.payload),!!g.v15)
          const newPrice=de.payload.length+selectionHeaderBytes(de.spec,len,de.payload.length,payloadModelFlags(de.payload),false)
          // Both the group payload and its real header must shrink.
          if(de.payload.length<g.payload.length && newPrice<oldPrice) {
            reservations.claim(g,de.spec)
            g.spec=de.spec;g.payload=de.payload;g.v15=false;g.wordPre=false;g.context=undefined;g.matchDist=undefined
            fillUniformCosts(costBins,len,g.payload.length*8)
            for(const i of g.members) { segs[i].spec=g.spec;segs[i].label=specLabel(g.spec) }
            // The de-aliased s=2 group is a NEW spec, so the v15 decision taken
            // on the old s=4 spec is void. Re-run the kernel search here; it
            // sees the s=2 columns (and the inner suppression) for the first
            // time, which is exactly where v20 wins on F/N.
            const positions = g.members.map(i => segs[i].start)
            g.v15 = chooseGroupV15(parts, g, positions, undefined, sp => reservations.available(g, sp))
            if(g.v15) fillUniformCosts(costBins,len,g.payload.length*8)
          }
        }
      } catch { /* de-aliasing is a candidate, never a reason to lose the base */ }
    }
    reservations.claim(g,g.spec)
    for(const i of g.members){segs[i].spec=g.spec;segs[i].label=specLabel(g.spec);segs[i].modelFlags=payloadModelFlags(g.payload)}
    if(g.spec.id===ID.MICRO) for(let j=0;j<g.members.length;j++) segs[g.members[j]].micro={weights:microWeights(g.payload.subarray(j*MICRO_SEED_BYTES,(j+1)*MICRO_SEED_BYTES)),scale:32}
    if(g.spec.id===ID.SUB_TRANSPOSE || g.spec.id===ID.SUB_ANCHOR || g.spec.id===ID.SUB_TRANSPOSE_V3 || g.spec.id===ID.SUB_ANCHOR_V3) {
      const st={p:0};let j=0
      while(j<g.members.length) {
        const count=getVar(g.payload,st),size=getVar(g.payload,st),members=g.members.slice(j,j+count),sub=g.payload.subarray(st.p,st.p+size)
        const info=(g.spec.id===ID.SUB_TRANSPOSE || g.spec.id===ID.SUB_TRANSPOSE_V3) ? inspectPeeledTranspose(sub,g.spec.s) : inspectPeeledAnchor(sub,members.map(i=>segs[i].rawLen),g.spec.r)
        for(const member of members) segs[member].subPeel=info
        j+=count;st.p+=size
      }
    }
    if(g.spec.id===ID.PEEL) {
      const st={p:0}
      for(const member of g.members) {
        const size=getVar(g.payload,st)
        segs[member].peel=inspectPeel(g.payload.subarray(st.p,st.p+size),[segs[member].rawLen],g.spec.s)
        st.p+=size
      }
    }
    const weights = new Float64Array(g.members.length)
    for (let b = 0; b < fragments.length; b++) weights[fragments[b].member] += groupCost[b]
    let total = weights.reduce((a, b) => a + b, 0)
    if (!(total > 0)) {
      weights.fill(0)
      for (let b = 0; b < fragments.length; b++) { groupCost[b] = fragments[b].len; weights[fragments[b].member] += fragments[b].len }
      total = len
    }
    if (cache && !saved) {
      const encoded = { spec: { ...g.spec }, payload: g.payload, v15: g.v15, wordPre: g.wordPre, cost: groupCost.slice(),
        bcjUpgradeChecked:g.bcjUpgradeAllowed===true }
      cache.set(cacheKeys[gi], encoded)
      cache.set(finalGroupKey(g, segs), encoded) // preserve a final transpose layout as-is
    }
    let cumulative = 0, allocated = 0
    for (let j = 0; j < g.members.length; j++) {
      const sg = segs[g.members[j]]
      cumulative += weights[j]
      const next = j === g.members.length - 1 ? g.payload.length : Math.round(g.payload.length * cumulative / total)
      sg.compLen = next - allocated; allocated = next
    }
    for (let b = 0; b < fragments.length; b++) {
      const f = fragments[b], sg = segs[g.members[f.member]], weight = weights[f.member]
      const bits = weight > 0 && groupCost[b] > 0 ? groupCost[b] * sg.compLen * 8 / weight : (weight > 0 ? 0 : sg.compLen * 8 * f.len / sg.rawLen)
      blockCost[f.block] += bits
    }
    onStage?.(`编码地形 ${gi + 1}/${unique.length}`, 50 + 35 * (gi + 1) / unique.length)
    yieldIfNeeded?.()
  }
  // P17.7: family unification and the guarded rewrites overwrite many adjacent
  // segments with the same rule. For the concatenation-invariant stream codecs
  // such a seam is pure header cost, so serialize the merged plan — payloads are
  // untouched and cache keys, worker jobs and prefetches keep the unmerged
  // identity, so nothing downstream sees a different plan shape.
  const coalesced = coalesceContiguousPlanSegments(n, segs, unique)
  const wireSegs = coalesced.segs, wireGroups = coalesced.groups
  const hdr=planHeader(n,wireSegs,wireGroups)
  const container = new Uint8Array(hdr.length + wireGroups.reduce((sum, g) => sum + g.payload.length, 0))
  container.set(hdr)
  let w = hdr.length
  for (const g of wireGroups) { container.set(g.payload, w); w += g.payload.length }
  let si = 0
  for (let b = 0; b < nb; b++) {
    const bl = analysis.blocks[b]
    blockCost[b] /= Math.max(1, bl.end - bl.start)
    while (si + 1 < segs.length && bl.start >= segs[si].end) si++
    blockSeg[b] = si
  }
  const result={ container, analysis, segs, blockCost, blockSeg, overhead: hdr.length }
  retainedContextGroups.set(container,unique.map(g=>({spec:{...g.spec},members:[...g.members],payload:g.payload,v15:g.v15,wordPre:g.wordPre})))
  retainedPlanGroups.set(container,unique)
  return result
}

async function finishPreparedPlan(
  data: Uint8Array, analysis: Analysis, merged: readonly PreparedSegment[], proposal: MacroProposal | null,
  serial: boolean, onStage: ((msg: string, pct: number) => void) | undefined, yieldIfNeeded: () => Promise<void>,
  cache: GroupCache = new Map(), initial?: Compressed, kind: 'macro' | 'orphan' = 'macro', run?: EncodeRun, refineMacro = false,
): Promise<Compressed> {
  // 两次最终编码之间不重跑 analyze/chooseSpec/orphan；原计划和其可视化对象不被宏方案改写。
  const range = (from: number, to: number) => onStage
    ? (msg: string, pct: number) => onStage(msg, from + (to - from) * Math.max(0, Math.min(1, (pct - 50) / 35)))
    : undefined
  try {
    let baseline = initial ?? await encodePreparedPlan(data, analysis, merged, serial,
      proposal ? range(50, 67) : onStage, yieldIfNeeded, undefined, cache, false, run)
    if (!proposal) return baseline
    if(kind==='macro' && refineMacro)baseline=await refineContextCandidates(data,baseline,{serial})
    const comparison: MacroComparison = {
      baselineBytes: baseline.container.length, baselineHeaderBytes: baseline.overhead,
      baselineVersion: baseline.container[3], candidateBytes: null, candidateHeaderBytes: null,
      candidateVersion: null, accepted: false, proposal: { ...proposal.spec },
      reusedProbePayload: false,
    }
    comparison.screen = proposal.screen
    if (proposal.orphanGroups !== undefined) comparison.orphanGroups = proposal.orphanGroups
    comparison.rewrittenSegments = proposal.members?.size ?? merged.filter(m => m.spec.id !== ID.FILL).length
    if (proposal.sample) comparison.sample = { ...proposal.sample }
    if (proposal.spanBytes !== undefined) comparison.sampleSpanBytes = proposal.spanBytes
    const result = (chosen: Compressed): Compressed => ({ ...chosen,
      ...(baseline.orphanComparison ? { orphanComparison: baseline.orphanComparison } : {}),
      [kind === 'macro' ? 'macroComparison' : 'orphanComparison']: comparison,
    })
    let candidate: Compressed
    try {
      if (!validPlanSpec(proposal.spec)) throw new Error('无效的宏候选规则')
      const candidatePlan = proposalPlan(merged, proposal)
      if (run) run.stats[kind === 'macro' ? 'macroTrials' : 'orphanTrials']++
      validatePlan(data, candidatePlan)
      candidate = await encodePreparedPlan(data, analysis, candidatePlan, serial, range(67, 85), yieldIfNeeded, proposal.seed, cache, true, run)
    } catch (e) {
      // 候选失败不破坏已经完成的原容器；错误显式记入诊断，不能伪装为已采用。
      comparison.error = e instanceof Error ? e.message : String(e)
      comparison.reusedProbePayload = !!proposal.seed?.used
      onStage?.(`${kind === 'macro' ? '宏组' : '孤儿'}候选失败，保留原容器：${comparison.error}`, 85)
      return result(baseline)
    }
    if(kind==='macro' && refineMacro) {
      candidate=await refineContextCandidates(data,candidate,{serial})
      if(proposal.spec.id===ID.TEXT_V3||proposal.spec.id===ID.BIN_V3) {
        try {
          const ids=merged.map((m,i)=>m.spec.id!==ID.FILL&&(!proposal.members||proposal.members.has(i))?i:-1).filter(i=>i>=0)
          const sample=groupKernelSample(ids.map(i=>data.subarray(merged[i].start,merged[i].end)),ids.map(i=>merged[i].start),4,CONTEXT_PROBE_BYTES)
          if(sample.bytes>=CONTEXT_MIN_BYTES) {
            const input=joinContextBin(sample.parts),price=(id:number,ctx:CMContext,profile:Profile)=>{
              const payload=withCMProbe(()=>encodeCM(input,profile,1,1,undefined,0,undefined,undefined,'v20',0,false,{context:ctx}))
              const spec={id,s:1,r:1};return payload.length+selectionHeaderBytes(spec,sample.bytes,payload.length,payloadModelFlags(payload),true,false,ctx)
            }
            const textBytes=price(ID.TEXT_V3,'text-sparse5','text'),binBytes=price(ID.BIN_V3,'bin-stride4','bin')
            const winner=binBytes<textBytes?ID.BIN_V3:ID.TEXT_V3
            comparison.contextMacroProbe={sampleBytes:sample.bytes,textBytes,binBytes,winner}
            // Spend one full alternate plan only when the sample disagrees by a
            // margin larger than screen noise; the final gate still needs the
            // strictly smaller complete container.
            if(winner!==proposal.spec.id && Math.abs(textBytes-binBytes)>=Math.min(textBytes,binBytes)*0.002) {
              const alternate={...proposal,spec:{id:winner,s:1,r:1},seed:undefined}
              const altPlan=proposalPlan(merged,alternate);validatePlan(data,altPlan)
              const alt=await refineContextCandidates(data,await encodePreparedPlan(data,analysis,altPlan,serial,range(67,85),yieldIfNeeded,undefined,cache,true,run),{serial})
              comparison.contextMacroProbe.alternateBytes=alt.container.length
              if(alt.container.length<candidate.container.length)candidate=alt
            } else if(winner!==proposal.spec.id) comparison.contextMacroProbe.skipped='sample-margin-too-small'
          }
        }catch(e){if(comparison.contextMacroProbe)comparison.contextMacroProbe.error=e instanceof Error?e.message:String(e)}
      }
    }
    comparison.candidateBytes = candidate.container.length
    comparison.candidateHeaderBytes = candidate.overhead
    comparison.candidateVersion = candidate.container[3]
    comparison.reusedProbePayload = !!proposal.seed?.used
    // 包含真正的版本/配置、字典 varint、段长度、分组位图、所有载荷。相等也保留原方案。
    comparison.accepted = candidate.container.length < baseline.container.length
      && (kind === 'macro' || candidate.container.length - candidate.overhead < baseline.container.length - baseline.overhead)
    onStage?.(`${kind === 'macro' ? '宏组' : '孤儿'}完整容器：${baseline.container.length} → ${candidate.container.length} B（${comparison.accepted ? '采用' : '回退原方案'}）`, 85)
    return result(comparison.accepted ? candidate : baseline)
  } finally {
    // 覆盖候选异常和拒绝；不留下挂住 Node 的 worker 活跃句柄。
    if (!run) await closeNodePool()
  }
}

/** 诊断入口：给定明确的、已划分的原计划，复用生产的最终编码/宏回退路径。
 * 不重跑候选选择；undefined=真实采样门，null=仅原计划，Spec=强制提出该候选以测试误判。
 * 强制候选只用于诊断，不是生产旋钮；不能把此入口冒充 compressAdaptive 的收益结果。 */
export async function compressMacroPlanForProbe(
  data: Uint8Array, picks: readonly PlanSegment[], proposal?: Spec | null, refineMacro = false,
): Promise<Compressed> {
  encodingModelFlags()
  validatePlan(data, picks)
  const prepared: PreparedSegment[] = picks.map(p => ({ ...p, spec: { ...p.spec }, trials: [] }))
  const offered = proposal === undefined ? macroUniformGate(data, prepared)
    : proposal === null ? null : { spec: { ...proposal } }
  return finishPreparedPlan(data, analyze(data), prepared, offered, true, undefined, async () => {},undefined,undefined,'macro',undefined,refineMacro)
}

export async function compressOrphanPlanForProbe(data: Uint8Array, picks: readonly PlanSegment[]): Promise<Compressed> {
  encodingModelFlags(); validatePlan(data, picks)
  const prepared: PreparedSegment[] = picks.map(p => ({ ...p, spec: { ...p.spec }, trials: [] }))
  const cache: GroupCache = new Map()
  const baseline = await finishPreparedPlan(data, analyze(data), prepared, null, true, undefined, async () => {}, cache)
  return finishPreparedPlan(data, baseline.analysis, baseline.segs, consolidateOrphans(data.length, baseline.segs),
    true, undefined, async () => {}, cache, baseline, 'orphan')
}

async function encodeGuardedPlans(
  data: Uint8Array, analysis: Analysis, merged: readonly PreparedSegment[], serial: boolean,
  onStage: ((msg: string, pct: number) => void) | undefined, yieldIfNeeded: () => Promise<void>,
  batchGuards = true, runner?: GroupJobRunner, reuseGuardBases = true, refineMacro = false,
): Promise<Compressed> {
  const cache: GroupCache = new Map(), run = newEncodeRun(batchGuards, runner, reuseGuardBases)
  const phase = (lo: number, hi: number) => onStage
    ? (msg: string, pct: number) => onStage(msg, lo + (hi - lo) * Math.max(0, Math.min(1, (pct - 50) / 35))) : undefined
  try {
    let chosen = await finishPreparedPlan(data, analysis, merged, null, serial, phase(50, 65), yieldIfNeeded, cache, undefined, 'macro', run)
    run.initial = false; run.prefetch = undefined
    const orphan = planTuning.orphanConsolidation ? consolidateOrphans(data.length, chosen.segs) : null
    if (orphan) {
      if (batchGuards && !serial) run.prefetch = guardPrefetch(data.length, chosen.segs, orphan)
      chosen = await finishPreparedPlan(data, analysis, chosen.segs, orphan, serial, phase(65, 75), yieldIfNeeded, cache, chosen, 'orphan', run)
    }
    run.prefetch = undefined
    const macro = planTuning.macroUniformGate ? macroUniformGate(data, chosen.segs, phase(75, 85)) : null
    if (macro) chosen = await finishPreparedPlan(data, analysis, chosen.segs, macro, serial, phase(75, 85), yieldIfNeeded, cache, chosen, 'macro', run, refineMacro)
    onStage?.('完整容器择优完成', 85)
    return { ...chosen, guardStats: { ...run.stats } }
  } finally { await closeNodePool() }
}

/** Diagnostic-only replay of explicit final assignments over ONE unchanged
 * input. Shares the production final-group cache across plans so tests can
 * exercise aliases whose target becomes occupied. No chooser or guard search. */
export async function compressCachedPlansForProbe(data: Uint8Array, plans: readonly (readonly PlanSegment[])[],
  options?: { serial?: boolean; runJobs?: GroupJobRunner }): Promise<Compressed[]> {
  encodingModelFlags()
  const analysis = analyze(data), cache: GroupCache = new Map(), run = newEncodeRun(false, options?.runJobs)
  run.initial = false
  const results: Compressed[] = []
  try {
    for (const picks of plans) {
      validatePlan(data, picks)
      const prepared = picks.map(p => ({ ...p, spec: { ...p.spec }, trials: [] }))
      const result = await encodePreparedPlan(data, analysis, prepared, !!options?.serial,
        undefined, async () => {}, undefined, cache, true, run)
      results.push({ ...result, guardStats: { ...run.stats } })
    }
    return results
  } finally { await closeNodePool() }
}

/** Tiny explicit-plan tests can inject a runner (including a real worker pool
 * with synthetic scheduling weights). Never changes bytes or production cutoffs. */
export async function compressGuardedPlanForProbe(data: Uint8Array, picks: readonly PlanSegment[],
  options?: { serial?: boolean; batchGuards?: boolean; reuseGuardBases?: boolean; runJobs?: GroupJobRunner }): Promise<Compressed> {
  encodingModelFlags(); validatePlan(data, picks)
  const prepared = picks.map(p => ({ ...p, spec: { ...p.spec }, trials: [] }))
  return encodeGuardedPlans(data, analyze(data), prepared, !!options?.serial, undefined, async () => {},
    options?.batchGuards !== false, options?.runJobs, options?.reuseGuardBases !== false)
}

function coalesceCompressedPlan(dataLen: number, cp: Compressed): Compressed {
  if (cp.segs.some(s => s.spec.id !== ID.TEXT_V3 && s.spec.id !== ID.FILL)) return cp
  const groups = retainedPlanGroups.get(cp.container)
  if (!groups) return cp
  const c = coalesceContiguousPlanSegments(dataLen, cp.segs, groups)
  if (!c.adopted) return cp
  const hdr = planHeader(dataLen, c.segs, c.groups)
  const container = new Uint8Array(hdr.length + c.groups.reduce((n, g) => n + g.payload.length, 0))
  container.set(hdr)
  let w = hdr.length
  for (const g of c.groups) { container.set(g.payload, w); w += g.payload.length }
  retainedPlanGroups.set(container, c.groups)
  // P28.7: coalescing builds a NEW container object, and the group map is keyed
  // by identity. Without this the whole context tournament silently aborted for
  // every coalesced plan (a numeric table hit "缺少实际旧容器的分组载荷"), which is why
  // its proven 31,525 B `text-vertcol` layout never got to compete.
  retainedContextGroups.set(container, c.groups.map(g => ({ spec: { ...g.spec }, members: [...g.members], payload: g.payload, v15: g.v15, wordPre: g.wordPre })))
  return { ...cp, container, overhead: hdr.length }
}

/** Append the v24 CRC-32C trailer of the *decompressed* payload. */
function sealChecksum(comp: Compressed, raw: Uint8Array): Compressed {
  const out = new Uint8Array(comp.container.length + 4)
  out.set(comp.container)
  out.set(crcTrailer(crc32c(raw)), comp.container.length)
  const groups = retainedPlanGroups.get(comp.container)
  if (groups) retainedPlanGroups.set(out, groups)
  return { ...comp, container: out, overhead: comp.overhead + 4 }
}

/** Serialises concurrent `compressAdaptive` calls.
 *
 *  The planner keeps per-call state in module-level singletons (`activeLevel`,
 *  `strictPriorsFlag`, `checksumFlag`, the worker `level`/`strictPrior` payloads)
 *  and awaits between stages, so two overlapping calls would observe each other's
 *  options — a `strictZeroPrior` call could pick up a `max` level, or a v24 header
 *  could be written while another call has already switched the flags. The library
 *  entry point therefore runs one encode at a time; a queue costs nothing for the
 *  single-call case and removes a whole class of silent corruption.
 */

let encodeChain: Promise<void> = Promise.resolve()
async function withEncodeLock<T>(run: () => Promise<T>): Promise<T> {
  const previous = encodeChain
  let release!: () => void
  encodeChain = new Promise<void>(resolve => { release = resolve })
  await previous
  try { return await run() } finally { release() }
}

export async function compressAdaptive(
  data: Uint8Array,
  onStage?: (msg: string, pct: number) => void,
  options?: { serial?: boolean; batchGuards?: boolean; reuseGuardBases?: boolean; contextCandidates?: boolean; level?: CompressionLevel; strictZeroPrior?: boolean; checksum?: boolean; timeBudgetMs?: number; maxOutputBytes?: number },
): Promise<Compressed> {
  return withEncodeLock(async () => {
  const restoreLevel = setActiveCompressionLevel(options?.level ?? 'max')
  // v23 strict profile: every prior listed in PRIOR_REGISTRY.md is switched off
  // and the container version records it, so the decoder disables the same ones.
  const restoreStrict = setStrictPriors(!!options?.strictZeroPrior)
  // v24：可选的内容完整性尾部（CRC-32C over the decompressed bytes）。默认关闭，
  // 因此现有容器的字节序列完全不变；打开时版本号升到 24，解码端据此校验。
  const restoreChecksum = setContainerChecksum(!!options?.checksum)
  // Time budget: a cooperative deadline checked between planner stages. When it
  // fires we keep the best plan produced so far and flag it, because "best within
  // the budget" is not the same claim as "best of all candidates".
  deadlineSet(options?.timeBudgetMs ?? 0)
  const seal = (r: Compressed): Compressed => {
    if (deadlineHit()) (r as Compressed & { budgetTruncated?: boolean }).budgetTruncated = true
    const out = containerChecksumOn() ? sealChecksum(r, data) : r
    if (options?.maxOutputBytes !== undefined && out.container.length > options.maxOutputBytes) {
      throw new Error(`输出 ${out.container.length} B 超过上限 ${options.maxOutputBytes} B`)
    }
    return out
  }
  try {
    // Finish the unchanged P13.1 chooser, family/orphan/macro and WIDE guards FIRST.
    // New contexts cannot steer those heuristics or evict an old WORD-PRE winner.
    const baseline=await compressAdaptiveImpl(data,onStage,options)
    // P30.0：`fast` 档位直接返回基线计划。上下文锦标赛每组至少要一次整组真实编码
    // （15.B 上约 11 s），而它带来的是 0.1% 量级的收益 —— 这正是"用体积换时间"的定义。
    if(options?.contextCandidates===false || !cmV20Tuning.enabled || pruningLevel()===2) return seal(baseline)
    const chosen=await refineContextCandidates(data,baseline,{serial:!!options?.serial||!workerTuningMatchesDefaults()},onStage)
    // P30.0: `fast` 只做"基线 + 上下文锦标赛"两步；`balanced` 再多做两项
    // 收益最大、代价最小的结构细化（BCJ 合并、噪声凹槽切分），跳过 REC2/位平面。
    const pr = pruningLevel()
    if (deadlineHit()) return seal(coalesceCompressedPlan(data.length,chosen))
    if (pr >= 2) return seal(coalesceCompressedPlan(data.length,chosen))
    const coalescedBcj=refineBcjSegments(data,chosen)
    // P37.7：严格档跳过这两遍后处理——它们的候选集含 DELTA/DELTA_V3/TRANSPOSE_GROUP，
    // 会在严格容器里重新引入模 256 差分（P37.2 的 STRICT_FORBIDDEN_SPECS 只能约束
    // 主候选，管不到这里）。
    const carved=strictPriorsOn()?coalescedBcj:refineNoisePockets(data,coalescedBcj)
    if (pr === 1) return seal(coalesceCompressedPlan(data.length,carved))
    const upgraded=strictPriorsOn()?carved:refineGroupCodecs(data,carved)
    // P37.2：严格档跳过递归残差与位平面——两者都按字节值做算术/位拆分。
    const rec2=strictPriorsOn()?upgraded:refineRec2(data,upgraded)
    let bp=strictPriorsOn()?rec2:(rec2.rec2Comparison?.accepted?rec2:refineBitplane(data,rec2))
    // P22.1: a uniform BCJ stream must keep its call-target history across tiny
    // FILL islands. Compete the dominant BCJ_V3 spec as one whole-stream plan.
    if(data.length>=131072 && bp.segs.length>1 && bp.segs.some(s=>s.spec.id===ID.BCJ_V3)){
      try{
        const whole=await compressGuardedPlanForProbe(data,[{start:0,end:data.length,cls:'binary',spec:{id:ID.BCJ_V3,s:2,r:1}}],{serial:!!options?.serial||!workerTuningMatchesDefaults()})
        if(whole.container.length<bp.container.length)bp=whole
      }catch{}
    }
    // Small closed-loop text fallback: keep the legacy TEXT plan in the real
    // byte competition instead of letting the context upgrade erase it.
    // P30.1：一维扫描位图（传真 / 二值光栅）整段交给 `bin` 模型时，
    // `detectScanPeriod` 的 2-D 上下文能跨整幅图学习；一旦被 `refineNoisePockets`
    // 或 `refineBitplane` 切碎，每个碎片都要重新预热哈希表，反而更大
    // （整段 26,935 B vs 切碎 28,275 B）。这里只对"绝大多数字节是 0x00/0xFF、
    // 几乎不含可打印文本"的流补一个整段候选，采纳与否仍由真实容器字节数决定。
    if(!strictPriorsOn() && data.length>=65536 && bp.segs.length>1){
      let zeros=0, printable=0
      const step=Math.max(1,Math.floor(data.length/65536))
      let seen=0
      for(let i=0;i<data.length;i+=step){const b=data[i];seen++;if(b===0||b===255)zeros++;else if(b>=0x20&&b<=0x7e)printable++}
      if(seen>0 && zeros*10>=seen*3 && printable*10<=seen){
        try{
          const whole=await compressGuardedPlanForProbe(data,[{start:0,end:data.length,cls:'binary',spec:{id:ID.BIN_V3,s:1,r:1}}],{serial:!!options?.serial||!workerTuningMatchesDefaults()})
          if(whole.container.length<bp.container.length)bp=whole
        }catch{}
      }
    }
    if(data.length<131072 && pruningLevel()===0 && bp.segs.length===1 && bp.segs[0].spec.id===ID.TEXT_V3){
      try{
        const legacy=await compressGuardedPlanForProbe(data,[{start:0,end:data.length,cls:'text',spec:{id:ID.TEXT,s:1,r:1}}],{serial:!!options?.serial||!workerTuningMatchesDefaults()})
        if(legacy.container.length<bp.container.length)return seal(coalesceCompressedPlan(data.length,legacy))
      }catch{}
    }
    return seal(coalesceCompressedPlan(data.length,bp))
  }
  finally { restoreChecksum(); restoreStrict(); restoreLevel(); deadlineClear(); await closeNodePool() }
  })
}
/** P17.7 Direction 4: carve low-entropy pockets out of coarse, nearly
 * incompressible segments.
 *
 * A 512 B..8 KiB stretch of a ratio≈1 STORE/O0/SUB_ANCHOR/TRANSPOSE_GROUP_V3
 * segment can be a smooth multi-byte ramp whose byte entropy is ~8.0 but whose
 * small-stride delta entropy is far lower. The pocket is detected purely from
 * the block's own histogram (no offsets, names or sizes are known in advance),
 * each candidate rule is priced by a real encode, and the refined plan replaces
 * the old one only when the serialized container is strictly smaller. Because
 * only single-member groups are split, every untouched group keeps its exact
 * payload, and the parent pieces are re-encoded with the parent's own rule. */
const POCKET_BLOCK = 512
const POCKET_ENTROPY_LIMIT = 7.40
const POCKET_SAVINGS_MIN = 32
const POCKET_PARENT_IDS = new Set<number>([ID.STORE, ID.O0, ID.SUB_ANCHOR, ID.TRANSPOSE_GROUP_V3])
const POCKET_RES_IGNORED = new Set<number>([ID.DELTA, ID.DELTA_V3, ID.O0, ID.BIN_V3])
const POCKET_SPECS: readonly Spec[] = [
  { id: ID.BIN, s: 1, r: 1 },
  { id: ID.DELTA, s: 1, r: 1 },
  { id: ID.DELTA, s: 2, r: 1 },
  { id: ID.DELTA, s: 4, r: 1 },
  { id: ID.DELTA_V3, s: 1, r: 1 },
]
const BCJ_RUN_IDS = new Set<number>([ID.BCJ, ID.BCJ_V2, ID.BCJ_V3])

/**
 * P17.8: pre-encoding BCJ coalescing. `bcjFwd`/`bcjMsbFwd` convert E8/E9 words to a
 * position-relative form, so the encoder and the decoder must cut the stream at the
 * SAME boundaries. Re-encoding a run of contiguous `BCJ*` segments as one part both
 * fixes the calls that straddle a seam and removes one header length per seam. The
 * whole container must still shrink; otherwise the untouched plan is returned.
 */
export function refineBcjSegments(data: Uint8Array, baseline: Compressed): Compressed {
  const comparison: NonNullable<Compressed['bcjComparison']> = {
    baselineBytes: baseline.container.length, candidateBytes: baseline.container.length,
    accepted: false, seams: 0,
  }
  try {
    if (strictPriorsOn()) return { ...baseline, bcjComparison: comparison }
    const groups = retainedPlanGroups.get(baseline.container)
    if (!groups) return { ...baseline, bcjComparison: comparison }
    const owner = new Int32Array(baseline.segs.length).fill(-1)
    for (let gi = 0; gi < groups.length; gi++) for (const i of groups[gi].members) owner[i] = gi
    const merged: SegResult[] = []
    const oldToNew = new Int32Array(baseline.segs.length).fill(-1)
    const groupOfNew: number[] = []
    const firstOfNew: number[] = []
    for (let i = 0; i < baseline.segs.length;) {
      const seg = baseline.segs[i]
      let j = i
      if (BCJ_RUN_IDS.has(seg.spec.id) && owner[i] >= 0) {
        while (j + 1 < baseline.segs.length
          && BCJ_RUN_IDS.has(baseline.segs[j + 1].spec.id)
          && sameSpec(seg.spec, baseline.segs[j + 1].spec)
          && owner[j + 1] === owner[i]
          && baseline.segs[j].end === baseline.segs[j + 1].start) j++
      }
      if (j > i) comparison.seams += j - i
      const mi = merged.length
      merged.push(j > i ? { ...seg, end: baseline.segs[j].end, rawLen: baseline.segs[j].end - seg.start, compLen: 0 } : seg)
      groupOfNew.push(owner[i])
      firstOfNew.push(i)
      for (let k = i; k <= j; k++) oldToNew[k] = mi
      i = j + 1
    }
    if (!comparison.seams) return { ...baseline, bcjComparison: comparison }
    const nextGroups: PlanGroup[] = []
    for (let gi = 0; gi < groups.length; gi++) {
      const prev = groups[gi]
      const members: number[] = []
      for (let mi = 0; mi < merged.length; mi++) if (groupOfNew[mi] === gi) members.push(mi)
      if (members.length === prev.members.length) { nextGroups.push({ ...prev, members }); continue }
      const parts = members.map(i => data.subarray(merged[i].start, merged[i].end))
      const positions = members.map(i => merged[i].start)
      const prevFlags = payloadModelFlags(prev.payload)
      const kernel: CMVariant = (prevFlags & V20_FLAG_CM) ? 'v20' : prev.v15 ? 'v15' : false
      const payload = encodeTerrainGroup(parts, prev.spec, undefined, undefined, undefined, positions, kernel,
        prev.context || prev.matchDist ? { context: prev.context, matchDist: prev.matchDist } : undefined)
      nextGroups.push({ ...prev, members, payload, v15: !!kernel })
    }
    for (const g of nextGroups) {
      let allocated = 0, cumulative = 0
      const total = g.members.reduce((n, i) => n + merged[i].rawLen, 0)
      for (let j = 0; j < g.members.length; j++) {
        const i = g.members[j]
        cumulative += merged[i].rawLen
        const end = j === g.members.length - 1 ? g.payload.length : Math.round(g.payload.length * cumulative / Math.max(1, total))
        merged[i].compLen = end - allocated
        merged[i].modelFlags = payloadModelFlags(g.payload)
        allocated = end
      }
    }
    const header = planHeader(data.length, merged, nextGroups)
    const total = header.length + nextGroups.reduce((n, g) => n + g.payload.length, 0)
    comparison.candidateBytes = total
    if (total >= baseline.container.length) return { ...baseline, bcjComparison: comparison }
    const container = new Uint8Array(total)
    container.set(header)
    let w = header.length
    for (const g of nextGroups) { container.set(g.payload, w); w += g.payload.length }
    const blockCost = new Float32Array(baseline.blockCost.length), blockSeg = new Int32Array(baseline.blockSeg.length)
    let si = 0
    for (let b = 0; b < baseline.blockCost.length; b++) {
      const bl = baseline.analysis.blocks[b]
      while (si + 1 < merged.length && bl.start >= merged[si].end) si++
      const sg = merged[si]
      blockCost[b] = sg.rawLen > 0 ? (sg.compLen ?? 0) * 8 / sg.rawLen : 0
      blockSeg[b] = si
    }
    comparison.accepted = true
    retainedPlanGroups.set(container, nextGroups)
    return { ...baseline, container, segs: merged, blockCost, blockSeg, overhead: header.length, bcjComparison: comparison }
  } catch (error) {
    comparison.accepted = false
    comparison.candidateBytes = baseline.container.length
    return { ...baseline, bcjComparison: comparison }
  }
}

export function refineNoisePockets(data: Uint8Array, baseline: Compressed): Compressed {
  const comparison: PocketComparison = { baselineBytes: baseline.container.length, candidateBytes: baseline.container.length, accepted: false, scannedBytes: 0, pockets: [] }
  const finish = (chosen: Compressed) => ({ ...chosen, pocketComparison: comparison })
  try {
    if (!planTuning.pocketCarve || data.length < 2 * POCKET_BLOCK) return finish(baseline)
    const groups = retainedPlanGroups.get(baseline.container)
    if (!groups) return finish(baseline)
    const owner = new Int32Array(baseline.segs.length).fill(-1)
    for (let gi = 0; gi < groups.length; gi++) for (const i of groups[gi].members) owner[i] = gi
    // P17.8: every segment of a carvable rule is scanned, including segments inside a
    // group that already holds several members. P17.7 skipped those (`members.length
    // !== 1`), which made a second pass impossible: the first carve splits the STORE
    // group into many members, and the leftovers of that same pass were then invisible
    // to every later pass (measured on AITDCC/P: 18 pockets worth 2,670 B).
    interface PocketCandidate { seg: number; start: number; end: number; savings: number; parent: number }
    const candidates: PocketCandidate[] = []
    for (let i = 0; i < baseline.segs.length; i++) {
      const seg = baseline.segs[i], gi = owner[i]
      if (gi < 0) continue
      const g = groups[gi]
      // Word-PRE / context / matchDist groups are excluded because a carved pocket
      // would have to be coded in the *same* model as the parent for the header to
      // stay legal; a plain v20 BIN/DELTA pocket inside them would change the group's
      // context code and the header would be rejected.
      if (g.wordPre || g.context || g.matchDist) continue
      if (!POCKET_PARENT_IDS.has(seg.spec.id) || seg.rawLen < 1024) continue
      if ((seg.compLen ?? seg.rawLen) < seg.rawLen * 0.985) continue
      comparison.scannedBytes += seg.rawLen
      const blockStarts: number[] = [], blockEntropy: number[] = []
      for (let b = seg.start; b + POCKET_BLOCK <= seg.end; b += POCKET_BLOCK) {
        blockStarts.push(b)
        blockEntropy.push(blockMinEntropy(data, b, b + POCKET_BLOCK))
      }
      let k = 0
      while (k < blockStarts.length) {
        if (blockEntropy[k] >= POCKET_ENTROPY_LIMIT) { k++; continue }
        let j = k, savings = 0
        while (j < blockStarts.length && blockEntropy[j] < POCKET_ENTROPY_LIMIT) {
          savings += POCKET_BLOCK * (8 - blockEntropy[j]) / 8
          j++
        }
        if (savings >= POCKET_SAVINGS_MIN) candidates.push({ seg: i, start: blockStarts[k], end: blockStarts[j - 1] + POCKET_BLOCK, savings, parent: seg.spec.id })
        k = j
      }
    }
    if (!candidates.length) return finish(baseline)
    // Largest estimated local win first: a pocket that is worth little on its own can
    // still be accepted later, but it must never consume the header/gate budget that a
    // big pocket needs.
    candidates.sort((a, b) => b.savings - a.savings)
    const priceCache = new Map<string, Uint8Array>()
    const groupKey = (sp: Spec) => `${sp.id},${sp.s},${sp.r}`
    const rangeKey = (segs: readonly { start: number; end: number }[], members: readonly number[]) => members.map(i => `${segs[i].start}:${segs[i].end}`).join(',')
    const prevByKey = new Map<string, PlanGroup>()
    for (const g of groups) prevByKey.set(groupKey(g.spec), g)
    const usedRes = new Set<string>()
    for (const g of groups) usedRes.add(groupKey(g.spec))
    interface AcceptedPocket { candidate: PocketCandidate; spec: Spec }
    const buildPlan = (accepted: readonly AcceptedPocket[]) => {
      const nextSegs: SegResult[] = []
      const bySeg = new Map<number, AcceptedPocket[]>()
      for (const p of accepted) { const list = bySeg.get(p.candidate.seg); if (list) list.push(p); else bySeg.set(p.candidate.seg, [p]) }
      for (let i = 0; i < baseline.segs.length; i++) {
        const seg = baseline.segs[i], pieces = bySeg.get(i)
        if (!pieces) { nextSegs.push(seg); continue }
        pieces.sort((a, b) => a.candidate.start - b.candidate.start)
        let p = seg.start
        for (const piece of pieces) {
          if (piece.candidate.start > p) nextSegs.push({ ...seg, start: p, end: piece.candidate.start, rawLen: piece.candidate.start - p })
          nextSegs.push({ start: piece.candidate.start, end: piece.candidate.end, cls: seg.cls, spec: { ...piece.spec }, label: specLabel(piece.spec), rawLen: piece.candidate.end - piece.candidate.start, compLen: 0, trials: [] })
          p = piece.candidate.end
        }
        if (seg.end > p) nextSegs.push({ ...seg, start: p, rawLen: seg.end - p })
      }
      const buckets = new Map<string, { spec: Spec; members: number[] }>()
      for (let i = 0; i < nextSegs.length; i++) {
        const spec = nextSegs[i].spec, key = groupKey(spec)
        const bucket = buckets.get(key)
        if (bucket) bucket.members.push(i)
        else buckets.set(key, { spec, members: [i] })
      }
      const nextGroups: PlanGroup[] = []
      for (const [key, bucket] of buckets) {
        const prev = prevByKey.get(key)
        if (prev && rangeKey(nextSegs, bucket.members) === rangeKey(baseline.segs, prev.members)) {
          nextGroups.push({ ...prev, members: bucket.members })
          continue
        }
        const prevFlags = prev ? payloadModelFlags(prev.payload) : 0
        const kernel: CMVariant = prev ? ((prevFlags & V20_FLAG_CM) ? 'v20' : prev.v15 ? 'v15' : false) : 'v20'
        const cacheKey = `${key}|${rangeKey(nextSegs, bucket.members)}`
        let payload = priceCache.get(cacheKey)
        if (!payload) {
          const parts = bucket.members.map(i => data.subarray(nextSegs[i].start, nextSegs[i].end))
          const positions = bucket.members.map(i => nextSegs[i].start)
          payload = encodeTerrainGroup(parts, bucket.spec, undefined, undefined, undefined, positions, kernel,
            prev && (prev.context || prev.matchDist) ? { context: prev.context, matchDist: prev.matchDist } : undefined)
          priceCache.set(cacheKey, payload)
        }
        nextGroups.push({ spec: { ...bucket.spec }, members: bucket.members, payload, v15: !!kernel, ...(prev?.wordPre ? { wordPre: true } : {}), ...(prev?.context ? { context: prev.context } : {}), ...(prev?.matchDist ? { matchDist: true } : {}) })
        for (const i of bucket.members) {
          nextSegs[i].modelFlags = payloadModelFlags(payload)
          nextSegs[i].compLen = 0
        }
        let allocated = 0, cumulative = 0
        const total = bucket.members.reduce((n, i) => n + nextSegs[i].rawLen, 0)
        for (let j = 0; j < bucket.members.length; j++) {
          const i = bucket.members[j]
          cumulative += nextSegs[i].rawLen
          const end = j === bucket.members.length - 1 ? payload.length : Math.round(payload.length * cumulative / Math.max(1, total))
          nextSegs[i].compLen = end - allocated
          allocated = end
        }
      }
      const header = planHeader(data.length, nextSegs, nextGroups)
      const total = header.length + nextGroups.reduce((n, x) => n + x.payload.length, 0)
      return { nextSegs, nextGroups, header, total }
    }
    // P17.8: greedy, one pocket at a time. Each pocket is priced against the CURRENT
    // best container, so a pocket that only pays because it rides along with another
    // one cannot drag a losing bucket in. The accepted set is monotone (only
    // strictly smaller containers are kept), so the final result can never be worse
    // than the P17.7 baseline.
    const accepted: AcceptedPocket[] = []
    let bestTotal = baseline.container.length
    let best = buildPlan(accepted)
    for (const candidate of candidates) {
      if (deadlineHit()) break
      const pocket = data.subarray(candidate.start, candidate.end)
      // Spec options: the merged r=1 group (each pocket of a rule shares one stream)
      // and, for rules whose decoder ignores `res`, one isolated group with a fresh
      // res tag. Isolated groups pay ~8 B of header but avoid the cold-start cost of
      // a shared stream, which is what made P17.7 reject the cheap STORE pockets.
      const options: Spec[] = []
      const standalone: { spec: Spec; bytes: number }[] = []
      for (const sp of POCKET_SPECS) {
        let payload: Uint8Array | undefined
        try { payload = withCMProbe(() => encodeTerrainGroup([pocket], sp, undefined, undefined, undefined, [candidate.start], 'v20')) } catch { payload = undefined }
        if (payload) standalone.push({ spec: sp, bytes: payload.length })
      }
      standalone.sort((a, b) => a.bytes - b.bytes)
      for (const entry of standalone.slice(0, 2)) {
        // Isolated group first: a fresh `res` tag is a distinct group key, so the
        // pocket's stream is coded from a cold start that belongs to the pocket alone
        // and no pre-existing group payload has to be re-encoded.
        if (POCKET_RES_IGNORED.has(entry.spec.id)) {
          for (let r = 2; r <= 200; r++) {
            const iso = { ...entry.spec, r }
            if (usedRes.has(groupKey(iso))) continue
            options.push(iso)
            break
          }
        }
        options.push(entry.spec)
      }
      let chosen: AcceptedPocket | undefined
      for (const spec of options) {
        const trial = [...accepted, { candidate, spec }]
        let plan: ReturnType<typeof buildPlan>
        try { plan = buildPlan(trial) } catch { continue }
        if (plan.total < bestTotal) { bestTotal = plan.total; best = plan; chosen = { candidate, spec } }
      }
      if (chosen) {
        accepted.push(chosen)
        usedRes.add(groupKey(chosen.spec))
        comparison.pockets.push({ start: chosen.candidate.start, end: chosen.candidate.end, parent: chosen.candidate.parent, spec: { ...chosen.spec }, payloadBytes: best.nextGroups.find(g => groupKey(g.spec) === groupKey(chosen!.spec))?.payload.length ?? 0 })
      }
    }
    comparison.candidateBytes = bestTotal
    if (!accepted.length || bestTotal >= baseline.container.length) return finish(baseline)
    const { nextSegs, nextGroups, header } = best
    const container = new Uint8Array(bestTotal)
    container.set(header)
    let w = header.length
    for (const g of nextGroups) { container.set(g.payload, w); w += g.payload.length }
    const blockCost = new Float32Array(baseline.blockCost.length), blockSeg = new Int32Array(baseline.blockSeg.length)
    let si = 0
    for (let b = 0; b < baseline.blockCost.length; b++) {
      const bl = baseline.analysis.blocks[b]
      while (si + 1 < nextSegs.length && bl.start >= nextSegs[si].end) si++
      const sg = nextSegs[si]
      blockCost[b] = sg.rawLen > 0 ? (sg.compLen ?? 0) * 8 / sg.rawLen : 0
      blockSeg[b] = si
    }
    comparison.accepted = true
    retainedPlanGroups.set(container, nextGroups)
    return finish({ ...baseline, container, segs: nextSegs, blockCost, blockSeg, overhead: header.length })
  } catch (error) {
    comparison.error = error instanceof Error ? error.message : String(error)
    comparison.accepted = false
    comparison.candidateBytes = baseline.container.length
    return finish(baseline)
  }
}
export interface GroupCodecComparison {
  baselineBytes: number
  candidateBytes: number
  accepted: boolean
  scannedGroups: number
  upgrades: { from: { id: number; s: number; r: number }; to: { id: number; s: number; r: number }; rawBytes: number; payloadBytes: number }[]
  error?: string
}
/**
 * P17.9: after the pocket carve has split the coarse segments, several small
 * groups are left holding bytes that a CM-backed codec codes better than the
 * rANS/O0 recipe that survived planning (measured on AITDCC/P: `SUB_ANCHOR
 * s=60` -> `DELTA_V3 s=2` -574 B, `BIN` -> `BIN_V3` -129 B, `TRANSPOSE s=2` ->
 * `DELTA_V3 s=2` -67 B, `SUB_ANCHOR s=10` -> `TRANSPOSE_GROUP s=2` -36 B).
 *
 * The pass is strictly additive and self-limiting: a group is only re-priced
 * when it is small (<= 128 KiB raw), free of WORD-PRE / context / matchDist
 * (those change the wire meaning of the group), and every candidate is adopted
 * only when the serialized plan - coalesced header plus the sum of all group
 * payloads - gets strictly smaller. Candidates reuse the `res` tag unless it
 * collides with a live group, in which case a fresh tag keeps the header legal
 * without merging unrelated payloads.
 */
const GROUP_CODEC_MIN_BYTES = 1024
const GROUP_CODEC_MAX_BYTES = 128 * 1024
const GROUP_CODEC_CANDIDATES: readonly { id: number; s: number; r: number }[] = [
  { id: ID.BIN_V3, s: 1, r: 1 },
  { id: ID.DELTA_V3, s: 2, r: 1 },
  { id: ID.DELTA_V3, s: 1, r: 1 },
  { id: ID.TRANSPOSE_GROUP, s: 2, r: 1 },
]
/** Groups whose recipe ignores `res`, so a fresh tag is free and legal. */
const GROUP_CODEC_RES_FREE = new Set<number>([ID.DELTA, ID.DELTA_V3, ID.O0])
const GROUP_CODEC_SKIP = new Set<number>([ID.STORE, ID.FILL, ID.REC2, ID.BITPLANE, ID.WIDE_GRAD])

export function refineGroupCodecs(data: Uint8Array, baseline: Compressed): Compressed {
  const comparison: GroupCodecComparison = { baselineBytes: baseline.container.length, candidateBytes: baseline.container.length, accepted: false, scannedGroups: 0, upgrades: [] }
  const finish = (chosen: Compressed) => ({ ...chosen, groupCodecComparison: comparison })
  try {
    if (!planTuning.groupCodecUpgrade) return finish(baseline)
    const groups = retainedPlanGroups.get(baseline.container)
    if (!groups || !groups.length) return finish(baseline)
    const segs = baseline.segs
    const nextGroups = groups.map(g => ({ ...g, spec: { ...g.spec } }))
    const usedRes = new Set(nextGroups.map(g => `${g.spec.id},${g.spec.s},${g.spec.r}`))
    let bestTotal = baseline.container.length
    let bestSegs: typeof segs | null = null
    let curSegs: typeof segs = segs
    const planTotal = (gs: readonly PlanGroup[], ss: readonly SegResult[]) => planHeader(data.length, ss, gs).length + gs.reduce((n, g) => n + g.payload.length, 0)
    for (let gi = 0; gi < nextGroups.length; gi++) {
      if (deadlineHit()) break
      const g = nextGroups[gi]
      if (GROUP_CODEC_SKIP.has(g.spec.id) || g.wordPre || g.context || g.matchDist) continue
      const members = [...g.members]
      if (!members.length) continue
      let raw = 0
      for (const i of members) raw += segs[i].end - segs[i].start
      if (raw < GROUP_CODEC_MIN_BYTES || raw > GROUP_CODEC_MAX_BYTES) continue
      comparison.scannedGroups++
      const parts = members.map(i => data.subarray(segs[i].start, segs[i].end))
      const positions = members.map(i => segs[i].start)
      const kernel: CMVariant = (payloadModelFlags(g.payload) & V20_FLAG_CM) ? 'v20' : g.v15 ? 'v15' : 'v20'
      let chosen: { spec: { id: number; s: number; r: number }; payload: Uint8Array } | null = null
      for (const cand of GROUP_CODEC_CANDIDATES) {
        if (cand.id === g.spec.id && cand.s === g.spec.s) continue
        const spec = { id: cand.id, s: cand.s, r: cand.r }
        if (usedRes.has(`${spec.id},${spec.s},${spec.r}`)) {
          // Keep the header legal without merging unrelated payloads: rule families
          // whose decoder ignores `res` can take a fresh tag, the rest are skipped.
          if (!GROUP_CODEC_RES_FREE.has(spec.id)) continue
          let r = 2
          while (r < 256 && usedRes.has(`${spec.id},${spec.s},${r}`)) r++
          if (r >= 256) continue
          spec.r = r
        }
        let payload: Uint8Array
        try {
          payload = withCMBlockSize(raw, () => encodeTerrainGroup(parts, spec as Spec, undefined, undefined, undefined, positions, kernel as 'v20' | 'v15'))
        } catch { continue }
        if (payload.length <= 24 || payload.length >= g.payload.length) continue
        // Distribute the payload exactly: the block-cost invariant is
        // `overhead + sum(compLen) === container.length`, so rounding the last
        // member as a remainder keeps the ledger byte-accurate.
        let remaining = payload.length
        let seen = 0
        const trialSegs = curSegs.map((sg, i) => {
          if (!members.includes(i)) return sg
          const len = sg.end - sg.start
          seen++
          const compLen = seen === members.length ? remaining : Math.max(1, Math.round(payload!.length * (len / raw)))
          remaining -= compLen
          return { ...sg, spec: spec as Spec, compLen }
        })
        const trialGroups = nextGroups.map((x, i) => i === gi ? { ...x, spec: spec as Spec, payload: payload!, v15: true } : x)
        let total: number
        try { total = planTotal(trialGroups, trialSegs) } catch { continue }
        if (total >= bestTotal) continue
        bestTotal = total
        bestSegs = trialSegs
        curSegs = trialSegs
        nextGroups[gi] = trialGroups[gi]
        chosen = { spec, payload: payload! }
        break
      }
      if (!chosen) continue
      usedRes.add(`${chosen.spec.id},${chosen.spec.s},${chosen.spec.r}`)
      comparison.upgrades.push({ from: { id: groups[gi].spec.id, s: groups[gi].spec.s, r: groups[gi].spec.r }, to: { ...chosen.spec }, rawBytes: raw, payloadBytes: chosen.payload.length })
    }
    comparison.candidateBytes = bestTotal
    if (!comparison.upgrades.length || !bestSegs || bestTotal >= baseline.container.length) return finish(baseline)
    const header = planHeader(data.length, bestSegs, nextGroups)
    const total = header.length + nextGroups.reduce((n, g) => n + g.payload.length, 0)
    if (total >= baseline.container.length) return finish(baseline)
    const container = new Uint8Array(total)
    container.set(header)
    let w = header.length
    for (const g of nextGroups) { container.set(g.payload, w); w += g.payload.length }
    const blockCost = new Float32Array(baseline.blockCost.length), blockSeg = new Int32Array(baseline.blockSeg.length)
    let si = 0
    for (let b = 0; b < baseline.blockCost.length; b++) {
      const bl = baseline.analysis.blocks[b]
      while (si + 1 < bestSegs.length && bl.start >= bestSegs[si].end) si++
      const sg = bestSegs[si]
      blockCost[b] = sg.rawLen > 0 ? (sg.compLen ?? 0) * 8 / sg.rawLen : 0
      blockSeg[b] = si
    }
    comparison.accepted = true
    comparison.candidateBytes = total
    retainedPlanGroups.set(container, nextGroups)
    return finish({ ...baseline, container, segs: bestSegs, blockCost, blockSeg, overhead: header.length })
  } catch (error) {
    comparison.error = error instanceof Error ? error.message : String(error)
    comparison.accepted = false
    comparison.candidateBytes = baseline.container.length
    return finish(baseline)
  }
}
/** Whole-file REC2 is a late strictly-smaller alternative, never a terrain hint. */
export function refineRec2(data:Uint8Array,baseline:Compressed):Compressed {
  const comparison:NonNullable<Compressed['rec2Comparison']>={baselineBytes:baseline.container.length,accepted:false}
  try {
    if(data.length>MAX_OUTPUT_BYTES-3)return {...baseline,rec2Comparison:comparison}
    const params=detectRec2(data)
    if(!params)return {...baseline,rec2Comparison:comparison}
    comparison.params=params
    const transformed=rec2Forward(data,params)
    const encoded=withCMBlockSize(data.length,()=>encodeCM(transformed,'bin',1,1,undefined,0,undefined,undefined,'v20'))
    markPayloadModel(encoded,payloadModelFlags(encoded)|V21_FLAG_CONTEXTS|V20_FLAG_TRANSFORMS)
    const spec={id:ID.REC2,s:1,r:1},seg:SegResult={start:0,end:data.length,cls:'noise',spec,label:specLabel(spec),rawLen:data.length,compLen:encoded.length,trials:[],modelFlags:payloadModelFlags(encoded)}
    const header=planHeader(data.length,[seg],[{spec,members:[0],payload:encoded,v15:true}])
    const total=header.length+encoded.length;comparison.candidateBytes=total
    if(total>=baseline.container.length)return {...baseline,rec2Comparison:comparison}
    const container=new Uint8Array(total);container.set(header);container.set(encoded,header.length)
    comparison.accepted=true
    const blockCost=new Float32Array(baseline.blockCost.length);blockCost.fill(encoded.length*8/data.length)
    return {...baseline,container,segs:[seg],blockCost,blockSeg:new Int32Array(baseline.blockSeg.length),overhead:header.length,rec2Comparison:comparison}
  } catch(error){comparison.error=error instanceof Error?error.message:String(error);return {...baseline,rec2Comparison:comparison}}
}

/** Whole-file bit-plane candidate: never replaces an equal or smaller container.
 *
 * Two triggers, neither of which is a statistical entropy guess:
 *  1. `bitplaneEntropyGate`: the original REC2-lineage first-2 KiB H0 > 7.5 gate;
 *  2. `bitplaneStoreTrigger`: a stream whose byte-level CM loses everywhere keeps
 *     the whole file in STORE (AITDCC/L measured 3,000,021 B, ver 7) even though
 *     its low planes carry order-16..20 structure the byte models cannot see.
 * Every plane is then arbitrated by the REAL bit-CM: a 16 KiB sample must beat the
 * raw plane by 3%, and the full-plane encode must still be smaller. A random plane
 * cannot be adopted, because the model's own output is larger than the raw plane.
 * Requires n%8==0 so that the plane layout has no trailing partial byte.
 */
export function refineBitplane(data:Uint8Array,baseline:Compressed):Compressed {
  try {
    if(data.length>MAX_OUTPUT_BYTES || data.length%8!==0)return baseline
    const rawStored=baseline.segs.reduce((n,sg)=>n+(sg.spec.id===ID.STORE?sg.rawLen:0),0)
    if(rawStored*2>=data.length){
    const period=encodePeriodBytes(data)
    if(period){
      const pspec={id:ID.BITPLANE,s:1,r:BITPLANE_PERIOD_CM},pseg:SegResult={start:0,end:data.length,cls:'noise',spec:pspec,label:specLabel(pspec),rawLen:data.length,compLen:period.length,trials:[],modelFlags:payloadModelFlags(period)}
      markPayloadModel(period,payloadModelFlags(period)|V21_FLAG_CONTEXTS|V20_FLAG_CM|V20_FLAG_TRANSFORMS)
      const ph=planHeader(data.length,[pseg],[{spec:pspec,members:[0],payload:period,v15:true}]),pt=ph.length+period.length
      if(pt<baseline.container.length){
        const pc=new Uint8Array(pt);pc.set(ph);pc.set(period,ph.length)
        const pbc=new Float32Array(baseline.blockCost.length);pbc.fill(period.length*8/data.length)
        return {...baseline,container:pc,segs:[pseg],blockCost:pbc,blockSeg:new Int32Array(baseline.blockSeg.length),overhead:ph.length}
      }
    }
    }
    if(!bitplaneEntropyGate(data) && !bitplaneStoreTrigger(data.length,rawStored))return baseline
    const screen=bitplaneFullProof(data)
    if(!screen.proof.some(Boolean))return baseline
    const payload=encodeBitplanesBitCM(data,screen.proof,screen.coded)
    if(!payload)return baseline
    markPayloadModel(payload,payloadModelFlags(payload)|V21_FLAG_CONTEXTS|V20_FLAG_CM|V20_FLAG_TRANSFORMS)
    const spec={id:ID.BITPLANE,s:1,r:BITPLANE_BIT_CM},seg:SegResult={start:0,end:data.length,cls:'noise',spec,label:specLabel(spec),rawLen:data.length,compLen:payload.length,trials:[],modelFlags:payloadModelFlags(payload)}
    const header=planHeader(data.length,[seg],[{spec,members:[0],payload,v15:true}]),total=header.length+payload.length
    if(total>=baseline.container.length)return baseline
    const container=new Uint8Array(total);container.set(header);container.set(payload,header.length)
    const blockCost=new Float32Array(baseline.blockCost.length);blockCost.fill(payload.length*8/data.length)
    return {...baseline,container,segs:[seg],blockCost,blockSeg:new Int32Array(baseline.blockSeg.length),overhead:header.length}
  } catch {return baseline}
}

/** P18.1: fast path for large pure low-cardinality streams (K <= 4). */
function distinctBytes(data: Uint8Array, cap: number): number {
  const seen = new Uint8Array(256)
  let k = 0
  for (let i = 0; i < data.length; i++) { const b = data[i]; if (!seen[b]) { seen[b] = 1; if (++k > cap) return k } }
  return k
}

/**
 * A quaternary file (DNA/protein-like, K <= 4) is won by `'sym-2bit'` + `v20`
 * by >1 %, but the generic pipeline only discovers that after it has already
 * spent three full 8-bit passes on the same bytes. Screen the two modes on a
 * bounded sample at the FULL table tier and, when the symbol mode wins, encode
 * the buffer exactly once.
 *
 * Every other shape returns null, so the caller falls back to the untouched
 * pipeline (byte-identical to the pre-P18.1 result).
 */
function lowCardinalityPlan(data: Uint8Array, analysis: Analysis, onStage?: (msg: string, pct: number) => void): Compressed | null {
  if (!planTuning.symbolFastPath) return null
  const n = data.length
  // Keep the normal segmenter's FILL/carve decisions on tiny 4 KiB streams.
  if (n < 4096) return null
  const k = distinctBytes(data, 32)
  if (k < 2 || k > 32) return null
  // P18.5: lowercase prose also fits K<=32. A >=1% ASCII-space share means the
  // bytes are word-delimited text, which the normal text/LZ/CM pipeline models
  // far better than a generic 5-bit symbol stream.
  if (k >= 5) {
    // P19.1: canonical smooth-ramp guard.  Ranks are derived only from
    // frequency and first occurrence, so a byte permutation cannot change it.
    const rampLen = Math.min(n, 4096)
    const freq = new Float64Array(256), first = new Int32Array(256).fill(-1)
    for (let i = 0; i < rampLen; i++) { const b = data[i]; if (freq[b] === 0) first[b] = i; freq[b]++ }
    const active: number[] = []
    for (let b = 0; b < 256; b++) if (freq[b] > 0) active.push(b)
    active.sort((a, b) => freq[b] - freq[a] || first[a] - first[b])
    const rank = new Uint8Array(256)
    active.forEach((b, r) => { rank[b] = r })
    let step1 = 0
    for (let i = 1; i < rampLen; i++) {
      const d = rank[data[i]] - rank[data[i - 1]]
      if (d !== 0 && (d === 1 || d === -1)) step1++
    }
    if (step1 * 2 >= rampLen) return null
  }
  // A 64 KiB sample flips AITDCC I to the coarse-seeded 5-bit mode (+19 B),
  // so both paths keep the proven 192 KiB sample.
  const sampleLen = Math.min(n, 196608)
  const sample = data.subarray(0, sampleLen)
  onStage?.('低基数符号流：采样比较 8 位与低基数符号模型…', 10)
  const probe = (ctx?: CMContext) => withCMBlockSize(n, () => encodeCM(sample, 'text', 1, 1, undefined, 0, undefined, undefined, 'v20', 0, false, ctx ? { context: ctx } : undefined)).length
  const plainBytes = probe(undefined)
  const contexts: CMContext[] = k <= 4 ? ['sym-2bit'] : ['sym-5bit', 'sym-5bit-gap']
  const candidates: { ctx: CMContext; bytes: number }[] = contexts.map(ctx => ({ ctx, bytes: probe(ctx) }))
  candidates.sort((a, b) => a.bytes - b.bytes)
  const symBytes = candidates[0].bytes
  // Quaternary files are won by >1 %, letter streams by a wider margin. The
  // sample only selects the mode; the final encode always covers the full file.
  if (k <= 4 ? symBytes >= plainBytes * 0.999 : symBytes >= plainBytes) return null
  onStage?.('低基数符号流：整份文件单遍低基数符号编码…', 20)
  const spec: Spec = { id: ID.TEXT_V3, s: 1, r: 1 }
  const ctx = candidates[0].ctx
  const payload = encodeTerrainGroup([data], spec, undefined, undefined, undefined, [0], 'v20', { context: ctx })
  const segs: SegResult[] = [{ start: 0, end: n, cls: 'text', spec, label: `CM-TEXT3 [${ctx}]`, rawLen: n, compLen: payload.length, trials: [], context: ctx }]
  const groups: PlanGroup[] = [{ spec, members: [0], payload, v15: true, context: ctx }]
  const header = planHeader(n, segs, groups)
  const container = new Uint8Array(header.length + payload.length)
  container.set(header)
  container.set(payload, header.length)
  const blockCost = new Float32Array(analysis.blocks.length)
  const blockSeg = new Int32Array(analysis.blocks.length)
  const rate = payload.length * 8 / n
  for (let b = 0; b < analysis.blocks.length; b++) { blockCost[b] = rate; blockSeg[b] = 0 }
  retainedPlanGroups.set(container, groups)
  return { container, analysis, segs, blockCost, blockSeg, overhead: header.length }
}

async function compressAdaptiveImpl(
  data: Uint8Array, onStage?: (msg: string, pct: number) => void,
  options?: { serial?: boolean; batchGuards?: boolean; reuseGuardBases?: boolean; contextCandidates?: boolean },
): Promise<Compressed> {
  encodingModelFlags() // 在任何模型分配之前拒绝未定义的格式配置。
  const serial = !!options?.serial || !workerTuningMatchesDefaults()
  if (!options?.serial && serial) parallelReport.reason = '诊断旋钮与 worker 默认值不同，显式走串行'
  onStage?.('扫描数据地形…', 5)
  await tick()
  const analysis = analyze(data)
  const n = data.length
  // P37.2：严格零先验模式下，分类器的输出本身就是一个内容先验
  // （`cls` 由可打印率/ASCII 字符类决定）。把它固定成单一不透明区域后，
  // 规则搜索只剩测量驱动的结构候选，`C(π(X)) = C(X)` 才可被强制验证。
  // 见 PRIOR_REGISTRY.md §5。
  if (strictPriorsOn()) {
    analysis.segs = n > 0
      ? [{ start: 0, end: n, cls: 'binary', b0: 0, b1: analysis.blocks.length, bestS: 1 }]
      : []
    analysis.features = []
  }
  // P30.0：非 max 档位先粗化地形分段。`chooseSpec` 的成本与**区域数**成正比
  // （每个区域 × 每个候选 × 2~3 个采样窗口各一次真实编码），而 512 B 级碎片区域
  // 是小文件上上万次探针的来源。合并相邻小区域只改变搜索粒度，
  // 容器格式与解码端完全不受影响。
  const lvlSeg = pruningLevel()
  if (lvlSeg > 0) {
    const minBytes = lvlSeg === 2 ? 32768 : 8192
    const merged: typeof analysis.segs = []
    for (const sg of analysis.segs) {
      const prev = merged[merged.length - 1]
      if (prev && sg.end - prev.start <= minBytes) prev.end = sg.end
      else merged.push({ ...sg })
    }
    if (merged.length) merged[merged.length - 1].end = analysis.segs[analysis.segs.length - 1].end
    analysis.segs = merged
  }
  {
      const fast = lowCardinalityPlan(data, analysis, onStage)
    if (fast) return fast
  }
  onStage?.('为每个区域试探最合适的编码规则…', 15)
  await tick()

  let lastYield = performance.now()
  const yieldIfNeeded = async () => {
    if (performance.now() - lastYield >= 30) { await tick(); lastYield = performance.now() }
  }
  // 大文件/多区域限制单区域试探预算；仍扫描整个区域判断是否常量。
  // P9-4.2：预算公式的上下限改成旋钮；soloSampleCap > 0 时，"整份文件就几个段"
  // 的文件可以拿到远大于 16 KB 的采样窗口（一条规则要作用于几十 MB）。
  const sampleLimits = analysis.segs.map(sg => sampleBudgetForSegment(n, analysis.segs.length, sg.end - sg.start))
  // A highly fragmented region map can hide a stable wide 16-bit raster.
  // Require three spatial probes and actual competing encodes before merging.
  let widePick: {spec:Spec;trials:Trial[]} | undefined
  let wideUpgrade: {spec:Spec;trials:Trial[]} | undefined
  const smallFragmented = analysis.segs.length >= 2 && n <= 1024*1024
  if ((analysis.segs.length >= 64 || smallFragmented) && n >= 4*65536) {
    onStage?.('探测跨区域 16 位宽行结构…', 15)
    yieldIfNeeded?.()
    const lag=detectWide16Lag(data)
    if(lag) {
      const specs:Spec[]=[{id:ID.WIDE_GRAD,s:2,r:lag},{id:ID.WIDE_GRAD,s:1,r:lag},{id:ID.DELTA_V3,s:2,r:1},{id:ID.BIN_V3,s:1,r:1},{id:ID.TRANSPOSE,s:2,r:1}]
      if(transformsV20Enabled() && n%2===0)for(let mode=3;mode<=8;mode++)specs.push({id:ID.WIDE_GRAD,s:mode,r:lag})
      const totals=new Array(specs.length).fill(0), windows=[0.2,0.5,0.8], samples:number[][]=[]
      for(const f of windows) {
        const start=Math.floor(((n-65536)*f)/2)*2, sample=data.subarray(start,start+65536)
        const sizes=withCMProbe(()=>specs.map(sp=>encodeSpec(sample,sp,undefined,0,start).length))
        samples.push(sizes);sizes.forEach((size,i)=>totals[i]+=size)
        yieldIfNeeded?.()
      }
      const win=totals.slice(0,3).indexOf(Math.min(...totals.slice(0,3)))
      // Do not replace mixed terrain unless the same image rule wins in
      // each independent sample against non-image alternatives.
      const margin=smallFragmented ? 0.85 : 0.985
      if(samples.every(x=>x[win]<Math.min(...x.slice(3,5))*margin) && totals[win]<Math.min(...totals.slice(3,5))*margin) {
        const trials=specs.map((spec,i)=>({spec,label:specLabel(spec),ratio:totals[i]/(windows.length*65536),sampleLen:windows.length*65536,payloadSize:totals[i]}))
        widePick={spec:specs[win],trials}
      }
      // s1/s2 are priced above; s3..s8 must first beat both on samples. Do not
      // discard the established wide/multi-segment plan on sampled evidence.
      if(specs.length>5) {
        let winner=totals[0]<=totals[1]?0:1
        for(let i=5;i<specs.length;i++)if(totals[i]<totals[winner])winner=i
        if(winner>=5)wideUpgrade={spec:specs[winner],trials:specs.map((spec,i)=>({spec,label:specLabel(spec),ratio:totals[i]/(windows.length*65536),sampleLen:windows.length*65536,payloadSize:totals[i]}))}
      }
    }
  }
  // 1) 逐区域试探
  const picks: { start: number; end: number; cls: Cls; spec: Spec; trials: Trial[]; trialBytes?: number }[] = []
  if (widePick) picks.push({start:0,end:n,cls:'smooth',spec:widePick.spec,trials:widePick.trials})
  // 区域试探彼此完全独立，可以并行：每个任务只读自己那段数据、只写自己的结果。
  // 汇总严格按下标回填，因此与串行结果逐字节一致。
  const parallelPicks = !serial && !widePick && analysis.segs.length >= 2 && nodeParallelReady()
    ? await tryParallelChoose(data, analysis.segs, sampleLimits, onStage)
    : null
  if (parallelPicks) {
    for (let k = 0; k < analysis.segs.length; k++) {
      const sg = analysis.segs[k]
      const { spec, trials } = parallelPicks[k]
      picks.push({ start: sg.start, end: sg.end, cls: sg.cls, spec, trials, trialBytes: trialWeight(trials, spec, sg.start, sg.end) })
      onStage?.(`区域 ${k + 1}/${analysis.segs.length} → ${specLabel(spec)}`, 15 + (35 * (k + 1)) / analysis.segs.length)
    }
  }
  for (let k = 0; !widePick && !parallelPicks && k < analysis.segs.length; k++) {
    const sg = analysis.segs[k]
    const { spec, trials } = await chooseSpec(data.subarray(sg.start, sg.end), sg.cls, sg.bestS, sampleLimits[k], yieldIfNeeded,
      label => onStage?.(`区域 ${k + 1}/${analysis.segs.length} · 试探 ${label}`, 15 + (35 * k) / analysis.segs.length), sg.start, data.length)
    picks.push({ start: sg.start, end: sg.end, cls: sg.cls, spec, trials, trialBytes: trialWeight(trials, spec, sg.start, sg.end) })
    onStage?.(`区域 ${k + 1}/${analysis.segs.length} → ${specLabel(spec)}`, 15 + (35 * (k + 1)) / analysis.segs.length)
    yieldIfNeeded?.()
  }
  // Compare actual group payloads before unifying compatible anchor geometries.
  // This is limited to groups that can be represented by both old formats.
  const anchors = new Map<string, typeof picks>()
  for (const p of picks) if (p.spec.id === ID.ANCHOR_FOLD || p.spec.id === ID.SUB_ANCHOR || p.spec.id === ID.SUB_ANCHOR_V3) {
    const key = `${p.spec.s},${p.spec.r & 127}`
    if (!anchors.has(key)) anchors.set(key, [])
    anchors.get(key)!.push(p)
  }
  for (const regions of anchors.values()) {
    if (regions.length < 2 || new Set(regions.map(p => `${p.spec.id},${p.spec.r}`)).size < 2 || regions.some(p => p.end-p.start > MAX_SUB_CHUNK)) continue
    const raw = regions[0].spec.r & 127, anchor = regions[0].spec.s
    if ((raw >= 32 || raw === 9) && raw === anchor) continue
    const parts = regions.map(p => data.subarray(p.start, p.end))
    // 6 个候选（3 种 id × 2 种模式）完整编码很贵（xml 上占 30% 时长）。
    // 先用同一批区域的中段探针把明显更差的组合淘汰，只对前 2 名做完整比对；
    // 最终仍以完整编码字节数为准，因此只是省时间，不改变选择口径。
    const combos: Spec[] = []
    for (const id of [ID.ANCHOR_FOLD, ID.SUB_ANCHOR, ID.SUB_ANCHOR_V3]) for (const mode of [0,128]) combos.push({id,s:anchor,r:raw|mode})
    const probe = anchorUnifyProbe(parts)
    let ranked = combos
    if (probe.length >= 8 * 1024) {
      ranked = combos
        .map(spec => ({ spec, size: withCMProbe(()=>encodeTerrainGroup([probe], spec)).length }))
        .sort((a, b) => a.size - b.size)
        .slice(0, 2)
        .map(x => x.spec)
      yieldIfNeeded?.()
    }
    let winner: Spec | undefined, best = Infinity
    for (const spec of ranked) {
      const size = encodeTerrainGroup(parts,spec).length
      if (size < best) { best=size; winner=spec }
      yieldIfNeeded?.()
    }
    if (winner) for (const p of regions) p.spec = winner
  }
  // 2) 相邻同规则区域合并，再按现有规则分组。
  const merged=mergePlanSegments(data,picks)
  const baseline = await encodeGuardedPlans(data, analysis, merged, serial, onStage, yieldIfNeeded, options?.batchGuards !== false, undefined, options?.reuseGuardBases !== false, options?.contextCandidates !== false && cmV20Tuning.enabled)
  if(!wideUpgrade)return baseline
  const comparison:MacroComparison={baselineBytes:baseline.container.length,baselineHeaderBytes:baseline.overhead,baselineVersion:baseline.container[3],candidateBytes:null,candidateHeaderBytes:null,candidateVersion:null,accepted:false,proposal:wideUpgrade.spec,reusedProbePayload:false,screen:'direct'}
  try {
    const candidate=await encodeGuardedPlans(data,analysis,[{start:0,end:n,cls:'smooth',...wideUpgrade}],serial,onStage,yieldIfNeeded,true,undefined,true,options?.contextCandidates!==false&&cmV20Tuning.enabled)
    comparison.candidateBytes=candidate.container.length;comparison.candidateHeaderBytes=candidate.overhead;comparison.candidateVersion=candidate.container[3]
    comparison.accepted=candidate.container.length<baseline.container.length
    return {...(comparison.accepted?candidate:baseline),wideComparison:comparison}
  }catch(e){comparison.error=e instanceof Error?e.message:String(e);return {...baseline,wideComparison:comparison}}

}

export function decompress(c: Uint8Array, onProgress?: (done: number, total: number) => void, maxOutput = MAX_OUTPUT_BYTES): Uint8Array {
  if (c.length < 4 || c[0] !== 0x55 || c[1] !== 0x43 || c[2] !== 0x5a || c[3] < 1 || c[3] > 27)
    throw new Error('不是有效的 UCZ 容器（不支持的格式版本）')
  if (c[3] >= 17 && c.length < (c[3] >= 19 ? 6 : 5)) throw new Error(`v${c[3]} 配置字段被截断`)
  // Strict version dispatch: v19 uint16 + tiered mht4; v17/v18 keep old widths.
  return withContainerModel(c[3], c[3] >= 19 ? c[4] | (c[5] << 8) : c[3] >= 17 ? c[4] : 0,
    () => decompressImpl(c, onProgress, maxOutput))
}

function decompressImpl(c: Uint8Array, onProgress?: (done: number, total: number) => void, maxOutput = MAX_OUTPUT_BYTES): Uint8Array {
  if (c.length < 6 || c[0] !== 0x55 || c[1] !== 0x43 || c[2] !== 0x5a || (c[3] !== 1 && c[3] !== 2 && c[3] !== 3 && c[3] !== 4 && c[3] !== 5 && c[3] !== 6 && c[3] !== 7 && c[3] !== 8 && c[3] !== 9 && c[3] !== 10 && c[3] !== 11 && c[3] !== 12 && c[3] !== 13 && c[3] !== 14 && c[3] !== 15 && c[3] !== 16 && c[3] !== 17 && c[3] !== 18 && c[3] !== 19 && c[3] !== 20 && c[3] !== 21 && c[3] !== 22 && c[3] !== 23 && c[3] !== 24 && c[3] !== 25 && c[3] !== 26 && c[3] !== 27)) throw new Error('不是有效的 UCZ 容器')
  const st = { p: c[3] >= 19 ? 6 : c[3] >= 17 ? 5 : 4 }, n = getVar(c, st), cnt = getVar(c, st)
  // v24 appends a 4-byte CRC-32C of the decompressed payload; everything below
  // reads up to `bodyEnd` and the trailer is verified once the output exists.
  const tail = containerHasChecksum(c[3]) ? 4 : 0
  const bodyEnd = c.length - tail
  if (tail && c.length < tail + 6) throw new Error('容器被截断（缺少校验尾部）')
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(cnt) || cnt > n) throw new Error('无效的容器长度')
  // The output size comes from the (untrusted) header; refuse to allocate a
  // buffer larger than the caller allows before touching any payload bytes.
  if (!Number.isSafeInteger(maxOutput) || maxOutput < 0) throw new Error('无效的解压上限')
  if (n > maxOutput) throw new Error(`解压后长度 ${n} 超过上限 ${maxOutput} 字节`)
  // Validation first, allocation second: the v1 body validates each record
  // against the header as it goes, the v2+ body validates the whole group table
  // (specs, strides, bitmap, segment lengths) before a single output byte is
  // allocated.
  if (c[3] === 1) {
    // Two passes: a descriptor is at least 2 bytes, so a header promising more
    // records than there is room for is rejected before anything is allocated.
    if (cnt > bodyEnd - st.p) throw new Error('容器数据被截断')
    const ids: number[] = [], ss: number[] = [], rs: number[] = [], raws: number[] = [], pls: number[] = [], offs: number[] = []
    let total = 0
    for (let k = 0; k < cnt; k++) {
      if (st.p >= bodyEnd) throw new Error('容器数据被截断')
      const id = c[st.p++]
      if (id > ID.D16) throw new Error('旧容器包含未知编码器')
      let s = 1, r = 1
      if (id >= ID.DELTA) { s = getVar(c, st); r = getVar(c, st) }
      const rawLen = getVar(c, st), pl = getVar(c, st)
      if (rawLen > n - total || pl > bodyEnd - st.p) throw new Error('容器长度越界')
      // P7-0：旧 v1 容器的 STORE 段必须原样拷贝——载荷长度与声明长度不符就是被
      // 截短/拼接过的数据，直接拒绝，别让 decodeSpec 悄悄补零。
      if (id === ID.STORE && pl !== rawLen) throw new Error('corrupt v1 store payload')
      ids.push(id); ss.push(s); rs.push(r); raws.push(rawLen); pls.push(pl); offs.push(st.p)
      total += rawLen
      st.p += pl
    }
    if (total !== n || st.p !== bodyEnd) throw new Error('长度校验失败')
    const out = new Uint8Array(n)
    let w = 0
    for (let k = 0; k < ids.length; k++) {
      const off = offs[k]
      out.set(decodeSpec(c.subarray(off, off + pls[k]), raws[k], { id: ids[k], s: ss[k], r: rs[k] }), w)
      w += raws[k]
    }
    if (tail) verifyCrc(c, bodyEnd, out)
    return out
  }
  const count = getVar(c, st)
  if (count > cnt || (cnt > 0 && count === 0)) throw new Error('无效的规则数量')
  const specs: Spec[] = [], payloadLens: number[] = [], seen = new Set<string>()
  // v15 容器里，分组的 r 最高位是"该组用 APM 校准内核"的标记（见 planHeader）。
  // 先取出标记再把 r 还原，后续所有校验与解码都按还原后的 r 进行。
  const g15: boolean[] = []
  const g20: boolean[] = []
  const gWp: boolean[] = []
  const gContext: (CMContext|undefined)[] = []
  const gMatchDist: boolean[] = []
  for (let i = 0; i < count; i++) {
    const id = getVar(c, st), s = getVar(c, st), rRaw = getVar(c, st), pl = getVar(c, st)
    const v15 = c[3] >= 15 && (rRaw & 0x8000) !== 0
    // 次高位：该组载荷被 WORD-PRE 封装过（P4-2，独立于 v15 标记）。
    const wp = c[3] >= 15 && (rRaw & 0x4000) !== 0
    const contextCode=(rRaw & GROUP_CONTEXT_MASK) >>> GROUP_CONTEXT_SHIFT
    if(contextCode && c[3]!==21 && c[3]!==22 && c[3]!==23 && c[3]!==24 && c[3]!==25 && c[3]!==26 && c[3]!==27)throw Error('旧容器包含 v21 组标记')
    const matchDist = !!(rRaw & GROUP_MATCH_DIST_BIT)
    // v22 owns bit 20; P17.7 adds the extended-context namespace bit at 21. Every
    // earlier version (and every pre-P17.7 v22 stream) has bit 21 clear, so the
    // rejection stays exact for containers that could not have set it.
    const contextExt = !!(rRaw & GROUP_CONTEXT_EXT_BIT)
    if(contextExt && c[3]<21)throw Error('旧容器包含 v21 扩展上下文标记')
    // v22 owns bit 20; every earlier version must reject it rather than silently
    // reinterpret the group's r as a larger value. Bit 21 is the P17.7 extended
    // context namespace, so it is legal from v21 on (and rejected below v21).
    if(c[3]===21 && (rRaw>0x3fffff || (rRaw&GROUP_MATCH_DIST_BIT)!==0 || ((rRaw&0x10000)!==0 && !v15)))throw Error('未知组标志位或缺少 APM 内核')
    if(matchDist && c[3]!==22 && c[3]!==23 && c[3]!==24 && c[3]!==25 && c[3]!==26 && c[3]!==27)throw Error('旧容器包含 v22 组匹配模型标记')
    if(c[3]>=22 && rRaw>0x3fffff)throw Error('未知组标志位')
    const context=contextFromGroupBits(rRaw)
    const r = v15 || wp || context || matchDist ? rRaw & 0x3fff : rRaw
    const cm20=c[3]>=20 && v15 && !!(rRaw&0x10000)
    if(cm20 && !((c[4]|c[5]<<8)&V20_FLAG_CM))throw Error('v20 分组缺少 CM 标志')
    if(context && (!cm20 || !contextSpecAllowed(context,{id,s,r},wp)))throw Error('v21 组标记与规则不兼容')
    // `<<` binds tighter than `|`, but write the mask explicitly: the previous form
    // silently tested the wrong bits and rejected every valid v22 group.
    // WORD-PRE is compatible: it unwraps to the same `text` CM, which receives the
    // option (see decodeTerrainGroupWordPre). Only the v20 kernel and the resolved
    // CM profile constrain this bit.
    if(matchDist && (!cm20 || !((c[4]|(c[5]<<8))&V22_FLAG_MATCH_DISTANCE) || !matchDistProfileAllowed(id,context)))
      throw Error('v22 组匹配模型标记与规则不兼容')
    if((id===ID.REC2||id===ID.BITPLANE) && ((c[3]!==21 && c[3]!==23 && c[3]!==24 && c[3]!==25) || !cm20 || wp || context || !((c[4]|c[5]<<8)&V20_FLAG_TRANSFORMS) || s!==1 || (id===ID.REC2 ? r!==1 : (r!==BITPLANE_BYTE_CM && r!==BITPLANE_BIT_CM && r!==BITPLANE_PERIOD_CM))))throw Error('无效 REC2 组标记')
    gContext.push(context)
    gMatchDist.push(matchDist)
    g20.push(cm20)
    g15.push(v15)
    gWp.push(wp)
    const key = `${id},${s},${r}`
    if (id > (c[3] >= 21 ? ID.BITPLANE : c[3] >= 14 ? ID.WIDE_GRAD : c[3] >= 13 ? ID.TRANSPOSE_GROUP_V3 : c[3] >= 12 ? ID.TRANSPOSE_2D : c[3] >= 11 ? ID.MICRO : c[3] >= 10 ? ID.SUB_ANCHOR : c[3] >= 9 ? ID.PEEL : c[3] >= 8 ? ID.ANCHOR_FOLD : c[3] >= 7 ? ID.ANCHOR : c[3] >= 6 ? ID.BCJ : c[3] >= 5 ? ID.TRANSPOSE_GROUP : c[3] >= 4 ? ID.TRANSPOSE : ID.D16) || (id === ID.ANCHOR_FOLD || id === ID.SUB_ANCHOR || id === ID.SUB_ANCHOR_V3 ? s > 255 : s < 1) || r < 1 || ((id === ID.TRANSPOSE || id === ID.TRANSPOSE_GROUP || id === ID.TRANSPOSE_2D || id === ID.TRANSPOSE_GROUP_V3 || id === ID.PEEL) && (s < 2 || s > 64 || r !== 1)) || ((id === ID.BCJ || id === ID.BCJ_V2 || id === ID.TEXT_V2 || id === ID.BIN_V2 || id === ID.TEXT_V3 || id === ID.BIN_V3) && (s !== 1 || r !== 1)) || (id === ID.BCJ_V3 && (r!==1 || (s!==1 && !(s===2 && transformsV20Enabled())))) || (id === ID.ANCHOR && (s > 256 || r !== 1)) || ((id === ID.ANCHOR_FOLD || id === ID.SUB_ANCHOR || id === ID.SUB_ANCHOR_V3) && (r > 255 || !((r & 127) >= 32 || (r & 127) === 9 || ((r & 127) >= 2 && (r & 127) <= 24)))) || ((id === ID.SUB_TRANSPOSE || id === ID.SUB_TRANSPOSE_V3) && (s<2 || s>64 || (r!==1 && r!==2))) || ((id === ID.SUB_ANCHOR || id === ID.SUB_ANCHOR_V3) && ((r&127)>=32 || (r&127)===9) && s===(r&127)) || (id === ID.WIDE_GRAD && ((s<1 || s>(transformsV20Enabled()?8:2)) || r<256 || r>8192 || r%2!==0)) || (id === ID.MICRO && (s>16 || r>4096)) || seen.has(key)) throw new Error('无效的规则字典')
    seen.add(key); specs.push({ id, s, r }); payloadLens.push(pl)
  }
  if(c[3]===21 && !gContext.some(Boolean) && !specs.some(s=>s.id===ID.REC2||s.id===ID.BITPLANE))throw Error('v21 容器没有上下文组或 REC2')
  const lengths: number[] = [], offsets: number[] = []
  let total = 0
  for (let i = 0; i < cnt; i++) {
    const len = getVar(c, st)
    if (!len || len > n - total) throw new Error('无效的区域长度')
    offsets.push(total); lengths.push(len); total += len
  }
  if (total !== n) throw new Error('长度校验失败')
  let pending = lengths.map((_, i) => i), bit = 0
  const members: number[][] = Array.from({ length: count }, () => [])
  for (let gi = 0; gi + 1 < count; gi++) {
    const next: number[] = []
    for (const i of pending) {
      const pos = st.p + Math.floor(bit / 8)
      if (pos >= c.length) throw new Error('位图被截断')
      if ((c[pos] >>> (bit % 8)) & 1) members[gi].push(i)
      else next.push(i)
      bit++
    }
    if (!members[gi].length) throw new Error('空规则')
    pending = next
  }
  if (count) { if (!pending.length) throw new Error('空规则'); members[count - 1] = pending }
  st.p += Math.ceil(bit / 8)
  const out = new Uint8Array(n)
  let completed = 0
  for (let gi = 0; gi < count; gi++) {
    const pl = payloadLens[gi]
    if (!Number.isSafeInteger(pl) || pl > c.length - st.p) throw new Error('容器数据被截断')
    const payload = c.subarray(st.p, st.p + pl); st.p += pl
    const indices = members[gi]
    if (specs[gi].id === ID.FILL) {
      if (pl !== indices.length) throw new Error('填充值长度错误')
      indices.forEach((i, j) => out.fill(payload[j], offsets[i], offsets[i] + lengths[i]))
    } else {
      const size = indices.reduce((sum, i) => sum + lengths[i], 0)
      if (specs[gi].id === ID.STORE && pl !== size) throw new Error('原样数据长度错误')
      // v2 对整个拼接原文统一逆变换；v3 按各区域独立逆变换。
      if (c[3] === 2) {
        const decoded = decodeSpec(payload, size, specs[gi])
        let pos = 0
        for (const i of indices) { out.set(decoded.subarray(pos, pos + lengths[i]), offsets[i]); pos += lengths[i] }
      } else {
        const parts = decodeTerrainGroup(payload, indices.map(i => lengths[i]), specs[gi],
          done => onProgress?.(completed + done, n), indices.map(i => offsets[i]), g20[gi] ? 'v20' : g15[gi] ? 'v15' : false, gWp[gi], {context:gContext[gi], matchDist:gMatchDist[gi] || undefined})
        indices.forEach((i, j) => out.set(parts[j], offsets[i]))
      }
    }
    completed += indices.reduce((sum, i) => sum + lengths[i], 0)
    onProgress?.(completed, n)
  }
  if (st.p !== bodyEnd) throw new Error('容器尾部存在多余数据')
  if (tail) verifyCrc(c, bodyEnd, out)
  return out
}

function verifyCrc(c: Uint8Array, bodyEnd: number, out: Uint8Array): void {
  if (readCrcTrailer(c, bodyEnd) !== crc32c(out)) throw new Error('容器内容校验失败（CRC-32C 不匹配）')
}

// ---------- 对照基线 ----------
export async function streamSize(data: Uint8Array, fmt: 'gzip' | 'deflate'): Promise<number | null> {
  try {
    if (typeof CompressionStream === 'undefined') return null
    const cs = new CompressionStream(fmt)
    const writer = cs.writable.getWriter()
    void writer.write(data as unknown as BufferSource)
    void writer.close()
    const reader = cs.readable.getReader()
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
    }
    return total
  } catch {
    return null
  }
}

export function singleModelSize(data: Uint8Array, limit = MAX_SINGLE_CM_BYTES, onProgress?: (done: number, total: number) => void): number | null {
  if (data.length > limit) return null
  return encodeCM(data, 'bin', 1, 1, undefined, 0, undefined, onProgress).length + 8
}

export { BLOCK }

// P14.1 runs only AFTER the exact P13.1 container has won all existing guards.
// Keying by container survives result-object copies used by those guards.
const retainedContextGroups = new WeakMap<Uint8Array, PlanGroup[]>()
/** Full-fidelity plan for the exact container that won, so later stages can
 * rebuild a header without guessing group contexts. Keyed by the same container
 * object identity as `retainedContextGroups`. */
const retainedPlanGroups = new WeakMap<Uint8Array, PlanGroup[]>()
export interface ContextPayload { payload: Uint8Array; flags: number }
export interface ContextCandidates {
  spec: Spec; rawBytes: number; wordPre: boolean
  control: ContextPayload | null
  trials: (ContextPayload & { context: CMContext; matchDist?: boolean })[]
  controlReused: boolean
  fullCandidateInputBytes: number
  screen?: { rawBytes: number; controlBytes: number; trials: {context:CMContext;bytes:number;matchDist?:boolean}[]; selected:CMContext[]; matchDist?:boolean }
  admission?: KernelScreen['wordPreGate']
  skipped?: string
  error?: string
}
export interface ContextGroupComparison {
  group: number; spec: Spec; baselineSpec: Spec; proposal: ContextProposal['reason']; members: number[]; rawBytes: number; baselinePayloadBytes: number
  controlPayloadBytes?: number; controlReused?: boolean; fullCandidateInputBytes?: number
  screen?: ContextCandidates['screen']; admission?: ContextCandidates['admission']; skipped?: string; error?: string
  trials: {context:CMContext;matchDist?:boolean;payloadBytes:number;containerBytes:number;controlContainerBytes:number;accepted:boolean}[]
  selected?: CMContext
  selectedMatchDist?: boolean
}
export interface ContextComparison {
  baselineBytes: number; candidateBytes: number; accepted: boolean
  /** True when the wall-clock budget stopped the tournament early. */
  budgetTruncated?: boolean
  workerJobs: number; workerFallbacks: number; groups: ContextGroupComparison[]; error?: string
  legacyUpgrades?: {group:number;spec:Spec;sampleBase?:number;sampleV20?:number;oldPayload:number;newPayload?:number;oldContainer:number;newContainer?:number;accepted:boolean;skipped?:string;error?:string}[]
}

export interface ContextProposal {
  spec: Spec
  reason: 'selected-xform' | 'selected-bin' | 'selected-wide' | 'selected-text' | 'existing-16bit-row-geometry' | 'existing-text-v3-trial' | 'selected-raw-text'
  rawText?: boolean
}

/** Reopen only an already evidenced P2/P3 alternative, without changing the
 * old chooser or its thresholds. A winner-only pass misses short GRAD3/s2 rows
 * (the old WIDE search starts at 256 KiB) and text where an anchor trial won
 * before WORD-PRE was priced. The old spec is NOT relabelled: each proposal
 * encodes both a complete standard-v20 control and its new context from raw
 * members, then must beat that control AND the retained actual old container.
 * No BCJ/transformed-bin contexts, new row detection, or forced corpus rules. */
export function contextProposalsForGroup(spec:Spec,
  members:readonly Pick<SegResult,'rawLen'|'cls'|'trials'>[]):ContextProposal[] {
  const rawBytes=members.reduce((n,s)=>n+s.rawLen,0)
  if(rawBytes<CONTEXT_MIN_BYTES)return []
  // P17.5: BCJ3 filters split E8/E9 operands across non-4-byte-aligned stream
  // positions, so its stride-4 context is a measured regression (ooffice).
  // Keep the transform-aware direct API intact, but never propose it here.
  if(spec.id===ID.BCJ_V3)return []
  if(contextSpecAllowed('xform-bin',spec))return [{spec:{...spec},reason:'selected-xform'}]
  if(contextSpecAllowed('bin-stride4',spec))return [{spec:{...spec},reason:'selected-bin'}]
  if(contextSpecAllowed('wide-geom',spec))return [{spec:{...spec},reason:'selected-wide'}]
  if(spec.id===ID.TEXT_V3)return [{spec:{...spec},reason:'selected-text'}]
  // Above the old 256 KiB WIDE-search threshold, leave the existing wider
  // chooser to supply WIDE specs. Do not spend three full large alternatives.
  if(rawBytes<CONTEXT_SCREEN_MIN_BYTES && spec.id===ID.GRAD_V3 && spec.s===2 && members.every(s=>s.rawLen%2===0)) {
    return [6,7,8].map(s=>({id:ID.WIDE_GRAD,s,r:spec.r}))
      .filter(sp=>contextSpecAllowed('wide-geom',sp)).map(sp=>({spec:sp,reason:'existing-16bit-row-geometry'}))
  }
  const lexical=([ID.TEXT,ID.TEXT_V2,ID.ANCHOR,ID.ANCHOR_FOLD,ID.SUB_ANCHOR,ID.SUB_ANCHOR_V3] as number[]).includes(spec.id)
  if(lexical && rawBytes>=32768 && members.every(s=>s.cls==='text' && s.trials.some(t=>t.spec.id===ID.TEXT_V3))) {
    return [{spec:{id:ID.TEXT_V3,s:1,r:1},reason:'existing-text-v3-trial'}]
  }
  return []
}

/** A job computes controls/candidates, never chooses a container. */
export function contextGroupCandidatesSync(parts:Uint8Array[],spec:Spec,positions:number[],
  retained?:{payload:Uint8Array;flags:number;wordPre:boolean;context?:CMContext},screen=true,rawText=false,lateMatchDist=true):ContextCandidates {
  const rawBytes=parts.reduce((n,p)=>n+p.length,0),wordPre=ENABLE_WORDPRE && !rawText && spec.id===ID.TEXT_V3
  const result:ContextCandidates={spec:{...spec},rawBytes,wordPre,control:null,trials:[],controlReused:false,fullCandidateInputBytes:0}
  try {
    // P17.5: see contextProposalsForGroup. Screening BCJ3 here spends a full
    // candidate encode on a context that cannot align with its filtered bytes.
    if(spec.id===ID.BCJ_V3){result.skipped='bcj3-context-disabled';return result}
    // Prior registry §2/§3: every `text-*` layout keys on ASCII character classes
    // and delimiter bytes, and `wp-*` keys on whitespace tokenisation. The strict
    // profile offers no context layout at all, so such a group falls back to its
    // generic byte model.
    let modes:CMContext[]=strictPriorsOn()?[]:rawText && contextSpecAllowed('text-linecol',spec)?['text-linecol','text-lexcol','text-tabcol','wp-token3']
      :rawText?[]:contextSpecAllowed('xform-bin',spec)?['xform-bin','xform-bin-stride4']:contextSpecAllowed('bin-stride4',spec)?['bin-stride4']
      :contextSpecAllowed('wide-geom',spec)?['wide-geom']:wordPre?['wp-token3','wp-merge']:[]
    // P24: the vertical-predictor layout (`text-vertcol`) is the same nine-context
    // `text` model plus two gated column inputs, so it is legal exactly where the
    // other column layouts are. It is offered only for groups large enough to pay
    // for its 192 KiB sample trial; below that the probe cannot resolve it.
    if(modes.length&&rawText&&rawBytes>=CONTEXT_SCREEN_MIN_BYTES&&contextSpecAllowed('text-vertcol',spec)) modes.push('text-vertcol')
    if(modes.length&&rawText&&rawBytes>=CONTEXT_MIN_BYTES){
      // P18.0: universal low-cardinality symbol screening. K comes from the data.
      let k=0
      const seen=new Uint8Array(256),bufAll=joinContextBin(parts)
      for(let i=0;i<bufAll.length;i++)if(!seen[bufAll[i]]){seen[bufAll[i]]=1;k++}
      if(k<=4)modes.push('sym-2bit')
      else if(k<=32){modes.push('sym-5bit','sym-5bit-gap')}
    }
    if(!modes.length||rawBytes<CONTEXT_MIN_BYTES){result.skipped='ineligible-or-small';return result}
    let pre:WordPreResult|null=null,joined:Uint8Array|undefined
    if(wordPre) {
      joined=joinForSpec(parts,spec,positions)!.data
      pre=rawBytes>=32768?wordPreFwdSampled(joined,256*1024):null
      const gate=screenWordPreCandidates(joined,pre,['v20'],[0])
      result.admission=gate.wordPreGate
      if(!gate.selected.length){result.skipped='P13.1-wordpre-admission';return result}
    }
    // v22 eligibility is decided from the CM profile the group will run, never from
    // the file name or its size: text/bin models can host the distance-split match
    // table, residual rows cannot (see matchDistProfileAllowed).
    // WORD-PRE wraps the text token stream and then runs the same `text` CM, so
    // matchDist rides along through CMOptions exactly as context does. Keying
    // eligibility on `!wordPre` would have silently excluded every TEXT_V2/V3 group,
    // which is the whole text channel.
    // Only the late context-refinement stage may spend a matchDist trial. Planning-time
    // probes (chooseSpec, group kernels, macro screening) must see exactly the same
    // model as before, or the plan they produce stops being comparable to the frozen
    // measurements (measured: xml's plan changed from one TEXT_V3 group to
    // SUB_ANCHOR/GRAD segments and the container grew 4542 -> 6274).
    const matchDistEligible=lateMatchDist && cmV22Tuning.matchDist && matchDistProfileAllowed(spec.id,modes[0])
    const encode=(ps:Uint8Array[],pos:number[],context?:CMContext,wp=pre,md=false):Uint8Array=>{
      const opt=md?{context,matchDist:true}:{context}
      if(wordPre)return encodeWordPrePayload(wp!,ps.reduce((n,p)=>n+p.length,0),'v20',opt)
      if(rawText)return withCMBlockSize(ps.reduce((n,p)=>n+p.length,0),()=>encodeCM(joinContextBin(ps),'text',1,1,undefined,0,undefined,undefined,'v20',0,context==='wp-token3',opt))
      if(contextSpecAllowed('bin-stride4',spec) && spec.id!==ID.TRANSPOSE_GROUP_V3) {
        // The historical single-part BIN19 wrapper ignores kernel. Do not alter
        // that old path: this new-stage control must explicitly encode real v20.
        return withCMBlockSize(ps.reduce((n,p)=>n+p.length,0),()=>encodeCM(joinContextBin(ps),'bin',1,1,
          undefined,0,undefined,undefined,'v20',0,false,opt))
      }
      if(spec.id===ID.WIDE_GRAD && !context) {
        // New-stage control tracks BOTH planes. Historical wrappers stay intact.
        return markV20Transform(withCMBlockSize(ps.reduce((n,p)=>n+p.length,0),()=>withRowA2Off(spec,
          ()=>encodeWide16(ps,spec,undefined,undefined,undefined,'v20',undefined,true))))
      }
      return encodeTerrainGroup(ps,spec,undefined,undefined,undefined,pos,'v20',opt)
    }
    const price=(p:Uint8Array,n:number,context?:CMContext,md=false)=>p.length+selectionHeaderBytes(spec,n,p.length,
      // A v22 payload always also declares the v21 namespace when a context is used.
      md && context?payloadModelFlags(p)|V21_FLAG_CONTEXTS:payloadModelFlags(p),true,wordPre,context,md)
    // v22 bounded probe for groups below the 256 KiB screening threshold. Without
    // it those groups never evaluate matchDist at all and the mechanism would be
    // limited to large files, which is not a property of the data. The budget is a
    // quarter of the group, so the probe cost stays a small fraction of the one full
    // encode that follows.
    if(screen && matchDistEligible && rawBytes<CONTEXT_SCREEN_MIN_BYTES && rawBytes>=CONTEXT_MIN_BYTES) {
      const lvlB=pruningLevel()
      const budget=Math.max(CONTEXT_MIN_BYTES,Math.min(rawBytes,Math.floor(rawBytes/4),lvlB===2?16384:lvlB===1?32768:Number.MAX_SAFE_INTEGER))
      const sample=groupKernelSample(parts,positions,spec.id===ID.WIDE_GRAD?spec.r:4,budget)
      if(sample.bytes>=CONTEXT_MIN_BYTES) {
        const baseBytes=price(withCMProbe(()=>encode(sample.parts,sample.positions,undefined,pre)),sample.bytes)
        const mdBytes=price(withCMProbe(()=>encode(sample.parts,sample.positions,undefined,pre,true)),sample.bytes)
        result.screen={rawBytes:sample.bytes,controlBytes:baseBytes,trials:[{context:undefined as unknown as CMContext,bytes:mdBytes,matchDist:true}],selected:[],matchDist:mdBytes<baseBytes}
        // A losing matchDist probe decides the DISTANCE axis only. Returning here
        // used to abandon the whole group, so the orthogonal context axis was never
        // priced: sao-mid (id 30, s=28) lost its `bin-stride4` trial to a matchDist
        // probe that failed by 9 bytes on a 64 KiB sample, and the group was reported
        // `probe-not-better` with no trials at all. Only the distance axis is settled
        // here; context still has to be screened below.
        // P17.5: never overwrite `modes` here. The bounded probe decides only
        // the orthogonal distance axis; context still has to be tested below.
        if(!result.screen.matchDist)result.screen.selected=[]
      }
    }
    if(screen && rawBytes>=CONTEXT_SCREEN_MIN_BYTES) {
      const sample=wordPre?{parts:[joined!.subarray(0,CONTEXT_PROBE_BYTES)],positions:[0],bytes:CONTEXT_PROBE_BYTES}
        :groupKernelSample(parts,positions,spec.id===ID.WIDE_GRAD?spec.r:4,CONTEXT_PROBE_BYTES)
      const prefix=wordPre?collapseWithDict(sample.parts[0],pre!.dict):null
      const samplePre=wordPre?{...pre!,body:prefix!}:null
      if(sample.bytes<CONTEXT_MIN_BYTES || (wordPre&&!prefix)){result.skipped='insufficient-probe';return result}
      // Only identical H0..H7 topologies can share; TG3 and WIDE remain independent.
      const dualMode: 'bin-stride4'|'wp-token3'|'text-sparse5'|undefined = wordPre ? 'wp-token3'
        : rawText ? 'text-sparse5' : spec.id!==ID.TRANSPOSE_GROUP_V3 && modes[0]==='bin-stride4' ? 'bin-stride4' : undefined
      let shared: {base:Uint8Array;alt:Uint8Array}|undefined
      if(dualMode && modes.includes(dualMode)) {
        const body=wordPre ? (()=>{const x=new Uint8Array(samplePre!.header.length+samplePre!.body.length);x.set(samplePre!.header);x.set(samplePre!.body,samplePre!.header.length);return x})() : joinContextBin(sample.parts)
        shared=withCMProbe(()=>withCMBlockSize(sample.bytes,()=>encodeCMContextDual(body,dualMode)))
        if(wordPre) {
          const wrap=(cm:Uint8Array)=>{const p=new Uint8Array(cm.length+4),n=body.length;p[0]=n&255;p[1]=(n>>>8)&255;p[2]=(n>>>16)&255;p[3]=(n>>>24)&255;p.set(cm,4);return inheritPayloadModel(p,cm)}
          shared={base:wrap(shared.base),alt:wrap(shared.alt)}
        }
      }
      const controlBytes=price(shared?.base ?? withCMProbe(()=>encode(sample.parts,sample.positions,undefined,samplePre)),sample.bytes)
      const trials=modes.map(context=>({context,bytes:price(shared && context===dualMode ? shared.alt : withCMProbe(()=>encode(sample.parts,sample.positions,context,samplePre)),sample.bytes,context)}))
      // A >=0.15% sample win spends one full extra encode. Never drop the old
      // complete candidate on the strength of a sample. WP alternatives do not add.
      const positive=trials.filter(t=>rawText ? t.bytes<controlBytes : t.bytes<controlBytes*(1-0.0015)).sort((a,b)=>a.bytes-b.bytes)
      let pick=positive.length?{context:positive[0].context,matchDist:false,bytes:positive[0].bytes}:undefined
      // v22: price the distance-split match model ON THE SAME SAMPLE, for the
      // contexts that already passed. It is orthogonal to `context`, so this is a
      // second axis, not another context mode: at most one of the two axes wins.
      if(matchDistEligible){
        // matchDist is an ORTHOGONAL axis: it is priced on top of the context that
        // already won, and on top of the plain control. Replacing the winning
        // context with matchDist would throw away the context gain (measured: xml
        // lost wp-merge and jumped 4542 -> 6274).
        const mdCandidates: {context:CMContext;matchDist:boolean}[]=[]
        mdCandidates.push({context:undefined as unknown as CMContext,matchDist:true})
        if(pick && pick.context!==undefined) mdCandidates.push({context:pick.context,matchDist:true})
        let best: {context:CMContext;matchDist:boolean;bytes:number}|undefined
        const mdTrials: {context:CMContext;bytes:number;matchDist?:boolean}[]=[]
        for(const cand of mdCandidates){
          try{
            const bytes=price(withCMProbe(()=>encode(sample.parts,sample.positions,cand.context,samplePre,true)),sample.bytes)
            mdTrials.push({context:cand.context,bytes,matchDist:true})
            if(!best||bytes<best.bytes)best={...cand,bytes}
          }catch{ /* ineligible; keep the non-matchDist path */ }
        }
        // Recorded after the screen object exists: pushing into it here would be a
        // silent no-op and would hide the measurement entirely.
        trials.push(...mdTrials)
        // The matchDist axis uses a strict `<` bar rather than the context axis'
        // 0.15%: the two axes are not competing for the same full encode — the
        // sample only decides WHICH configuration to encode once. Adoption is still
        // decided by the complete-container gate (P_new<P_old && C_new<C_old), so a
        // weak sample signal can cost one encode attempt but can never cost bytes.
        if(best && best.bytes<controlBytes && (!pick || best.bytes<pick.bytes)) pick=best
      }
      modes=pick?[pick.context]:[]
      // P17.7: a bounded sample can rank two contexts inside noise. On raw text the
      // runner-up is therefore also priced on the FULL group whenever it is within
      // 0.5% of the sample winner (AITDCC/B: linecol won the 192 KiB sample by 0.1%
      // and lost 142 B on the 1.1 MiB group). The complete-container gate still
      // decides adoption, so the extra encode can only ever remove bytes.
      // P17.8: the close-contender promotion is generalised to the top three
      // distinct contexts within 0.5% of the sample winner (not just the runner-up).
      // A bounded sample can rank contexts inside noise; the complete-container gate
      // still decides adoption, so an extra full encode can only ever remove bytes.
      // P17.9: on raw text the sample screen runs at the probe table tier, which can
      // misrank the high-order lexical/tabular layouts by ~1 KiB, so the threshold
      // widens to 0.8% and up to four distinct contexts are priced on the full group.
      // Every promotion is still gated by the complete-container comparison.
      if(pick) {
        // P24: with five raw-text candidates the pool grows by one so the previous
        // winner is always still priced on the full group; the complete-container
        // gate, not the pool size, decides adoption.
        // P30.0：非 max 档位只把样本榜前 2（balanced）/ 前 1（fast）名送进整组编码。
        // 采纳仍由完整容器比对决定，所以这里只可能少花钱，不可能选进更差的规则。
        const baseCap=rawText&&modes.includes('text-vertcol')?5:4
        const lvl=pruningLevel()
        // P30.1：整组 ≥256 KiB 时进一次 `probeDepth=0` 全组编码就是几秒到十几秒，
        // 所以 `balanced` 也只在样本榜第一名上花钱（`fast` 同样只选 1 个）。
        const promoteCap=lvl===2?1:lvl===1?(rawBytes>=262144?1:Math.min(2,baseCap)):baseCap
        for(const t of positive) {
          if(modes.length>=promoteCap) break
          if(t.bytes<=pick.bytes*1.008 && !modes.includes(t.context)) modes.push(t.context)
        }
      }
      result.screen={rawBytes:sample.bytes,controlBytes,trials,selected:[...modes],matchDist:!!pick?.matchDist}
      if(!pick){result.skipped='probe-not-better';return result}
    }
    const canReuse=retained && retained.wordPre===wordPre && (retained.flags&V20_FLAG_CM) && !(retained.flags&V21_FLAG_CONTEXTS)
    let fullDual: {base:Uint8Array;alt:Uint8Array}|undefined
    const fullMode=modes.length===1 ? modes[0] : undefined
    if(!canReuse && (fullMode==='text-sparse5' || (fullMode==='wp-token3' && wordPre) || (fullMode==='bin-stride4' && spec.id!==ID.TRANSPOSE_GROUP_V3))) {
      const body=wordPre ? (()=>{const x=new Uint8Array(pre!.header.length+pre!.body.length);x.set(pre!.header);x.set(pre!.body,pre!.header.length);return x})() : joinContextBin(parts)
      fullDual=withCMBlockSize(rawBytes,()=>encodeCMContextDual(body,fullMode))
      if(wordPre) {
        const wrap=(cm:Uint8Array)=>{const p=new Uint8Array(cm.length+4),n=body.length;p[0]=n&255;p[1]=(n>>>8)&255;p[2]=(n>>>16)&255;p[3]=(n>>>24)&255;p.set(cm,4);return inheritPayloadModel(p,cm)}
        fullDual={base:wrap(fullDual.base),alt:wrap(fullDual.alt)}
      }
    }
    if(canReuse) {
      result.control={payload:retained.payload,flags:retained.flags};result.controlReused=true
    } else {
      const payload=fullDual?.base ?? encode(parts,positions)
      result.control={payload,flags:payloadModelFlags(payload)}
    }
    // Exactly one full-group encode per axis winner. For groups below the
    // 256 KiB screening threshold the bounded probe settles only the distance
    // axis, so price BOTH axes: every context (including its dual arm) and the
    // base `undefined + matchDist` candidate. The complete-container gate in
    // refineContextCandidates still decides adoption; this only ensures the
    // candidates exist.
    const md=!!result.screen?.matchDist
    // P37.12 (R5): the retained group *is* one of the candidate configurations. Re-encoding
    // it produces the same bytes by construction, so reuse the payload instead of paying for
    // a full-group encode — the tournament then simply finds no strict improvement.
    const reuseFor=(context:CMContext|undefined,mdAxis:boolean):Uint8Array|undefined=>{
      if(!retained || retained.wordPre!==wordPre) return undefined
      if((retained.context ?? undefined)!==context) return undefined
      if(!!(retained.flags & V22_FLAG_MATCH_DISTANCE)!==mdAxis) return undefined
      return retained.payload
    }
    const pushTrial=(context:CMContext,payload:Uint8Array,mdAxis=false)=>{
      // A payload that did not actually take the v22 model must not be labelled as
      // if it had: the decoder would build a different model and diverge.
      const actuallyMd = mdAxis && !!(payloadModelFlags(payload) & V22_FLAG_MATCH_DISTANCE)
      result.trials.push({context,matchDist:actuallyMd||undefined,payload,flags:payloadModelFlags(payload)})
      result.fullCandidateInputBytes+=rawBytes
    }
    if(md && rawBytes<CONTEXT_SCREEN_MIN_BYTES) {
      pushTrial(undefined as unknown as CMContext,encode(parts,positions,undefined,pre,true),true)
      for(const context of modes) {
        const owned=reuseFor(context,false)
        const plain=owned ?? (fullDual && context===fullMode ? fullDual.alt : encode(parts,positions,context,pre,false))
        pushTrial(context,plain,false)
        const ownedMd=reuseFor(context,true)
        pushTrial(context,ownedMd ?? encode(parts,positions,context,pre,true),true)
      }
    } else {
      for(const context of modes) {
        const owned=reuseFor(context,md)
        const payload=owned ?? (fullDual && context===fullMode && !md ? fullDual.alt : encode(parts,positions,context,pre,md))
        pushTrial(context,payload,md)
      }
    }
    return result
  } catch(error) {
    result.error=error instanceof Error?error.message:String(error)
    result.control=null;result.trials=[]
    return result
  }
}

/** P28.0: printable-ASCII table geometry, independent of any file name. */
export function asciiTableGroup(data:Uint8Array,segs:PlanSegment[],members:number[]):boolean {
  let total=0,printable=0,newlines=0
  for(const i of members){
    const s=segs[i]
    if(!s)return false
    const a=data.subarray(s.start,s.end)
    total+=a.length
    for(let k=0;k<a.length;k++){const b=a[k];if((b>=0x20&&b<=0x7e)||b===9||b===10||b===13)printable++;if(b===10)newlines++}
  }
  if(total<CONTEXT_SCREEN_MIN_BYTES||printable*100<total*99)return false
  const lines=newlines+1
  // A table has many short rows; prose has few long ones.
  return lines>=4 && total/lines<=512
}

/** Explicit-plan tests may call this, but are NOT adaptive chooser measurements.
 * Production calls it once, after compressAdaptiveImpl has finished. */
export async function refineContextCandidates(data:Uint8Array,baseline:Compressed,
  options:{serial?:boolean;runJobs?:GroupJobRunner}={},onStage?: (msg:string,pct:number)=>void):Promise<Compressed> {
  if(baseline.contextComparison)return baseline
  const comparison:ContextComparison={baselineBytes:baseline.container.length,candidateBytes:baseline.container.length,accepted:false,workerJobs:0,workerFallbacks:0,groups:[]}
  const finish=(chosen:Compressed)=>({...chosen,contextComparison:comparison})
  try {
    let retained=retainedContextGroups.get(baseline.container)
    if(!retained) {
      // P28.7: a rebuilt container (coalescing, macro adoption, worker assembly)
      // carries the same plan groups under the plan-group map. Deriving the
      // context map from it is exact, not a guess: same spec, same members, same
      // payload, same kernel. Without this fallback the whole tournament aborted.
      const fb=retainedPlanGroups.get(baseline.container)
      if(!fb)throw Error('缺少实际旧容器的分组载荷，拒绝猜测或替换')
      retained=fb.map(g => ({ spec: { ...g.spec }, members: [...g.members], payload: g.payload, v15: g.v15, wordPre: g.wordPre, context: g.context }))
      retainedContextGroups.set(baseline.container, retained)
    }
    const groups=retained.map(g=>({...g,spec:{...g.spec},members:[...g.members]})),segs=baseline.segs
    const eligible=groups.flatMap((g,group)=>[...contextProposalsForGroup(g.spec,g.members.map(i=>segs[i])),
      ...(!g.wordPre && contextSpecAllowed('text-sparse5',g.spec) && g.members.reduce((n,i)=>n+segs[i].rawLen,0)>=CONTEXT_MIN_BYTES
        ? [{spec:{...g.spec},reason:'selected-raw-text' as const,rawText:true}] : []),
      // P28.0: pure byte geometry, never a file name or a known header word. A
      // group that is (almost) entirely printable ASCII plus whitespace with
      // short newline-delimited rows is a text/CSV table regardless of which
      // byte profile the segmenter picked. Such groups (small tabular files) were locked into `bin`, so the column
      // layouts were never even screened. The proposal is purely additive: the
      // `bin` candidates stay in the tournament, so the container can only win.
      ...(!strictPriorsOn() && !g.wordPre && !contextSpecAllowed('text-sparse5',g.spec)
        && g.spec.id!==ID.ANCHOR && g.spec.id!==ID.ANCHOR_FOLD && g.spec.id!==ID.SUB_ANCHOR
        && asciiTableGroup(data,segs,g.members)
        ? [{spec:{id:ID.TEXT_V3,s:1,r:1},reason:'selected-text' as const,rawText:true}] : []),
      // P28.7: WORD-PRE rewrites the alphanumeric tokens of a numeric table into
      // dictionary ids, which destroys the column structure the layouts live on.
      // A group that is already word-preprocessed AND is a printable ASCII table
      // therefore also gets a raw-byte tournament (a numeric table holds 34,645 B of
      // a proven 31,525 B). The word-pre candidate stays in the race, so this is
      // purely additive.
      ...(!strictPriorsOn() && !!g.wordPre && g.spec.id!==ID.ANCHOR && g.spec.id!==ID.ANCHOR_FOLD && g.spec.id!==ID.SUB_ANCHOR
        && asciiTableGroup(data,segs,g.members)
        ? [{spec:{...g.spec},reason:'selected-raw-text' as const,rawText:true}] : [])]
      // Never steal another original stream's dictionary key, even if that
      // other group later accepts a context/transform of its own.
      .filter(p=>!groups.some((other,i)=>i!==group && sameSpec(other.spec,p.spec)))
      .map(proposal=>({g,group,proposal,rawBytes:g.members.reduce((n,i)=>n+segs[i].rawLen,0)})))
    const jobs:JobPayload[]=eligible.map(({g,proposal})=>({kind:'contextGroup',cmV20:{...cmV20Tuning},level:currentCompressionLevel(),strictPrior:strictPriorsOn(),spec:{...proposal.spec},
      parts:g.members.map(i=>[segs[i].start,segs[i].end] as [number,number]),positions:g.members.map(i=>segs[i].start),rawText:proposal.rawText,
      retained:sameSpec(g.spec,proposal.spec)?{payload:g.payload,flags:payloadModelFlags(g.payload),wordPre:!!g.wordPre}:undefined}))
    let replies:JobReply[]|null=null
    if(jobs.length && !options.serial && (options.runJobs||workerTuningMatchesDefaults()&&nodeParallelReady())) {
      try {
        replies=await (options.runJobs??runNodeJobs)(jobs,eligible.map(g=>g.rawBytes*3),data)
        if(replies && (replies.length!==jobs.length||replies.some(r=>r.kind!=='contextGroup')))throw Error('v21 worker 回复不完整')
        if(replies)comparison.workerJobs=jobs.length
      } catch {comparison.workerFallbacks++;replies=null}
    }
    let total=baseline.container.length
    for(let k=0;k<eligible.length;k++) {
      // The context tournament is the most expensive planner stage (one full encode
      // per candidate). Under a wall-clock budget we stop STARTING candidates;
      // everything already measured stays adoptable, so the result is still a plan.
      if(deadlineHit()){comparison.budgetTruncated=true;break}
      const {g,group,proposal,rawBytes}=eligible[k],job=jobs[k]
      if(job.kind!=='contextGroup')throw Error('v21 job type')
      onStage?.(`v21 上下文候选 ${k+1}/${eligible.length}（保留原容器）`,85+2*k/eligible.length)
      const reply=replies?.[k]
      const cand=reply?.kind==='contextGroup'?reply.candidates:contextGroupCandidatesSync(
        job.parts.map(([a,b])=>data.subarray(a,b)),job.spec,job.positions,job.retained,true,job.rawText)
      const row:ContextGroupComparison={group,spec:{...proposal.spec},baselineSpec:{...g.spec},proposal:proposal.reason,members:[...g.members],rawBytes,baselinePayloadBytes:g.payload.length,
        controlPayloadBytes:cand.control?.payload.length,controlReused:cand.controlReused,fullCandidateInputBytes:cand.fullCandidateInputBytes,
        screen:cand.screen,admission:cand.admission,skipped:cand.skipped,error:cand.error,trials:[]}
      comparison.groups.push(row)
      if(!sameSpec(cand.spec,proposal.spec)||cand.rawBytes!==rawBytes)throw Error('v21 候选输入身份不符')
      if(groups.some((other,i)=>i!==group && sameSpec(other.spec,proposal.spec))) {
        row.skipped='target-rule-already-selected';continue
      }
      if(cand.control) {
        markPayloadModel(cand.control.payload,cand.control.flags)
        for(const trial of cand.trials) {
          markPayloadModel(trial.payload,trial.flags)
          const before=groups[group]
          const controlGroup={...g,spec:{...proposal.spec},payload:cand.control.payload,v15:true,wordPre:cand.wordPre,context:undefined}
          const offered={...g,spec:{...proposal.spec},payload:trial.payload,v15:true,wordPre:cand.wordPre,context:trial.context,matchDist:trial.matchDist}
          const others=groups.reduce((n,other,i)=>n+(i===group?0:other.payload.length),0)
          const controlGroups=groups.map((other,i)=>i===group?controlGroup:other)
          const nextGroups=groups.map((other,i)=>i===group?offered:other)
          const controlTotal=others+controlGroup.payload.length+planHeader(data.length,segs,controlGroups).length
          const nextTotal=others+trial.payload.length+planHeader(data.length,segs,nextGroups).length
          const accepted=contextUpgradeWins(before.payload.length,total,trial.payload.length,nextTotal)
            && contextUpgradeWins(controlGroup.payload.length,controlTotal,trial.payload.length,nextTotal)
          row.trials.push({context:trial.context,matchDist:trial.matchDist,payloadBytes:trial.payload.length,containerBytes:nextTotal,controlContainerBytes:controlTotal,accepted})
          if(accepted){groups[group]=offered;total=nextTotal;row.selected=trial.context;row.selectedMatchDist=trial.matchDist}

        }
      }
      await tick()
    }
    // Only reopen already-selected transforms, after the complete baseline has won.
    // Existing v20 groups, WORD-PRE and new contexts are never reinterpreted.
    const legacyIds:number[]=[ID.TRANSPOSE,ID.TRANSPOSE_GROUP,ID.SUB_TRANSPOSE,ID.TRANSPOSE_2D,ID.GRAD_V3,ID.SUB_TRANSPOSE_V3,ID.DELTA,ID.DELTA_V3]
    comparison.legacyUpgrades=[]
    for(let group=0;group<groups.length;group++) {
      const g=groups[group],rawBytes=g.members.reduce((n,i)=>n+segs[i].rawLen,0)
      if(!legacyIds.includes(g.spec.id)||g.wordPre||g.context||(payloadModelFlags(g.payload)&V20_FLAG_CM)||rawBytes<CONTEXT_MIN_BYTES)continue
      const row:NonNullable<ContextComparison['legacyUpgrades']>[number]={group,spec:{...g.spec},oldPayload:g.payload.length,oldContainer:total,accepted:false}
      comparison.legacyUpgrades.push(row)
      try {
        const parts=g.members.map(i=>data.subarray(segs[i].start,segs[i].end)),positions=g.members.map(i=>segs[i].start)
        const oldKernel:CMVariant=g.v15?'v15':false,alignment=([ID.TRANSPOSE,ID.TRANSPOSE_GROUP,ID.SUB_TRANSPOSE,ID.TRANSPOSE_2D,ID.SUB_TRANSPOSE_V3] as number[]).includes(g.spec.id)?g.spec.s:1
        // A transpose group can carry an uncompressed (mode=0) column — e.g. the
        // 50% random second column of a binary record stream. Those bytes sit in
        // the sample denominator but cannot respond to the kernel, so a 0.15%
        // relative gate can reject a real v20 win on the CM columns. For the
        // transpose family the sample only has to be non-worse; the complete
        // container gate (contextUpgradeWins) remains strict.
        const transposeFamily=([ID.TRANSPOSE,ID.TRANSPOSE_GROUP,ID.SUB_TRANSPOSE,ID.TRANSPOSE_2D,ID.SUB_TRANSPOSE_V3] as number[]).includes(g.spec.id)
        if(rawBytes>=CONTEXT_SCREEN_MIN_BYTES) {
          const sample=groupKernelSample(parts,positions,alignment,CONTEXT_PROBE_BYTES)
          const old=withCMProbe(()=>encodeTerrainGroup(sample.parts,g.spec,undefined,undefined,undefined,sample.positions,oldKernel))
          const next=withCMProbe(()=>encodeTerrainGroup(sample.parts,g.spec,undefined,undefined,undefined,sample.positions,'v20'))
          row.sampleBase=old.length;row.sampleV20=next.length
          const sampleLimit=transposeFamily?old.length:old.length*0.9985
          if(!(payloadModelFlags(next)&V20_FLAG_CM)||next.length>=sampleLimit){row.skipped='probe-not-better';continue}
        }
        const payload=encodeTerrainGroup(parts,g.spec,undefined,undefined,undefined,positions,'v20')
        if(!(payloadModelFlags(payload)&V20_FLAG_CM)){row.skipped='no-v20-cm';continue}
        const offered={...g,payload,v15:true,wordPre:false},nextGroups=groups.map((other,i)=>i===group?offered:other)
        const nextTotal=nextGroups.reduce((n,x)=>n+x.payload.length,0)+planHeader(data.length,segs,nextGroups).length
        row.newPayload=payload.length;row.newContainer=nextTotal
        row.accepted=contextUpgradeWins(g.payload.length,total,payload.length,nextTotal)
        if(row.accepted){groups[group]=offered;total=nextTotal}
      } catch(error){row.error=error instanceof Error?error.message:String(error)}
      await tick()
    }
    if(total>=baseline.container.length)return finish(baseline)
    const header=planHeader(data.length,segs,groups)
    const container=new Uint8Array(header.length+groups.reduce((n,g)=>n+g.payload.length,0));container.set(header)
    let pos=header.length;for(const g of groups){container.set(g.payload,pos);pos+=g.payload.length}
    if(container.length!==total||container.length>=baseline.container.length)throw Error('v21 完整容器未严格减小')
    const nextSegs=segs.map(s=>({...s})),blockCost=new Float32Array(baseline.blockCost.length)
    for(const g of groups) {
      let cumulative=0,allocated=0
      const weight=g.members.reduce((n,i)=>n+segs[i].compLen,0)
      const raw=g.members.reduce((n,i)=>n+segs[i].rawLen,0)
      for(let j=0;j<g.members.length;j++) {
        const i=g.members[j],sg=nextSegs[i]
        cumulative+=weight>0?segs[i].compLen:sg.rawLen
        const end=j===g.members.length-1?g.payload.length:Math.round(g.payload.length*cumulative/(weight||raw))
        sg.compLen=end-allocated;allocated=end;sg.context=g.context;sg.modelFlags=payloadModelFlags(g.payload)
        if(g.payload !== retained[groups.indexOf(g)].payload) {delete sg.subPeel;delete sg.peel;delete sg.micro}
        if(!sameSpec(sg.spec,g.spec)) {
          sg.spec={...g.spec}
          // These describe the old transform's payload, not the retained raw
          // segmentation; do not expose stale anchor/peel details after a win.
          delete sg.subPeel;delete sg.peel;delete sg.micro
        }
        if(g.context)sg.label=specLabel(g.spec)+` [${g.context}]`
      }
    }
    // Reweight prior heat-map information, not new-model bit attribution.
    // All segment bytes still sum exactly to the final payload length.
    for(const sg of nextSegs) {
      const first=Math.floor(sg.start/BLOCK),last=Math.ceil(sg.end/BLOCK)
      let sum=0
      for(let b=first;b<last;b++)sum+=Math.max(0,baseline.blockCost[b])*(Math.min(sg.end,(b+1)*BLOCK)-Math.max(sg.start,b*BLOCK))
      for(let b=first;b<last;b++) {
        const overlap=Math.min(sg.end,(b+1)*BLOCK)-Math.max(sg.start,b*BLOCK)
        blockCost[b]+=sg.compLen*8*(sum>0?Math.max(0,baseline.blockCost[b])*overlap/sum:overlap/sg.rawLen)
      }
    }
    for(let b=0;b<blockCost.length;b++)blockCost[b]/=Math.max(1,baseline.analysis.blocks[b].end-baseline.analysis.blocks[b].start)
    comparison.accepted=true;comparison.candidateBytes=container.length
    retainedContextGroups.set(container,groups)
    retainedPlanGroups.set(container,groups)
    onStage?.(`v21 完整容器严格择优：${baseline.container.length} → ${container.length} B`,87)
    return finish({...baseline,container,segs:nextSegs,blockCost,overhead:header.length})
  } catch(error) {
    comparison.error=error instanceof Error?error.message:String(error)
    comparison.accepted=false;comparison.candidateBytes=baseline.container.length
    return finish(baseline)
  }
}
