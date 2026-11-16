// Node 端 worker 池：零拷贝共享语料，按 LPT 静态均衡分发任务。
//
// 关键设计：
//   * 语料放进 SharedArrayBuffer，worker 只收偏移量，不复制几十 MB 数据；
//   * 任务按"数据量从大到小"静态划成 N 个桶（N = 线程数），每个 worker 领一桶。
//     静态划分只依赖任务列表本身，与运行时快慢无关，因此同一输入总是同样的
//     划分（正确性并不依赖划分，但可复现性对排查问题很重要）；
//   * 汇总按下标回填，与完成顺序无关。
//
// worker 源码通过 esbuild 的 `?worker` 式内联不可用（本项目无该插件），
// 因此这里用 worker_threads 的 `eval` 模式：workerCode 由构建期注入。

import { Worker } from 'node:worker_threads'
import * as os from 'node:os'
import { lptAssign, threadCount, worthParallelizing, type JobPayload, type JobReply } from './parallel'

// 把 Node 的并行度 / 内存探测注入 shared/parallel.ts：那里不能直接 import
// 'node:os'（浏览器包会因此带上 Node 内置模块）。由 parallel-node 门面在
// 首次加载本模块时调用一次。
export function registerNodeProbes(reg: {
  registerCoreCounter: (fn: () => number) => void
  registerMemoryLimit: (fn: () => number) => void
}): void {
  reg.registerCoreCounter(() => {
    try { return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length }
    catch { return 1 }
  })
  reg.registerMemoryLimit(() => {
    try { return os.totalmem() } catch { return 0 }
  })
}

import { PARALLEL_WORKER_CODE } from './parallel-worker-code'

// 构建期已把 worker 固化成字符串（见 scripts/build-worker-code.mjs）。
const workerCode = PARALLEL_WORKER_CODE

// 单个任务的看门狗上限：正常任务最慢是几十秒级（mozilla 的大区域试探），
// 给足余量；超时即放弃并行、回退串行，产物不受影响。
const JOB_TIMEOUT_MS = 10 * 60 * 1000

let pool: Worker[] | null = null
let shared: SharedArrayBuffer | null = null
// Workers bind `workerData.sab` exactly once, so a pool is only reusable while the
// SharedArrayBuffer it was spawned with is still the live one. Without this, a
// second job with a different byteLength silently reads the previous job's data.
let poolSab: SharedArrayBuffer | null = null
// 未触发的看门狗定时器必须能被 `closePool()` 统一清掉，否则 10 分钟的定时器
// 会一直把事件循环撑开（`--input-type=module -e` 这类一次性调用会挂住不退出）。
const timers = new Set<ReturnType<typeof setTimeout>>()

function share(data: Uint8Array): SharedArrayBuffer {
  if (!shared || shared.byteLength !== data.byteLength) {
    shared = new SharedArrayBuffer(data.byteLength)
  }
  new Uint8Array(shared).set(data)
  return shared
}

function spawn(count: number): Worker[] {
  const sab = shared!
  const workers: Worker[] = []
  for (let i = 0; i < count; i++) {
    // `execArgv: []`：worker 会继承主进程的 `process.execArgv`，当调用方用
    // `node --input-type=module -e ...` 启动时，CJS worker 包会因为
    // `--input-type=module` 而崩在 `require is not defined`。
    workers.push(new Worker(workerCode, { eval: true, execArgv: [], workerData: { sab } }))
  }
  return workers
}

/** 让一个 worker 依次跑完一批任务，按批内顺序返回结果。 */
function runBatch(worker: Worker, batch: JobPayload[]): Promise<JobReply[]> {
  return new Promise<JobReply[]>((resolve, reject) => {
    const out: JobReply[] = []
    let i = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => {
      worker.off('message', onMsg); worker.off('error', onErr); worker.off('exit', onExit)
      if (timer) { clearTimeout(timer); timers.delete(timer); timer = null }
    }
    const fail = (e: Error) => { cleanup(); reject(e) }
    // 每个任务都有独立的看门狗：worker 崩溃或在极端输入上卡住时，
    // 批不会永远悬挂（悬挂会让整个压缩停在等 Promise 上）。
    const armWatchdog = (payload: JobPayload) => {
      if (timer) { clearTimeout(timer); timers.delete(timer) }
      timer = setTimeout(() => fail(new Error(`并行任务超时（${payload.kind}）`)), JOB_TIMEOUT_MS)
      // 不让看门狗单独把进程钉住：真正的超时仍然生效，但没有挂起任务时它不该
      // 阻止 Node 退出（10 分钟的空等就是这里来的）。
      timer.unref?.()
      timers.add(timer)
    }
    const dispatch = () => {
      if (i >= batch.length) { cleanup(); resolve(out); return }
      const payload = batch[i]
      armWatchdog(payload)
      worker.postMessage(payload)
    }
    const onMsg = (reply: JobReply & { error?: string }) => {
      if (timer) { clearTimeout(timer); timers.delete(timer); timer = null }
      if (reply && reply.error) { fail(new Error(reply.error)); return }
      out.push(reply); i++
      dispatch()
    }
    const onErr = (e: Error) => fail(e)
    // worker 正常退出（例如被 closePool 或外部 kill 掉）时不能把批悬挂在
    // 一个永远等不到回复的 Promise 上。
    const onExit = (code: number) => { if (i < batch.length) fail(new Error(`并行 worker 提前退出（code=${code}）`)) }
    // 先挂监听再派发第一条：反过来的话，worker 回复可能在监听注册前就到达，
    // 消息会丢失并让批永远等待（这正是之前 xml 卡住十几分钟的原因）。
    worker.on('message', onMsg)
    worker.on('error', onErr)
    worker.on('exit', onExit)
    dispatch()
  })
}

/** 并行池是否可用（有源码 + 环境支持共享内存 + 多核）。 */
export function parallelReady(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && typeof Worker !== 'undefined' && threadCount() > 1
}

/**
 * 并行执行一批任务，返回结果与 jobs 顺序严格对应。
 * 任务太小 / 只有一核 / worker 源码未注入时返回 null，调用方走原串行路径。
 */
export async function runParallelJobs(
  jobs: readonly JobPayload[], loads: readonly number[], data: Uint8Array,
): Promise<JobReply[] | null> {
  if (!parallelReady()) return null
  const total = loads.reduce((a, b) => a + b, 0)
  if (!worthParallelizing(jobs.length, total)) return null
  const threads = Math.min(threadCount(), jobs.length)
  if (threads <= 1) return null

  share(data)
  if (!pool || pool.length !== threads || poolSab !== shared) {
    pool?.forEach(w => void w.terminate())
    pool = spawn(threads)
    poolSab = shared
  }
  const buckets = lptAssign(loads, threads)
  const replies = new Array<JobReply>(jobs.length)
  try {
    await Promise.all(buckets.map(async (bucket, w) => {
      if (!bucket.length) return
      const results = await runBatch(pool![w], bucket.map(i => jobs[i]))
      for (let k = 0; k < bucket.length; k++) replies[bucket[k]] = results[k]
    }))
  } catch (error) {
    // 池状态可能已损坏，整体丢弃，让调用方退回串行（结果不受影响）。
    void closePool()
    throw error
  }
  return replies
}

/** 关闭池并释放共享缓冲区，避免句柄悬挂。 */
export async function closePool(): Promise<void> {
  const p = pool
  pool = null
  shared = null
  poolSab = null
  for (const t of timers) clearTimeout(t)
  timers.clear()
  await Promise.all((p ?? []).map(w => w.terminate()))
}
