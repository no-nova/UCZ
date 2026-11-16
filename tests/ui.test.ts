import test from 'node:test'
import { fastDeepEqual } from './fast-equal'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CompressionQueue, MAX_CONCURRENCY, completedTotals, type CompressionOutput, type CompressionSource } from '../src/utils/compression-queue'
import { callCodecWithFallback, callCodecWorker } from '../src/utils/codec-worker-client'
import { formatBytes } from '../src/utils/format-bytes'
import { BatchResults } from '../src/components/BatchResults'
import { MAX_INPUT_BYTES } from '../src/lib/limits'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function output(data: Uint8Array, bytes = 7, verified = true): CompressionOutput {
  return { data, comp: { container: new Uint8Array(bytes) } as CompressionOutput['comp'], verified, tComp: 12, tVer: 3, gzip: null, single: null }
}
function source(name: string, byte = 1, size = 10): CompressionSource {
  return { name, size, read: async () => new Uint8Array(size).fill(byte) }
}

test('B display keeps every integer digit, including totals above 32 bits', () => {
  for (const [bytes, expected] of [[0, '0 B'], [1023, '1,023 B'], [1024, '1,024 B'], [1048575, '1,048,575 B'], [40233692, '40,233,692 B'], [4294967296, '4,294,967,296 B'], [-1234, '-1,234 B']] as const) assert.equal(formatBytes(bytes), expected)
  assert.equal(formatBytes(1024, 'auto'), '1.0 KiB')
  assert.equal(formatBytes(1048576, 'auto'), '1.00 MiB')
  assert.equal(formatBytes(1073741824, 'auto'), '1.00 GiB')
  assert.equal(formatBytes(NaN), '—')
})

test('two files run concurrently, a third stays unread, duplicate names keep separate results', async () => {
  const pending: { data: Uint8Array; job: ReturnType<typeof deferred<CompressionOutput>> }[] = []
  const queue = new CompressionQueue(async data => {
    const job = deferred<CompressionOutput>(); pending.push({ data, job }); return job.promise
  }, 2)
  const reads: number[] = []
  const ids = queue.add([1, 2, 3].map(n => ({ name: 'same.bin', size: 10, read: async () => { reads.push(n); return new Uint8Array(10).fill(n) } })))
  await flush()
  assert.equal(new Set(ids).size, 3)
  fastDeepEqual(reads, [1, 2]); assert.equal(pending.length, 2)
  pending[1].job.resolve(output(pending[1].data, 5))
  await flush()
  fastDeepEqual(reads, [1, 2, 3]); assert.equal(pending.length, 3)
  fastDeepEqual(queue.getSnapshot().tasks.map(t => t.status), ['running', 'done', 'running'])
  pending[0].job.resolve(output(pending[0].data)); pending[2].job.resolve(output(pending[2].data))
  await flush()
  fastDeepEqual(queue.getSnapshot().tasks.map(t => t.result?.data[0]), [1, 2, 3])
  fastDeepEqual(completedTotals(queue.getSnapshot().tasks), { count: 3, inputBytes: 30, outputBytes: 19 })
})

test('one read failure or failed verification does not stop other files or inflate totals', async () => {
  const queue = new CompressionQueue(async data => output(data, 4, data[0] !== 2))
  queue.add([{ ...source('bad read'), read: async () => { throw new Error('读取失败') } }, source('bad verify', 2), source('good', 3)])
  await flush()
  fastDeepEqual(queue.getSnapshot().tasks.map(t => t.status), ['error', 'error', 'done'])
  assert.equal(queue.getSnapshot().tasks[1].result, undefined)
  fastDeepEqual(completedTotals(queue.getSnapshot().tasks), { count: 1, inputBytes: 10, outputBytes: 4 })
})

