import type { ContextCandidates, CompressionLevel } from './codec'
// 确定性并行编码引擎。
//
// 硬性约束：并行结果必须与单线程**逐字节一致**。因此这里只并行"互相独立、
// 结果只由输入决定"的纯计算单元；依赖前序结果的状态（区域合并、分组、归一、
// 容器序列化）仍留在主线程按原顺序执行。汇总一律按下标排序，与完成顺序无关。
//
// 三种运行环境：
//   * Node + worker_threads：用 SharedArrayBuffer 零拷贝共享语料，主线程只传
//     偏移量与标量参数；worker 直接按 (start, end) 取只读视图。
//   * 浏览器：同一套接口留给 Worker 调用（见 parallel-node.ts 的同构实现）。
//   * 不支持 SAB / 只有 1 核 / 任务太小：自动退化为同线程串行，结果完全一样。
//
// 并发度：Math.min(可用核数, 8)，可用 UCZ_THREADS 覆盖。

import type { KernelScreen, KernelVariant, GroupCandidateOptions } from './group-policy'

/** 任务载荷：只有偏移、标量与纯数据，不含任何外部引用（可结构化克隆）。 */
export type JobPayload = ({ cmV20?: { enabled:boolean; binRecovery:boolean }; level?: CompressionLevel; strictPrior?: boolean } & (
  | { kind: 'chooseSpec'; start: number; end: number; cls: number; bestS: number; sampleLimit: number; base: number }
  | { kind: 'encodeGroup'; parts: [number, number][]; spec: SpecData; positions: number[]; ends: number[]; skipBase?: boolean; groupOptions?: GroupCandidateOptions }
  | { kind: 'contextGroup'; parts: [number,number][]; spec:SpecData; positions:number[]; rawText?:boolean; retained?:{payload:Uint8Array;flags:number;wordPre:boolean} }
  | { kind: 'encodeSpecs'; start: number; end: number; specs: SpecData[]; base: number }))

export interface SpecData { id: number; s: number; r: number }

/**
 * 分组编码任务回传的 v15 / WORD-PRE 候选（P4-3）。
 *
 * worker 把"真实 v13 载荷"与"v15 / 词元候选"一起算好带回主线程，主线程只做
 * 与串行完全相同的严格择优，因此不再需要"worker 算一遍 v13、主线程再算一遍
 * v15"。`spec` 一并回传，主线程用它核对候选是否仍然对应当前规则（防止未来
 * 出现编码期改写规则的分组被误用陈旧候选）。
 */
export interface GroupCandidate {
  spec: SpecData
  alt: Uint8Array | null
  wordPre: Uint8Array | null
  altFlags: number
  wordPreFlags: number
  v20?: Uint8Array | null
  v20Flags?: number
  wordPreV20?: Uint8Array | null
  wordPreV20Flags?: number
  /** 拼接后的字节数，仅用于主线程的诊断统计（__WP_STATS）。 */
  rawLen: number
  screening?: KernelScreen[]
  variants?: KernelVariant[]
}

/** 任务回复：纯数据，便于跨线程传输。 */
export type JobReply =
  | { kind:'contextGroup'; candidates:ContextCandidates }
  | { kind: 'chooseSpec'; spec: SpecData; trials: TrialData[] }
  | { kind: 'encodeGroup'; bytes: Uint8Array; modelFlags: number; cost: Float32Array; fragments: number; cand: GroupCandidate | null }
  | { kind: 'encodeSpecs'; sizes: number[] }

/** 精简后的试探记录：只保留主线程后续会用到的字段。 */
export interface TrialData {
  spec: SpecData
  ratio: number
  payloadSize: number
  sampleLen: number
  sampleStart?: number
  sampleStarts?: number[]
  probeSize?: number
  probeLen?: number
  fullSize?: number
  modelFlags?: number
}

/** 计算默认并发度；UCZ_THREADS 可覆盖，非法值忽略。 */
export function threadCount(): number {
  if (typeof process === 'undefined') return 1
  const raw = process.env?.UCZ_THREADS
  if (raw !== undefined) {
    const env = Number(raw)
    if (Number.isFinite(env) && env >= 1) return Math.min(Math.floor(env), memorySafeThreads())
  }
  let cores = 1
  try {
    // 注意：打包器（esbuild）会剥掉 process 上未声明的属性，因此不能直接
    // 读 process.availableParallelism；这里走 node:os（Node 专用分支，
    // 浏览器端 typeof process 的判断已经提前返回）。
    cores = osParallelism()
  } catch { cores = 1 }
  // 至少 1 个；硬上限由宪法总预算给出，而不是只看本机核数。
  const capped = Math.min(Math.floor(cores) || 1, 8)
  return Math.min(capped, memorySafeThreads())
}

