// 浏览器端空桩（见 vite.config.ts 的 alias）。
// 浏览器没有 worker_threads / node:os；并行恒不可用，codec 退回串行。
import type { JobPayload, JobReply } from './parallel'

export function registerNodeProbes(_reg: unknown): void { /* 浏览器无需探测 */ }
export function runParallelJobs(
  _jobs: readonly JobPayload[], _loads: readonly number[], _data: Uint8Array,
): Promise<JobReply[] | null> { return Promise.resolve(null) }
export function closePool(): Promise<void> { return Promise.resolve() }
