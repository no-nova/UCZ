import type { CompressionOutput, ProgressCallback } from './compression-queue'

export type WorkerFactory = () => Worker

export function callCodecWorker(factory: WorkerFactory, type: 'run', data: Uint8Array, signal: AbortSignal, progress: ProgressCallback): Promise<CompressionOutput>
export function callCodecWorker(factory: WorkerFactory, type: 'restore', data: Uint8Array, signal: AbortSignal, progress: ProgressCallback): Promise<Uint8Array>
export function callCodecWorker(factory: WorkerFactory, type: 'run' | 'restore', data: Uint8Array, signal: AbortSignal, progress: ProgressCallback): Promise<CompressionOutput | Uint8Array> {
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined
    let settled = false
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
        if (value.type === 'progress') progress(value.msg, value.pct)
        else if (type === 'run' && value.type === 'done') finish(undefined, value)
        else if (type === 'restore' && value.type === 'restored') finish(undefined, value.data)
        else if (value.type === 'aborted') abort()
        else if (value.type === 'error') finish(new Error(value.message || '后台线程失败'))
      }
      worker.onerror = event => { event.preventDefault(); finish(new Error(event.message || '后台线程失败')) }
      worker.onmessageerror = () => finish(new Error('后台线程消息无法读取'))
      if (signal.aborted) { abort(); return }
      const owned = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice()
      worker.postMessage({ type, data: owned }, [owned.buffer as ArrayBuffer])
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
