// P14.1: a new v21 wire namespace; existing v20/legacy model semantics stay fixed.
export const V21_FLAG_CONTEXTS = 0x4000 // container uint16, NOT group WORD-PRE
export const GROUP_CONTEXT_SHIFT = 17
export const GROUP_CONTEXT_MASK = 0xe0000
/**
 * v22 per-group bit, above the three group-context bits. It records that THIS
 * group's payload used the distance-split match model, so groups that did not win
 * that candidate keep their exact old bytes inside a v22 container.
 */
export const GROUP_MATCH_DIST_BIT = 0x100000
export const CONTEXT_CODES = { 'bin-stride4': 1, 'wide-geom': 2, 'wp-token3': 3, 'wp-merge': 4, 'text-sparse5': 5, 'xform-bin': 6, 'xform-bin-stride4': 7 } as const
export type CMContext = keyof typeof CONTEXT_CODES
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
}
export const CONTEXT_MIN_BYTES = 16 * 1024
export const CONTEXT_SCREEN_MIN_BYTES = 256 * 1024
export const CONTEXT_PROBE_BYTES = 192 * 1024

export function contextFromCode(code: number): CMContext | undefined {
  if (code === 0) return undefined
  const mode = (Object.keys(CONTEXT_CODES) as CMContext[]).find(mode => CONTEXT_CODES[mode] === code)
  if (!mode) throw Error('未知的 v21 分组上下文')
  return mode
}

/** Both the actual group payload and complete container must strictly shrink.
 * Equality always preserves the existing stream, including its header/version. */
export function contextUpgradeWins(basePayload: number, baseContainer: number, candidatePayload: number, candidateContainer: number): boolean {
  return candidatePayload < basePayload && candidateContainer < baseContainer
}
