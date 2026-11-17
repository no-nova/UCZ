/**
 * Container wire format: the single source of truth.
 *
 * Everything that a decoder must agree on *without* consulting a model lives here —
 * the magic, the version bounds, the transform ids and every container/group flag bit.
 * `codec.ts` and `coder.ts` re-export these names, so this extraction is byte-neutral
 * (verified against the 26-file golden manifest) and callers did not move.
 *
 * Rules for this file:
 *  * Nothing here may import from `codec.ts` / `coder.ts` (it is a leaf).
 *  * A bit that is already assigned is never reused. `CM_FLAGS_MASK` is the v15..v21
 *    namespace; `V21_FLAG_CONTEXTS` and `V22_FLAG_MATCH_DISTANCE` sit above it.
 */

/** Container magic: "UCZ". */
export const CONTAINER_MAGIC = [0x55, 0x43, 0x5a] as const

/**
 * Highest container version this build writes and reads.
 *
 *  v23 — strict zero-prior profile (see PRIOR_REGISTRY.md)
 *  v24 — strict zero-prior + CRC-32C trailer
 *  v25 — default priors + CRC-32C trailer
 *  v26 — default priors + CRC-32C trailer + fresh match-distance state per match
 */
export const MAX_CONTAINER_VERSION = 27

/**
 * Version → capability bits. The version byte is the only thing the decoder sees, so
 * every capability has to be derivable from it. Encodings in use:
 *   v23 strict · v24 strict+CRC · v25 default+CRC · v26 default+fresh · v27 default+fresh+CRC
 */
export const containerIsStrict = (v: number): boolean => v === 23 || v === 24
export const containerHasChecksum = (v: number): boolean => v === 24 || v === 25 || v === 27
export const containerHasFreshDistance = (v: number): boolean => v >= 26

/** Transform ids. Never renumber: these bytes are on disk. */
export const ID = { STORE: 0, FILL: 1, RLE: 2, O0: 3, TEXT: 4, BIN: 5, DELTA: 6, GRAD: 7, D16: 8, TRANSPOSE: 9, TRANSPOSE_GROUP: 10, BCJ: 11, ANCHOR: 12, ANCHOR_FOLD: 13, PEEL: 14, SUB_TRANSPOSE: 15, SUB_ANCHOR: 16, MICRO: 17, TEXT_V2: 18, BIN_V2: 19, BCJ_V2: 20, GRAD_V2: 21, TRANSPOSE_2D: 22, TEXT_V3: 23, BIN_V3: 24, BCJ_V3: 25, GRAD_V3: 26, DELTA_V3: 27, SUB_TRANSPOSE_V3: 28, SUB_ANCHOR_V3: 29, TRANSPOSE_GROUP_V3: 30, WIDE_GRAD: 31, REC2: 32, BITPLANE: 33 } as const

// ---- v18 flags (1 byte) ------------------------------------------------------
export const V18_FLAG_TEXT_A2_OFF = 0x01
export const V18_FLAG_BIG_TABLE_22 = 0x02
export const V18_FLAG_TABLE_23 = 0x04
export const V18_FLAG_MATCH_21 = 0x08
export const V18_FLAG_MATCH_22 = 0x10
export const V18_FLAG_RES_A2_OFF = 0x20
export const V18_FLAG_WORD_PRE_A2_OFF = 0x40
export const V18_FLAG_UNSCOPED = 0x80

// ---- v19/v20 flags (uint16) --------------------------------------------------
export const V19_FLAG_TABLE_24 = 0x100
export const V19_FLAG_MATCH_23 = 0x200
export const V19_FLAG_MHT4_20 = 0x400
export const V20_FLAG_TRANSFORMS = 0x800
export const V20_FLAG_CM = 0x1000
export const V20_FLAG_BIN_RECOVERY = 0x2000

// ---- v21/v22 flags (uint16) --------------------------------------------------
/** v21 wire namespace: the container carries per-group context codes. */
export const V21_FLAG_CONTEXTS = 0x4000
/** v22: at least one group uses the distance-split match model. */
export const V22_FLAG_MATCH_DISTANCE = 0x8000

/** Everything up to and including the v21 context bit. */
export const CM_FLAGS_MASK = 0x3fff

// ---- per-group word bits -----------------------------------------------------
/** Three-bit group-context field. */
export const GROUP_CONTEXT_SHIFT = 17
export const GROUP_CONTEXT_MASK = 0xe0000
/** v22: this group's payload used the distance-split match model. */
export const GROUP_MATCH_DIST_BIT = 0x100000
/** P17.7: the three-bit field indexes `EXT_CONTEXT_CODES` instead. */
export const GROUP_CONTEXT_EXT_BIT = 0x200000