test('zero, oversized and invalid file sizes are rejected without reading or blocking valid files', async () => {
  let invalidReads = 0, executions = 0
  const queue = new CompressionQueue(async data => { executions++; return output(data) })
  queue.add([0, MAX_INPUT_BYTES + 1, -1, NaN].map(size => ({ name: String(size), size, read: async () => { invalidReads++; return new Uint8Array() } })))
  queue.add([source('valid')]); await flush()
  assert.equal(invalidReads, 0); assert.equal(executions, 1)
  fastDeepEqual(queue.getSnapshot().tasks.map(t => t.status), ['error', 'error', 'error', 'error', 'done'])
})

test('a read-size mismatch never reaches the codec', async () => {
  let executions = 0
  const queue = new CompressionQueue(async data => { executions++; return output(data) })
  queue.add([{ name: 'changed.bin', size: 12, read: async () => new Uint8Array(11) }]); await flush()
  assert.equal(executions, 0); assert.equal(queue.getSnapshot().tasks[0].status, 'error')
})

test('cancel during a pending read never starts its worker; the next file can start immediately', async () => {
  const read = deferred<Uint8Array>(), executed: number[] = []
  const queue = new CompressionQueue(async data => { executed.push(data[0]); return output(data) }, 1)
  const [id] = queue.add([{ name: 'slow-read', size: 10, read: () => read.promise }, source('next', 2)])
  queue.cancel(id); await flush()
  read.resolve(new Uint8Array(10).fill(1)); await flush()
  fastDeepEqual(executed, [2]); fastDeepEqual(queue.getSnapshot().tasks.map(t => t.status), ['cancelled', 'done'])
})

test('cancelled queued files are not read; cancel-all preserves completed output and settles active work', async () => {
  const job = deferred<CompressionOutput>()
  let unread = true, aborted = false
  const queue = new CompressionQueue(async (data, signal) => {
    if (data[0] === 1) return output(data)
    signal.addEventListener('abort', () => { aborted = true; job.reject(new Error('aborted')) }, { once: true })
    return job.promise
  }, 1)
  const ids = queue.add([source('done', 1), source('active', 2), { ...source('queued'), read: async () => { unread = false; return new Uint8Array(10) } }])
  await flush(); queue.cancel(ids[2]); queue.cancelAll(); await flush()
  assert.equal(unread, true); assert.equal(aborted, true)
  fastDeepEqual(queue.getSnapshot().tasks.map(t => t.status), ['done', 'cancelled', 'cancelled'])
  assert.equal(completedTotals(queue.getSnapshot().tasks).count, 1)
})

test('appending after cancel-all is not overwritten by an old completion; finished results can be released', async () => {
  const old = deferred<CompressionOutput>()
  const queue = new CompressionQueue(async data => data[0] === 1 ? old.promise : output(data), 1)
  queue.add([source('old', 1)]); await flush()
  queue.cancelAll(); queue.add([source('new', 2)]); await flush()
  old.resolve(output(new Uint8Array(10).fill(1))); await flush()
  fastDeepEqual(queue.getSnapshot().tasks.map(t => t.status), ['cancelled', 'done'])
  queue.clearFinished(); assert.equal(queue.getSnapshot().tasks.length, 0)
  queue.add([source('reuse', 3)]); await flush(); assert.equal(queue.getSnapshot().tasks[0].status, 'done')
})

test('progress and logs are per-file, bounded to 200 entries, and stale progress cannot revive a cancelled task', async () => {
  let report!: (message: string, percent: number) => void
  const pending = deferred<CompressionOutput>()
  const queue = new CompressionQueue(async (_data, _signal, progress) => { report = progress; return pending.promise })
  const [id] = queue.add([source('progress')]); await flush()
  for (let i = 0; i < 205; i++) report(String(i), i)
  assert.equal(queue.getSnapshot().tasks[0].steps.length, 200)
  assert.equal(queue.getSnapshot().tasks[0].progress, 100)
  queue.cancel(id); report('late message', 99); pending.resolve(output(new Uint8Array(10))); await flush()
  assert.equal(queue.getSnapshot().tasks[0].status, 'cancelled')
  assert.notEqual(queue.getSnapshot().tasks[0].message, 'late message')
})

