import { completedTotals, isPending, type CompressionTask } from '../utils/compression-queue'
import { formatBytes, type SizeUnit } from '../utils/format-bytes'
import { translateProgress } from '../lib/ui-locale'

type Lang = 'en' | 'zh'

const TEXT = {
  zh: {
    aria: '批量压缩结果', heading: '批量任务与结果',
    done: '已完成', running: '处理中', queued: '排队中', failed: '失败 / 跳过', cancelled: '已取消',
    cancelAll: '取消未完成任务', clear: '清除已结束结果',
    inTotal: '成功文件原始合计', outTotal: '成功文件压缩后合计（含容器头）', ratio: '合计压缩率（压缩后 / 原始）',
    file: '文件', raw: '原始大小', out: '压缩后', rate: '压缩率', status: '状态 / 进度', encode: '编码耗时', actions: '操作',
    details: '正在查看详情', detailsIdle: '查看详情', download: '下载 .ucz', cancel: '取消',
    progress: (n: string) => `${n} 压缩进度`, footnote: '每个文件生成独立的 .ucz，不合并为归档。合计只包含校验通过的结果；清除结果可释放其占用的内存。',
    caption: '各文件独立压缩、独立校验，失败或取消的任务不计入合计。',
    labels: { queued: '排队中', reading: '读取中', running: '处理中', done: '完成', error: '失败 / 跳过', cancelled: '已取消' } as Record<string, string>,
  },
  en: {
    aria: 'Batch compression results', heading: 'Batch tasks & results',
    done: 'completed', running: 'running', queued: 'queued', failed: 'failed / skipped', cancelled: 'cancelled',
    cancelAll: 'Cancel pending', clear: 'Clear finished',
    inTotal: 'Raw size of succeeded files', outTotal: 'Compressed size, incl. container header', ratio: 'Overall ratio (compressed / raw)',
    file: 'File', raw: 'Raw', out: 'Compressed', rate: 'Ratio', status: 'Status / progress', encode: 'Encode', actions: 'Actions',
    details: 'Viewing details', detailsIdle: 'Details', download: 'Download .ucz', cancel: 'Cancel',
    progress: (n: string) => `${n} compression progress`, footnote: 'Every file produces its own .ucz; nothing is merged into an archive. Totals count verified results only; clearing frees their memory.',
    caption: 'Each file is compressed and verified independently; failed or cancelled tasks are excluded from the totals.',
    labels: { queued: 'queued', reading: 'reading', running: 'running', done: 'done', error: 'failed / skipped', cancelled: 'cancelled' } as Record<string, string>,
  },
} as const

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
  lang?: Lang
}

