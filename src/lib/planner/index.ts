/** Planner-layer public surface (P37.9 module split, step 1).
 *
 * Execution policy only — level tiers and the wall-clock budget. These are read by
 * every planner stage and must be inherited by workers, which is why they live in a
 * leaf module instead of the orchestrator.
 */
export {
  type CompressionLevel,
  currentCompressionLevel,
  deadlineActive,
  deadlineClear,
  deadlineHit,
  deadlineSet,
  pruningLevel,
  setActiveCompressionLevel,
} from './budget'