test('concurrency is bounded and increasing it starts queued files without eager reads', async () => {
  const pending = deferred<CompressionOutput>()
  let executions = 0, notifications = 0
  const queue = new CompressionQueue(async () => { executions++; return pending.promise }, NaN)
  const unsubscribe = queue.subscribe(() => { notifications++ })
  queue.add([source('one'), source('two'), source('three')]); await flush(); assert.equal(executions, 1)
  // P17.2: the cap moved from 2 to MAX_CONCURRENCY so an 8/16-core machine is no
  // longer left idle. Over-large values are still clamped, and raising the limit
  // still starts queued files (both halves of the original assertion).
  queue.setConcurrency(99); await flush(); assert.equal(executions, 3); assert.equal(queue.getSnapshot().concurrency, MAX_CONCURRENCY)
  queue.setConcurrency(2); assert.equal(queue.getSnapshot().concurrency, 2)
  queue.setConcurrency(0); assert.equal(queue.getSnapshot().concurrency, 1)
  queue.clearFinished(); assert.equal(queue.getSnapshot().tasks.length, 3)
  const count = notifications; unsubscribe(); queue.cancelAll(); assert.equal(notifications, count)
  pending.resolve(output(new Uint8Array(10))); await flush()
})

class FakeWorker {
  onmessage: ((event: any) => void) | null = null
  onerror: ((event: any) => void) | null = null
  onmessageerror: ((event: any) => void) | null = null
  messages: any[] = []
  terminated = 0
  failPost = false
  postMessage(message: any, transfers: any) { if (this.failPost) throw new Error('post failed'); this.messages.push({ message, transfers }) }
  terminate() { this.terminated++ }
  emit(data: any) { this.onmessage?.({ data }) }
  asWorker() { return this as unknown as Worker }
}

test('worker client supports separate compression/restore requests, transfers only the owned view, and cleans handlers', async () => {
  const worker = new FakeWorker(), controller = new AbortController(), values: number[] = []
  const view = new Uint8Array([8, 1, 2, 9]).subarray(1, 3)
  const result = callCodecWorker(() => worker.asWorker(), 'run', view, controller.signal, (_message, percent) => values.push(percent))
  assert.equal(worker.messages[0].message.data.length, 2)
  assert.notEqual(worker.messages[0].message.data.buffer, view.buffer)
  worker.emit({ type: 'progress', msg: 'running', pct: 10 })
  worker.emit({ type: 'done', ...output(view) })
  assert.equal((await result).verified, true); fastDeepEqual(values, [10]); assert.equal(worker.terminated, 1)
  assert.equal(worker.onmessage, null); assert.equal(worker.onerror, null)
  controller.abort(); assert.equal(worker.terminated, 1)
  const restoreWorker = new FakeWorker()
  const restored = callCodecWorker(() => restoreWorker.asWorker(), 'restore', new Uint8Array([1]), new AbortController().signal, () => {})
  restoreWorker.emit({ type: 'restored', data: new Uint8Array([5, 6]) })
  fastDeepEqual(await restored, new Uint8Array([5, 6])); assert.equal(restoreWorker.terminated, 1)
})

test('inputs are copied, never transferred: a worker that dies after postMessage still leaves the input intact', async () => {
  const data = new Uint8Array(4096)
  for (let i = 0; i < data.length; i++) data[i] = (i * 17 + (i >> 3)) & 0xff
  const view = data.subarray(0, data.length)   // full view: the old code transferred this buffer
  let transferred = 0
  const fake = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null as ((event: { message: string; preventDefault(): void }) => void) | null,
    onmessageerror: null as (() => void) | null,
    postMessage(message: { data: Uint8Array }) {
      // Real transferable semantics: this detaches the sender's buffer.
      structuredClone(message.data, { transfer: [message.data.buffer] })
      transferred++
    },
    terminate() {},
  }
  const promise = callCodecWithFallback(() => fake as unknown as Worker, 'run', view, new AbortController().signal, () => {}, { level: 'fast' })
  fake.onerror?.({ message: 'worker-unavailable', preventDefault() {} })
  const out = await promise
  assert.equal(transferred, 1)
  assert.equal(view.length, data.length, 'caller buffer must not be detached')
  assert.equal(data.length, 4096)
  assert.equal(out.verified, true)
  fastDeepEqual(data, new Uint8Array([...data]))
})