export function BatchResults({ tasks, unit, selectedId, locked, onSelect, onCancel, onCancelAll, onClear, onDownload, lang = 'zh' }: Props) {
  const text = TEXT[lang]
  if (!tasks.length) return null
  const totals = completedTotals(tasks)
  const running = tasks.filter(task => task.status === 'reading' || task.status === 'running').length
  const queued = tasks.filter(task => task.status === 'queued').length
  const failed = tasks.filter(task => task.status === 'error').length
  const cancelled = tasks.filter(task => task.status === 'cancelled').length
  const pending = running + queued
  const labels = text.labels
  const size = (bytes: number) => formatBytes(bytes, unit)

  return <section aria-label={text.aria} className="mt-6 rounded-2xl border border-white/10 bg-white/[0.035] p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold text-white">{text.heading}</h2>
        <p role="status" className="mt-1 text-xs text-slate-400">
          {totals.count} / {tasks.length} {text.done} · {running} {text.running} · {queued} {text.queued}
          {failed > 0 && ` · ${failed} ${text.failed}`}{cancelled > 0 && ` · ${cancelled} ${text.cancelled}`}
        </p>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <button disabled={!pending} onClick={onCancelAll} className="rounded-lg border border-rose-300/30 px-3 py-2 text-rose-200 hover:bg-rose-300/10 disabled:opacity-40">{text.cancelAll}</button>
        <button disabled={locked || !tasks.some(task => !isPending(task))} onClick={onClear} className="rounded-lg border border-white/20 px-3 py-2 text-slate-300 hover:bg-white/10 disabled:opacity-40">{text.clear}</button>
      </div>
    </div>

    <div className="mt-4 grid gap-3 sm:grid-cols-3">
      <div className="rounded-xl bg-black/20 p-3">
        <p className="text-xs text-slate-400">{text.inTotal}</p>
        <p data-testid="batch-input-bytes" title={formatBytes(totals.inputBytes)} className="mt-1 break-words font-semibold tabular-nums text-white">{size(totals.inputBytes)}</p>
      </div>
      <div className="rounded-xl bg-black/20 p-3">
        <p className="text-xs text-slate-400">{text.outTotal}</p>
        <p data-testid="batch-output-bytes" title={formatBytes(totals.outputBytes)} className="mt-1 break-words font-semibold tabular-nums text-cyan-200">{size(totals.outputBytes)}</p>
      </div>
      <div className="rounded-xl bg-black/20 p-3">
        <p className="text-xs text-slate-400">{text.ratio}</p>
        <p className="mt-1 font-semibold tabular-nums text-white">{totals.inputBytes ? `${(totals.outputBytes / totals.inputBytes * 100).toFixed(2)}%` : '—'}</p>
      </div>
    </div>

    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[940px] text-left text-xs">
        <caption className="sr-only">{text.caption}</caption>
        <thead className="border-b border-white/10 text-slate-400">
          <tr>
            <th scope="col" className="py-3 pr-4 font-medium">{text.file}</th>
            <th scope="col" className="px-3 text-right font-medium">{text.raw}</th>
            <th scope="col" className="px-3 text-right font-medium">{text.out}</th>
            <th scope="col" className="px-3 text-right font-medium">{text.rate}</th>
            <th scope="col" className="px-3 font-medium">{text.status}</th>
            <th scope="col" className="px-3 text-right font-medium">{text.encode}</th>
            <th scope="col" className="pl-3 font-medium">{text.actions}</th>
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
              {isPending(task) && <div role="progressbar" aria-label={text.progress(task.name)} aria-valuenow={Math.round(task.progress)} aria-valuemin={0} aria-valuemax={100} className="mt-2 h-1 overflow-hidden rounded bg-white/10">
                <div className="h-full bg-cyan-300 transition-all" style={{ width: `${task.progress}%` }} />
              </div>}
              {task.message && <p className={`mt-1 break-words leading-relaxed ${task.status === 'error' ? 'text-rose-300' : 'text-slate-500'}`}>{lang === 'en' ? translateProgress(task.message) : task.message}</p>}
            </td>
            <td className="whitespace-nowrap px-3 py-4 text-right align-top tabular-nums">{output ? `${Math.round(output.tComp)} ms` : '—'}</td>
            <td className="py-4 pl-3 align-top">
              <div className="flex flex-col items-start gap-2 whitespace-nowrap">
                {output && <>
                  <button disabled={locked} aria-pressed={task.id === selectedId} onClick={() => onSelect(task.id)} className="text-cyan-200 underline-offset-4 hover:underline disabled:opacity-40">{task.id === selectedId ? text.details : text.detailsIdle}</button>
                  <button onClick={() => onDownload(task)} className="text-slate-200 underline-offset-4 hover:underline">{text.download}</button>
                </>}
                {isPending(task) && <button onClick={() => onCancel(task.id)} aria-label={`${text.cancel} ${task.name}`} className="text-rose-200 underline-offset-4 hover:underline">{text.cancel}</button>}
              </div>
            </td>
          </tr>
        })}</tbody>
      </table>
    </div>
    <p className="mt-3 text-xs leading-relaxed text-slate-500">{text.footnote}</p>
  </section>
}
