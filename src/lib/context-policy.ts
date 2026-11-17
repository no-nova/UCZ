// P14.1: a new v21 wire namespace; existing v20/legacy model semantics stay fixed.
import {
  V21_FLAG_CONTEXTS,
  GROUP_CONTEXT_SHIFT,
  GROUP_CONTEXT_MASK,
  GROUP_MATCH_DIST_BIT,
  GROUP_CONTEXT_EXT_BIT,
} from './container/format'
export {
  V21_FLAG_CONTEXTS,
  GROUP_CONTEXT_SHIFT,
  GROUP_CONTEXT_MASK,
  GROUP_MATCH_DIST_BIT,
  GROUP_CONTEXT_EXT_BIT,
}
/**
 * v22 per-group bit, above the three group-context bits. It records that THIS
 * group's payload used the distance-split match model, so groups that did not win
 * that candidate keep their exact old bytes inside a v22 container.
 */
/**
 * P17.7: second group-context namespace.
 *
 * All eight values of the three-bit group context field were already assigned
 * (0 = no context, 1..7 = the base contexts), and bit 20 carries `matchDist`, so
 * a new context cannot simply take "the next free code" without reinterpreting
 * every group payload written before it. This bit re-uses the *same* three-bit
 * field as an index into `EXT_CONTEXT_CODES` instead. Every pre-P17.7 container
 * has it clear and therefore decodes byte-identically, and the payload stays
 * self-describing (no container version bump), exactly like
 * `GROUP_MATCH_DIST_BIT` did for v22.
 */
/** Codes 1..7 inside the base namespace; 0 means "no context". */
export const CONTEXT_CODES = { 'bin-stride4': 1, 'wide-geom': 2, 'wp-token3': 3, 'wp-merge': 4, 'text-sparse5': 5, 'xform-bin': 6, 'xform-bin-stride4': 7 } as const
/**
 * Codes 1..7 when `GROUP_CONTEXT_EXT_BIT` is set. Extended code 0 is unavailable:
 * an all-zero three-bit field already means "no context" in the base namespace and
 * `contextFromGroupBits` returns `undefined` for it, so the extended namespace
 * starts at 1 exactly like the base one.
 */
export const EXT_CONTEXT_CODES = { 'text-linecol': 1, 'text-lexcol': 2, 'text-tabcol': 3, 'sym-2bit': 4, 'sym-5bit': 5, 'sym-5bit-gap': 6, 'text-vertcol': 7 } as const
export type CMContext = keyof typeof CONTEXT_CODES | keyof typeof EXT_CONTEXT_CODES
/** Split a context into the three-bit field value and the namespace bit it needs. */
export function contextCodeOf(context: CMContext): { code: number; ext: boolean } {
  const base = (CONTEXT_CODES as Record<string, number | undefined>)[context]
  if (base !== undefined) return { code: base, ext: false }
  const ext = (EXT_CONTEXT_CODES as Record<string, number | undefined>)[context]
  if (ext === undefined) throw Error('未知的 v21 分组上下文')
  return { code: ext, ext: true }
}
/** Decode the context of a group from its raw `r` field. */
export function contextFromGroupBits(rRaw: number): CMContext | undefined {
  const code = (rRaw & GROUP_CONTEXT_MASK) >>> GROUP_CONTEXT_SHIFT
  if (!code) return undefined
  if (rRaw & GROUP_CONTEXT_EXT_BIT) {
    const mode = (Object.keys(EXT_CONTEXT_CODES) as (keyof typeof EXT_CONTEXT_CODES)[]).find(m => EXT_CONTEXT_CODES[m] === code)
    if (!mode) throw Error('未知的 v21 扩展分组上下文')
    return mode
  }
  return contextFromCode(code)
}
export interface CMOptions {
  context?: CMContext
  /**
   * v22: distance-split match state + a second generation of the 4-gram slot.
   *
   * Orthogonal to `context` by construction: it changes the match model, not the
   * context hashes, so `(context, matchDist)` compose freely. Only defined for the
   * `text` and `bin` profiles — residual streams (`res`/`res2d`) are excluded
   * because their values concentrate on 0/+1/-1, where four consecutive bytes
   * collide by coincidence rather than by LZ-string repetition, and are measured
   * to lose (mr-mid +7 B).
   */
  matchDist?: boolean
  /**
   * x86 executable modelling for the `bcj` kernel (`ID.BCJ_V3` streams only).
   * Encoder and decoder derive it from the same group spec, so it needs no flag.
   */
  bcj?: boolean
  /** P18.0: rank alphabet for the universal low-cardinality symbol modes. */
  symMap?: { k: number; bits: number; symToByte: Uint8Array; byteToSym: Uint8Array; compByte: Uint8Array }
}
export const CONTEXT_MIN_BYTES = 16 * 1024
export const CONTEXT_SCREEN_MIN_BYTES = 64 * 1024
export const CONTEXT_PROBE_BYTES = 192 * 1024

export function contextFromCode(code: number): CMContext | undefined {
  if (code === 0) return undefined
  const mode = (Object.keys(CONTEXT_CODES) as (keyof typeof CONTEXT_CODES)[]).find(mode => CONTEXT_CODES[mode] === code)
  if (!mode) throw Error('未知的 v21 分组上下文')
  return mode
}

/** Both the actual group payload and complete container must strictly shrink.
 * Equality always preserves the existing stream, including its header/version. */
export function contextUpgradeWins(basePayload: number, baseContainer: number, candidatePayload: number, candidateContainer: number): boolean {
  return candidatePayload < basePayload && candidateContainer < baseContainer
}
