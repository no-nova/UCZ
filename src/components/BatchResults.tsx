import { completedTotals, isPending, type CompressionTask } from '../utils/compression-queue'
import { formatBytes, type SizeUnit } from '../utils/format-bytes'

interface Props {
  tasks: readonly CompressionTask[]
  unit: SizeUnit
  selectedId?: string
  locked: boolean
  onSelect: (id: string) => void
  onCancel: (id: string) => void
  onCancelAll: () => void
  onClear: () => void
  onDownload: (task: CompressionTask) => void
}

export function BatchResults({ tasks, unit, selectedId, locked, onSelect, onCancel, onCancelAll, onClear, onDownload }: Props) {
  if (!tasks.length) return null
  const totals = completedTotals(tasks)
  const running = tasks.filter(task => task.status === 'reading' || task.status === 'running').length
  const queued = tasks.filter(task => task.status === 'queued').length
  const failed = tasks.filter(task => task.status === 'error').length
  const cancelled = tasks.filter(task => task.status === 'cancelled').length
  const pending = running + queued
  const labels = { queued: '排队中', reading: '读取中', running: '处理中', done: '完成', error: '失败 / 跳过', cancelled: '已取消' }
  const size = (bytes: number) => formatBytes(bytes, unit)

  return <section aria-label="批量压缩结果" className="mt-6 rounded-2xl border border-white/10 bg-white/[0.035] p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold text-white">批量任务与结果</h2>
        <p role="status" className="mt-1 text-xs text-slate-400">
          {totals.count} / {tasks.length} 已完成 · {running} 处理中 · {queued} 排队中
          {failed > 0 && ` · ${failed} 失败 / 跳过`}{cancelled > 0 && ` · ${cancelled} 已取消`}
        </p>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <button disabled={!pending} onClick={onCancelAll} className="rounded-lg border border-rose-300/30 px-3 py-2 text-rose-200 hover:bg-rose-300/10 disabled:opacity-40">取消未完成任务</button>
        <button disabled={locked || !tasks.some(task => !isPending(task))} onClick={onClear} className="rounded-lg border border-white/20 px-3 py-2 text-slate-300 hover:bg-white/10 disabled:opacity-40">清除已结束结果</button>
      </div>
    </div>

    <div className="mt-4 grid gap-3 sm:grid-cols-3">
      <div className="rounded-xl bg-black/20 p-3">
        <p className="text-xs text-slate-400">成功文件原始合计</p>
        <p data-testid="batch-input-bytes" title={formatBytes(totals.inputBytes)} className="mt-1 break-words font-semibold tabular-nums text-white">{size(totals.inputBytes)}</p>
      </div>
      <div className="rounded-xl bg-black/20 p-3">
        <p className="text-xs text-slate-400">成功文件压缩后合计（含容器头）</p>
        <p data-testid="batch-output-bytes" title={formatBytes(totals.outputBytes)} className="mt-1 break-words font-semibold tabular-nums text-cyan-200">{size(totals.outputBytes)}</p>
      </div>
      <div className="rounded-xl bg-black/20 p-3">
        <p className="text-xs text-slate-400">合计压缩率（压缩后 / 原始）</p>
        <p className="mt-1 font-semibold tabular-nums text-white">{totals.inputBytes ? `${(totals.outputBytes / totals.inputBytes * 100).toFixed(2)}%` : '—'}</p>
      </div>
    </div>

    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[940px] text-left text-xs">
        <caption className="sr-only">各文件独立压缩、独立校验，失败或取消的任务不计入合计。</caption>
        <thead className="border-b border-white/10 text-slate-400">
          <tr>
            <th scope="col" className="py-3 pr-4 font-medium">文件</th>
            <th scope="col" className="px-3 text-right font-medium">原始大小</th>
            <th scope="col" className="px-3 text-right font-medium">压缩后</th>
            <th scope="col" className="px-3 text-right font-medium">压缩率</th>
            <th scope="col" className="px-3 font-medium">状态 / 进度</th>
            <th scope="col" className="px-3 text-right font-medium">编码耗时</th>
            <th scope="col" className="pl-3 font-medium">操作</th>
          </tr>
        </thead>
        <tbody>{tasks.map((task, index) => {
          const output = task.result
          return <tr key={task.id} data-task-id={task.id} className={`border-b border-white/5 ${task.id === selectedId ? 'bg-cyan-300/[0.06]' : ''}`}>
            <th scope="row" className="max-w-60 py-4 pr-4 align-top font-normal">
              <span className="mr-2 text-slate-500">{index + 1}.</span><span className="break-all text-slate-100">{task.name}</span>
            </th>
            <td title={formatBytes(task.size)} className="whitespace-nowrap px-3 py-4 text-right align-top tabular-nums text-slate-300">{size(task.size)}</td>
            <td title={output && formatBytes(output.comp.container.length)} className="whitespace-nowrap px-3 py-4 text-right align-top tabular-nums text-cyan-200">{output ? size(output.comp.container.length) : '—'}</td>
            <td className="whitespace-nowrap px-3 py-4 text-right align-top tabular-nums">{output ? `${(output.comp.container.length / task.size * 100).toFixed(2)}%` : '—'}</td>
            <td className="min-w-48 max-w-64 px-3 py-4 align-top">
              <span className={task.status === 'done' ? 'text-emerald-300' : task.status === 'error' ? 'text-rose-200' : 'text-slate-300'}>
                {labels[task.status]}{(task.status === 'running' || task.status === 'reading') && ` · ${Math.round(task.progress)}%`}
              </span>
              {isPending(task) && <div role="progressbar" aria-label={`${task.name} 压缩进度`} aria-valuenow={Math.round(task.progress)} aria-valuemin={0} aria-valuemax={100} className="mt-2 h-1 overflow-hidden rounded bg-white/10">
                <div className="h-full bg-cyan-300 transition-all" style={{ width: `${task.progress}%` }} />
              </div>}
              <p className="mt-1 break-words leading-relaxed text-slate-500">{task.message}</p>
            </td>
            <td className="whitespace-nowrap px-3 py-4 text-right align-top tabular-nums">{output ? `${Math.round(output.tComp)} ms` : '—'}</td>
            <td className="py-4 pl-3 align-top">
              <div className="flex flex-col items-start gap-2 whitespace-nowrap">
                {output && <>
                  <button disabled={locked} aria-pressed={task.id === selectedId} onClick={() => onSelect(task.id)} className="text-cyan-200 underline-offset-4 hover:underline disabled:opacity-40">{task.id === selectedId ? '正在查看详情' : '查看详情'}</button>
                  <button onClick={() => onDownload(task)} className="text-slate-200 underline-offset-4 hover:underline">下载 .ucz</button>
                </>}
                {isPending(task) && <button onClick={() => onCancel(task.id)} aria-label={`取消 ${task.name}`} className="text-rose-200 underline-offset-4 hover:underline">取消</button>}
              </div>
            </td>
          </tr>
        })}</tbody>
      </table>
    </div>
    <p className="mt-3 text-xs leading-relaxed text-slate-500">每个文件生成独立的 .ucz，不合并为归档。合计只包含校验通过的结果；清除结果可释放其占用的内存。</p>
  </section>
}