/**
 * Worst-case resident bytes for one context-mixing model.
 *
 * `tables` is one `Uint32Array(1 << bits)` per context (4 B/entry), plus the match
 * tables (three 4-byte hashes of `2^mhBits`) and the small mixer arrays. The old
 * budget used a flat "1024 MiB per worker" figure, which over- or under-estimated
 * by 2x depending on the tier actually chosen for the stream.
 */
export function cmModelBytes(nctx: number, bits: number, mhBits = 0): number {
  const tables = nctx * (1 << bits) * 4
  const match = mhBits > 0 ? 3 * (1 << mhBits) * 4 : 0
  return tables + match + 65536
}

/** P19.1 hard constitutional budget: 3.5 GiB workers + 512 MiB headroom. */
export const CONSTITUTIONAL_MAX_RAM_MIB = 3584
const CONSTITUTIONAL_HEADROOM_MIB = 512

/**
 * 依据可用内存收窄并发度。24-bit 模型每组上下文 576 MiB；按每 worker
 * 1024 MiB 的最坏预算，宪法硬上限最多 3 个 worker（3×1024 + 512 = 3584 MiB）。
 * 无论本机有多少核，都不允许突破该总预算。
 */
export function memorySafeThreads(chunkBytes = 0): number {
  const perWorkerMiB = chunkBytes > 8 * 1024 * 1024 ? 1024 : chunkBytes > 0 ? 512 : 1024
  const hard = Math.max(1, Math.floor((CONSTITUTIONAL_MAX_RAM_MIB - CONSTITUTIONAL_HEADROOM_MIB) / perWorkerMiB))
  let totalMiB = 0
  try {
    const p = process as unknown as { memoryUsage?: () => { rss: number } }
    const free = (globalThis as { navigator?: { deviceMemory?: number } }).navigator?.deviceMemory
    if (free) totalMiB = free * 1024
    else if (typeof p.memoryUsage === 'function') {
      const m = memoryLimit()
      if (m > 0) totalMiB = m / 1048576
    }
  } catch { totalMiB = 0 }
  if (!(totalMiB > 0)) return hard
  // 本机可用内存也要留出主线程余量；与宪法硬上限取最小值。
  const byMemory = Math.max(1, Math.floor((totalMiB - 1024) / 1024))
  return Math.max(1, Math.min(8, hard, byMemory))
}

let memLimitFn: (() => number) | null = null
/** 由 parallel-pool 注入真正的内存探测（它可以直接 import 'node:os'）。 */
export function registerMemoryLimit(fn: () => number): void { memLimitFn = fn }
function memoryLimit(): number { return memLimitFn ? memLimitFn() : 0 }

/**
 * 取可用并行度。Node 端由 parallel-pool 通过 registerCoreCounter 注入实现
 * （它可以直接 import 'node:os'，不会被浏览器包牵连）；未注入时按 1 处理，
 * 即退化为串行。
 */
let coreCounter: (() => number) | null = null
export function registerCoreCounter(fn: () => number): void { coreCounter = fn }
function osParallelism(): number {
  if (coreCounter) return coreCounter()
  // 未显式注入时（例如只 import 了本模块的诊断脚本）尽量自测一次：
  // Node 环境下 process 上有 cpus()，浏览器端走 navigator.hardwareConcurrency。
  try {
    const p = process as unknown as { cpus?: () => unknown[] }
    if (typeof p.cpus === 'function') { const n = p.cpus().length; if (n > 0) return n }
  } catch { /* 继续 */ }
  try {
    const nav = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
    if (nav?.hardwareConcurrency) return nav.hardwareConcurrency
  } catch { /* 继续 */ }
  return 1
}

/** 任务量足够大才值得付线程启动与传参成本。 */
export function worthParallelizing(jobCount: number, totalBytes: number): boolean {
  return threadCount() > 1 && jobCount >= 2 && totalBytes >= 512 * 1024
}

/**
 * LPT（最长处理时间优先）静态均衡：把任务从大到小依次投给当前负载最轻的桶。
 * 单文件里区域大小差异极大（mozilla 从 1 KB 到 700 KB），动态"抢任务"会让
 * 结果调度依赖时序；静态均衡只依赖任务列表本身，**与运行时快慢无关**，
 * 因此同一输入每次都会得到同样的划分（虽然结果正确性并不依赖划分）。
 */
export function lptAssign(loads: readonly number[], workers: number): number[][] {
  const w = Math.max(1, Math.min(workers, loads.length || 1))
  const order = loads.map((_, i) => i).sort((a, b) => loads[b] - loads[a] || a - b)
  const buckets: { load: number; jobs: number[] }[] = Array.from({ length: w }, () => ({ load: 0, jobs: [] }))
  for (const i of order) {
    let best = 0
    for (let k = 1; k < w; k++) if (buckets[k].load < buckets[best].load) best = k
    buckets[best].jobs.push(i)
    buckets[best].load += loads[i]
  }
  return buckets.map(b => b.jobs)
}
