import type { Compressed } from '../lib/codec'
import type { TruthRegion } from '../lib/samples'
import { MAX_INPUT_BYTES } from '../lib/limits'
import { formatBytes } from './format-bytes'

export interface CompressionOutput {
  data: Uint8Array
  /** 产生这份结果的规划档位（Web GUI 的详情卡片要显示"实际用的档位"）。 */
  level?: 'fast' | 'balanced' | 'max'
  comp: Compressed
  verified: boolean
  tComp: number
  tVer: number
  gzip: number | null
  single: number | null
}

export interface CompressionResult extends CompressionOutput {
  name: string
  truth?: TruthRegion[]
  note?: string
}

export interface CompressionSource {
  name: string
  size: number
  // Queued files are not read into memory until a worker slot is available.
  read: () => Promise<Uint8Array>
  truth?: TruthRegion[]
  note?: string
}

export type TaskStatus = 'queued' | 'reading' | 'running' | 'done' | 'error' | 'cancelled'
export interface CompressionTask {
  id: string
  name: string
  size: number
  status: TaskStatus
  progress: number
  message: string
  steps: string[]
  result?: CompressionResult
}

export interface QueueSnapshot {
  tasks: readonly CompressionTask[]
  concurrency: number
}

export type ProgressCallback = (message: string, percent: number) => void
export type CompressionExecutor = (data: Uint8Array, signal: AbortSignal, progress: ProgressCallback) => Promise<CompressionOutput>

export function isPending(task: CompressionTask): boolean {
  return task.status === 'queued' || task.status === 'reading' || task.status === 'running'
}

export function completedTotals(tasks: readonly CompressionTask[]) {
  const done = tasks.filter(task => task.status === 'done' && task.result?.verified)
  return {
    count: done.length,
    inputBytes: done.reduce((sum, task) => sum + task.size, 0),
    outputBytes: done.reduce((sum, task) => sum + task.result!.comp.container.length, 0),
  }
}

/**
 * P17.2: the UI used to cap this at 2, which left most of a 8/16-core machine
 * idle when compressing many small files. Each task still runs in its own
 * worker with its own model, so raising the cap only changes scheduling — never
 * the bytes any single file produces.
 */
export const MAX_CONCURRENCY = 64
/**
 * P18: the selector now reaches past a single 16-thread desktop so that batch
 * runs on many-core workstations (and the CLI's `--jobs`) never have to be
 * capped by the UI. Each entry is still a plain scheduling limit: one worker
 * and one model per task, so no file's bytes depend on this value.
 */
export const CONCURRENCY_CHOICES: readonly number[] = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]
const boundedConcurrency = (value: number) =>
  Number.isFinite(value) ? Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(value))) : 1

// Scheduling only: each file uses the unchanged codec and its own worker/model.
// There is no concatenation, shared codec state, or change to UCZ wire semantics.
export class CompressionQueue {
  private snapshot: QueueSnapshot
  private sources = new Map<string, CompressionSource>()
  private active = new Map<string, AbortController>()
  private listeners = new Set<() => void>()
  private sequence = 0

  constructor(private execute: CompressionExecutor, concurrency = 2) {
    this.snapshot = { tasks: [], concurrency: boundedConcurrency(concurrency) }
  }

  getSnapshot = (): QueueSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(tasks: readonly CompressionTask[], concurrency = this.snapshot.concurrency) {
    this.snapshot = { tasks, concurrency }
    for (const listener of this.listeners) listener()
  }

  private update(id: string, patch: Partial<CompressionTask>) {
    this.publish(this.snapshot.tasks.map(task => task.id === id ? { ...task, ...patch } : task))
  }

  add(sources: readonly CompressionSource[]): string[] {
    const tasks = sources.map(source => {
      const id = `file-${++this.sequence}`
      let error = ''
      if (!Number.isSafeInteger(source.size) || source.size < 0) error = '文件大小无效。'
      else if (source.size === 0) error = '空文件没有可分析的结构，已跳过。'
      else if (source.size > MAX_INPUT_BYTES) error = `超过单文件上限 ${formatBytes(MAX_INPUT_BYTES)}，未读取或截断。`
      if (!error) this.sources.set(id, source)
      return {
        id, name: source.name, size: source.size,
        status: error ? 'error' as const : 'queued' as const,
        progress: 0, message: error || '排队中…', steps: [],
      }
    })
    this.publish([...this.snapshot.tasks, ...tasks])
    this.pump()
    return tasks.map(task => task.id)
  }

  setConcurrency(value: number) {
    this.publish(this.snapshot.tasks, boundedConcurrency(value))
    this.pump()
  }

  cancel(id: string) {
    if (!this.snapshot.tasks.some(task => task.id === id && isPending(task))) return
    // Worker abort settles its promise AND terminates the thread synchronously.
    this.active.get(id)?.abort()
    this.active.delete(id)
    this.sources.delete(id)
    this.update(id, { status: 'cancelled', message: '已取消，未保留部分结果。' })
    this.pump()
  }

  cancelAll() {
    for (const controller of this.active.values()) controller.abort()
    this.active.clear()
    this.sources.clear()
    this.publish(this.snapshot.tasks.map(task => isPending(task)
      ? { ...task, status: 'cancelled', message: '已取消，未保留部分结果。' }
      : task))
  }

  clearFinished() {
    this.publish(this.snapshot.tasks.filter(isPending))
  }

  private pump() {
    while (this.active.size < this.snapshot.concurrency) {
      const task = this.snapshot.tasks.find(task => task.status === 'queued')
      if (!task) break
      const source = this.sources.get(task.id)
      if (!source) break
      const controller = new AbortController()
      this.active.set(task.id, controller)
      this.update(task.id, { status: 'reading', progress: 1, message: '读取文件…' })
      void this.start(task.id, source, controller)
    }
  }

  private async start(id: string, source: CompressionSource, controller: AbortController) {
    const { signal } = controller
    try {
      const data = await source.read()
      if (signal.aborted) return
      if (data.length !== source.size) throw new Error('读取长度与文件大小不一致，未执行压缩。')
      this.update(id, { status: 'running', progress: 2, message: '启动后台工作线程…' })
      const output = await this.execute(data, signal, (message, percent) => {
        if (signal.aborted) return
        const task = this.snapshot.tasks.find(task => task.id === id)
        if (!task || !isPending(task)) return
        const progress = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : task.progress
        this.update(id, { progress, message, steps: [...task.steps.slice(-199), `${Math.round(progress)}% · ${message}`] })
      })
      if (signal.aborted) return
      if (!output.verified) throw new Error('逐字节解压校验失败，未计入成功结果或提供下载。')
      this.update(id, {
        status: 'done', progress: 100, message: '逐字节校验通过',
        result: { ...output, name: source.name, truth: source.truth, note: source.note },
      })
    } catch (error) {
      if (!signal.aborted) this.update(id, { status: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      this.sources.delete(id)
      if (this.active.get(id) === controller) this.active.delete(id)
      this.pump()
    }
  }
}
