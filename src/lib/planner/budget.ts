/**
 * Planner-level execution policy: compression level and wall-clock budget.
 *
 * Split out of `codec.ts` (P37.9) because these are the only pieces of planner
 * state that *every* stage has to read, and because they are the pieces a worker
 * has to inherit. Keeping them in a leaf module means a future `planner/` module
 * can depend on them without importing the 5,000-line orchestrator.
 *
 * Invariant: sizes never depend on `level` at `probeDepth === 0` — the decoder has
 * no idea which level produced a container, so a level may only prune *search*.
 */

export type CompressionLevel = 'fast' | 'balanced' | 'max'

let activeLevel: CompressionLevel = 'max'

export function currentCompressionLevel(): CompressionLevel { return activeLevel }

/** Switch level inside a scope (workers, tests); returns the restore function. */
export function setActiveCompressionLevel(level?: CompressionLevel): () => void {
  const previous = activeLevel
  if (level === 'fast' || level === 'balanced' || level === 'max') activeLevel = level
  return () => { activeLevel = previous }
}

/** 0 = max, 1 = balanced, 2 = fast. */
export function pruningLevel(): 0 | 1 | 2 { return activeLevel === 'fast' ? 2 : activeLevel === 'balanced' ? 1 : 0 }

/**
 * Wall-clock budget for the current encode.
 *
 * A context-mixing planner cannot be asked for "a result in 50 ms": every stage is a
 * measurement, and a measurement cannot be truncated without changing the answer. A
 * budget can only stop *starting* new measurements; each search loop consults this
 * deadline and returns the best plan it has already priced. The result is therefore
 * "best plan found within the budget" — never a partial container, because only fully
 * measured candidates are ever adopted.
 */
let encodeDeadline = 0

export function deadlineHit(): boolean { return encodeDeadline > 0 && Date.now() >= encodeDeadline }
export function deadlineSet(ms: number): void { encodeDeadline = ms > 0 ? Date.now() + ms : 0 }
export function deadlineClear(): void { encodeDeadline = 0 }
export function deadlineActive(): boolean { return encodeDeadline > 0 }
