import type { CompressionLevel } from '../lib/codec'
import type { CompressionOutput, ProgressCallback } from './compression-queue'
import { restoreDirect, runDirect } from './codec-direct'

export type WorkerFactory = () => Worker

function inWorker(factory: WorkerFactory, type: 'run' | 'restore', data: Uint8Array, signal: AbortSignal, progress: ProgressCallback, level?: CompressionLevel): Promise<CompressionOutput | Uint8Array> {
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined
    let settled = false
    let gotProgress = false
    const finish = (error?: Error, output?: CompressionOutput | Uint8Array) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      if (worker) {
        worker.onmessage = null
        worker.onerror = null
        worker.onmessageerror = null
        worker.terminate()
      }
      if (error) reject(error)
      else resolve(output!)
    }
    const abort = () => finish(new DOMException('已取消', 'AbortError'))
    if (signal.aborted) { abort(); return }
    try {
      worker = factory()
      signal.addEventListener('abort', abort, { once: true })
      worker.onmessage = event => {
        const value = event.data
        if (settled) return
        if (value.type === 'progress') { gotProgress = true; progress(value.msg, value.pct) }
        else if (type === 'run' && value.type === 'done') finish(undefined, value)
        else if (type === 'restore' && value.type === 'restored') finish(undefined, value.data)
        else if (value.type === 'aborted') abort()
        else if (value.type === 'error') finish(new Error(value.message || '后台线程失败'))
      }
      // A Blob/module Worker can fail to start at all (file://, strict CSP, no
      // module-worker support). That surfaces as `onerror` with no message — the
      // caller must not see "failed / skipped", it must get a real result.
      worker.onerror = event => {
        event.preventDefault()
        const failure = new Error(gotProgress ? (event.message || '后台线程失败') : 'worker-unavailable')
        ;(failure as Error & { workerUnavailable?: boolean }).workerUnavailable = !gotProgress
        finish(failure)
      }
      worker.onmessageerror = () => {
        const failure = new Error(gotProgress ? '后台线程消息无法读取' : 'worker-unavailable')
        ;(failure as Error & { workerUnavailable?: boolean }).workerUnavailable = !gotProgress
        finish(failure)
      }
      if (signal.aborted) { abort(); return }
      // Ownership contract: the caller's `data` buffer is NEVER transferred.
      // The worker gets a private copy, so a failure after `postMessage`
      // (module worker refused by CSP, `file://`, worker crash before the first
      // progress tick) can still be retried on the main thread with intact input.
      // A view that only covers part of its buffer is copied anyway, and copying
      // unconditionally keeps the two cases identical.
      const owned = data.slice()
      worker.postMessage({ type, data: owned, level }, [owned.buffer as ArrayBuffer])
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error))
      // 构造 Worker 就抛错 = 这个环境根本没有 Worker 可用（file://、CSP）。
      ;(e as Error & { workerUnavailable?: boolean }).workerUnavailable = true
      finish(e)
    }
  })
}

export function callCodecWorker(factory: WorkerFactory, type: 'run', data: Uint8Array, signal: AbortSignal, progress: ProgressCallback, options?: { level?: CompressionLevel }): Promise<CompressionOutput>
export function callCodecWorker(factory: WorkerFactory, type: 'restore', data: Uint8Array, signal: AbortSignal, progress: ProgressCallback): Promise<Uint8Array>
export function callCodecWorker(factory: WorkerFactory, type: 'run' | 'restore', data: Uint8Array, signal: AbortSignal, progress: ProgressCallback, options?: { level?: CompressionLevel }): Promise<CompressionOutput | Uint8Array> {
  return inWorker(factory, type, data, signal, progress, options?.level)
}

/**
 * 单文件 HTML 用入口：Worker 起不来时（file://、严格 CSP、不支持 module worker）
 * 在主线程跑同一套代码，产物逐字节一致；真实的编解码错误仍然照原样抛出。
 */
export function callCodecWithFallback(factory: WorkerFactory, type: 'run', data: Uint8Array, signal: AbortSignal, progress: ProgressCallback, options?: { level?: CompressionLevel }): Promise<CompressionOutput>
export function callCodecWithFallback(factory: WorkerFactory, type: 'restore', data: Uint8Array, signal: AbortSignal, progress: ProgressCallback): Promise<Uint8Array>
export function callCodecWithFallback(factory: WorkerFactory, type: 'run' | 'restore', data: Uint8Array, signal: AbortSignal, progress: ProgressCallback, options?: { level?: CompressionLevel }): Promise<CompressionOutput | Uint8Array> {
  const level = options?.level
  const attempt = inWorker(factory, type, data, signal, progress, level) as Promise<CompressionOutput | Uint8Array>
  return attempt.catch((error: unknown): CompressionOutput | Uint8Array | Promise<CompressionOutput> => {
    if (signal.aborted) throw error
    const unavailable = !!(error as { workerUnavailable?: boolean } | undefined)?.workerUnavailable
    if (!unavailable) throw error
    return type === 'run' ? runDirect(data, signal, progress, level) : restoreDirect(data)
  })
}