test('main-thread fallback still compresses when no Worker can start (single-file builds)', async () => {
  const data = new Uint8Array(8192)
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 4)) & 0xff
  const out = await callCodecWithFallback(() => { throw new Error('construction failed') }, 'run', data, new AbortController().signal, () => {}, { level: 'fast' })
  assert.equal(out.verified, true)
  assert.ok(out.comp.container.length < data.length)
  const back = await callCodecWithFallback(() => { throw new Error('construction failed') }, 'restore', out.comp.container, new AbortController().signal, () => {})
  fastDeepEqual(back, data)
})

test('worker cancellation rejects instead of leaving an unresolved promise and ignores late messages', async () => {
  const worker = new FakeWorker(), controller = new AbortController()
  const result = callCodecWorker(() => worker.asWorker(), 'run', new Uint8Array(2), controller.signal, () => {})
  const late = worker.onmessage
  const rejection = assert.rejects(result, { name: 'AbortError' })
  controller.abort(); await rejection
  late?.({ data: { type: 'done', ...output(new Uint8Array(2)) } })
  assert.equal(worker.terminated, 1)
  let created = false
  await assert.rejects(callCodecWorker(() => { created = true; return worker.asWorker() }, 'restore', new Uint8Array(), controller.signal, () => {}), { name: 'AbortError' })
  assert.equal(created, false)
})

test('worker errors, unreadable messages, constructor and postMessage failures all reject and release resources', async () => {
  for (const failure of ['error', 'crash', 'message', 'post']) {
    const worker = new FakeWorker(); worker.failPost = failure === 'post'
    const promise = callCodecWorker(() => worker.asWorker(), 'run', new Uint8Array(2), new AbortController().signal, () => {})
    const rejected = assert.rejects(promise)
    if (failure === 'error') worker.emit({ type: 'error', message: 'codec failed' })
    if (failure === 'crash') worker.onerror?.({ message: 'worker failed', preventDefault() {} })
    if (failure === 'message') worker.onmessageerror?.({})
    await rejected; assert.equal(worker.terminated, 1); assert.equal(worker.onmessage, null)
  }
  await assert.rejects(callCodecWorker(() => { throw new Error('construction failed') }, 'run', new Uint8Array(), new AbortController().signal, () => {}), /construction failed/)
})

test('result table renders complete B values, verified-only totals, file-specific actions and escaped names', async () => {
  const queue = new CompressionQueue(async data => output(data, 1234))
  queue.add([source('<script>.bin', 1, 2048), { name: 'empty', size: 0, read: async () => new Uint8Array() }]); await flush()
  const props = { tasks: queue.getSnapshot().tasks, unit: 'bytes' as const, locked: false, onSelect() {}, onCancel() {}, onCancelAll() {}, onClear() {}, onDownload() {} }
  const html = renderToStaticMarkup(createElement(BatchResults, props))
  assert.match(html, /2,048 B/); assert.match(html, /1,234 B/); assert.match(html, /60\.25%/)
  assert.match(html, /&lt;script&gt;\.bin/); assert.doesNotMatch(html, /<script>/)
  assert.match(html, /下载 \.ucz/); assert.match(html, /失败 \/ 跳过/)
  const automatic = renderToStaticMarkup(createElement(BatchResults, { ...props, unit: 'auto' }))
  assert.match(automatic, /2\.0 KiB/); assert.match(automatic, /title="2,048 B"/)
})
