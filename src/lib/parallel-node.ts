// Node 端并行实现的惰性入口。
//
// 浏览器包里不能出现 `node:worker_threads` / `node:os`（Vite 会把它们替换成
// 空占位并在打包时报错）。因此 codec 只依赖本文件的**轻量门面**，真正的
// parallel-pool 在 Node 环境下用动态 import 按需加载；浏览器端 isNode() 为假，
// 整个 Node 模块不会被拉进包。
//
// 语义保证：加载失败或不支持时一律返回 null / false，调用方退回串行，产物不变。

import type { JobPayload, JobReply } from './parallel'
import { deadlineActive } from './planner/budget'
import { registerCoreCounter, registerMemoryLimit, threadCount } from './parallel'

/** 是否运行在 Node（有 worker_threads 的真实环境，排除打包后的浏览器）。 */
export function isNodeRuntime(): boolean {
  if (typeof process === 'undefined' || typeof window !== 'undefined') return false
  // 浏览器里 Vite 会把 process 替换成空对象或 undefined；这里额外要求有 versions.node。
  const v = (process as unknown as { versions?: { node?: string } }).versions
  return !!v?.node
}

type PoolModule = {
  runParallelJobs: (jobs: readonly JobPayload[], loads: readonly number[], data: Uint8Array) => Promise<JobReply[] | null>
  closePool: () => Promise<void>
  registerNodeProbes?: (reg: {
    registerCoreCounter: (fn: () => number) => void
    registerMemoryLimit: (fn: () => number) => void
  }) => void
}

/** 浏览器构建的空桩：并行恒不可用，调用方退回串行。 */
const BROWSER_STUB: PoolModule = {
  runParallelJobs: () => Promise.resolve(null),
  closePool: () => Promise.resolve(),
} as unknown as PoolModule

declare const __UCZ_NO_WORKERS__: boolean

let mod: PoolModule | null = null
/** 最近一次加载失败的原因（诊断用）。 */
export let loadError: string | null = null

/**
 * 加载并行池。
 *
 * 浏览器构建里这个函数被 Vite alias 成空桩模块（parallel-pool.browser.ts），
 * 因此 `import('./parallel-pool')` 在浏览器包里解析到桩、不会拉进 Node 内置模块。
 * 但内联 worker（iife 格式）不支持代码分割，所以在 worker 环境下要求它是
 * 同步可用的——浏览器端根本不走这里（isNodeRuntime 为假）。
 */
const importPool = async (): Promise<PoolModule> => {
  // 浏览器构建里 `__UCZ_NO_WORKERS__` 被 define 成 true，这里走空桩；
  // Node 构建（探针 / 测试 / bench）里是 false，才真正加载 worker_threads 实现。
  // 用常量分支而不是动态模块路径，原因是内联 worker 不允许代码分割。
  // Node 侧（esbuild 打包）没有这个 define，用 typeof 守卫避免 ReferenceError。
  if (typeof __UCZ_NO_WORKERS__ !== 'undefined' && __UCZ_NO_WORKERS__) return BROWSER_STUB
  return import('./parallel-pool')
}
let loading: Promise<PoolModule | null> | null = null

async function loadPool(): Promise<PoolModule | null> {
  if (mod) return mod
  if (!isNodeRuntime()) return null
  if (!loading) {
    loading = (async () => {
      try {
        // 静态 import 才能被 esbuild / Rollup 正确解析（探针与测试都走单文件打包，
        // 变量路径在打包产物里会解析失败）。浏览器端由 Vite 的 alias 把它替换成
        // 空桩（见 vite.config.ts），因此 Node 内置模块不会进入浏览器包。
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const m = await importPool()
        m.registerNodeProbes?.({ registerCoreCounter, registerMemoryLimit })
        mod = m
        return m
      } catch (error) {
        // 记下原因便于诊断；并行只是加速手段，失败必须静默退回串行。
        loadError = error instanceof Error ? error.message : String(error)
        return null
      }
    })()
  }
  return loading
}

/**
 * 池是否可用（同步判断：Node 且多核）。
 *
 * 带 `--time-budget` 时一律退回串行：一次派发是一整批任务，池无法在批内中断，
 * 于是"有预算"反而比串行慢（实测 6.8 s → 15.5 s）。串行循环每步都会查一次
 * 截止时间，这才是预算想要的语义。
 */
export function nodeParallelReady(): boolean {
  return isNodeRuntime() && threadCount() > 1 && !deadlineActive()
}

/** 并行执行；不可用时返回 null。 */
export async function runNodeJobs(
  jobs: readonly JobPayload[], loads: readonly number[], data: Uint8Array,
): Promise<JobReply[] | null> {
  const m = await loadPool()
  if (!m) return null
  return m.runParallelJobs(jobs, loads, data)
}

/** 关闭池；没有加载过则无事发生。 */
export async function closeNodePool(): Promise<void> {
  const m = mod
  if (!m) return
  await m.closePool()
}
