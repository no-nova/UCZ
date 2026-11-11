// worker 线程入口：从 SharedArrayBuffer 取语料，执行主线程派来的任务。
//
// 这里刻意保持极薄的依赖（只引 parallel-jobs），因为 worker 会被单独打包成
// 一段源码字符串（见 parallel-pool.ts），打包体积与启动开销都要尽量小。
import { parentPort, workerData } from 'node:worker_threads'
import { runJob } from './parallel-jobs'
import type { JobPayload } from './parallel'

const sab = (workerData as { sab: SharedArrayBuffer }).sab
const data = new Uint8Array(sab)

if (!parentPort) throw new Error('parallel-worker 必须在 worker 线程中运行')
const port = parentPort

port.on('message', async (payload: JobPayload) => {
  try {
    const reply = await runJob(payload, data)
    port.postMessage(reply)
  } catch (error) {
    // 用带 error 字段的回复而不是让线程崩溃，主线程可以给出可读的错误。
    port.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
})
