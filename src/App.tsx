import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { BLOCK, CLS_NAME } from './lib/analyze'
import { MAX_INPUT_BYTES, MAX_SINGLE_CM_BYTES } from './lib/limits'
import CodecWorker from './lib/compress.worker?worker&inline'
import { CODECS, type Compressed } from './lib/codec'
import { V20_FLAG_CM, V20_FLAG_TRANSFORMS, V22_FLAG_MATCH_DISTANCE } from './lib/coder'
import { V21_FLAG_CONTEXTS } from './lib/context-policy'
import { SAMPLES, type TruthRegion } from './lib/samples'
import { buildMapModel, hexToRgb } from './lib/viz'
import { DigramView, HilbertView, IsoView, PcaView } from './components/Views'
import { BatchResults } from './components/BatchResults'
import { CompressionQueue, CONCURRENCY_CHOICES, isPending, type CompressionResult as Result } from './utils/compression-queue'
import { callCodecWorker } from './utils/codec-worker-client'
import { formatBytes, type SizeUnit } from './utils/format-bytes'
import { VERSION } from './version'

interface BenchmarkResult { label: string; size?: number; encodeMs?: number; ms?: number; verified?: boolean; error?: string }

const createCodecWorker = () => new CodecWorker()

function initialConcurrency() {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  return navigator.hardwareConcurrency === 1 || (memory !== undefined && memory < 4) ? 1 : 2
}

function download(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function Card(props: { title: string; sub?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={'rounded-2xl border border-white/10 bg-white/[0.035] p-5 backdrop-blur ' + (props.className ?? '')}>
      <h3 className="text-base font-semibold text-white">{props.title}</h3>
      {props.sub && <p className="mt-1 mb-3 text-xs leading-relaxed text-slate-400">{props.sub}</p>}
      {!props.sub && <div className="h-3" />}
      {props.children}
    </section>
  )
}

export default function App() {
  const [queue] = useState(() => new CompressionQueue(
    (data, signal, progress) => callCodecWorker(createCodecWorker, 'run', data, signal, progress),
    initialConcurrency(),
  ))
  const { tasks, concurrency } = useSyncExternalStore(queue.subscribe, queue.getSnapshot)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedTask = tasks.find(task => task.id === selectedId && task.result) ?? tasks.find(task => task.result)
  const res = selectedTask?.result ?? null
  const steps = selectedTask?.steps ?? []
  const busy = tasks.some(isPending)
  const [sizeUnit, setSizeUnit] = useState<SizeUnit>('bytes')
  const fmt = (bytes: number) => formatBytes(bytes, sizeUnit)
  const [stage, setStage] = useState<{ msg: string; pct: number } | null>(null)
  const [sel, setSel] = useState(-1)
  const [tablePage, setTablePage] = useState(0)
  const [mode, setMode] = useState<'entropy' | 'cost'>('cost')
  const [msg, setMsg] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const [bench, setBench] = useState<BenchmarkResult[]>([])
  const [benchBusy, setBenchBusy] = useState(false)
  const [benchError, setBenchError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const uczRef = useRef<HTMLInputElement>(null)
  const restoreRef = useRef<AbortController | null>(null)
  const benchRef = useRef<AbortController | null>(null)

  // Select the first completed file once; later completions do not steal focus.
  useEffect(() => {
    setSelectedId(selectedTask?.id ?? null)
  }, [selectedTask?.id])
  useEffect(() => {
    setSel(-1); setTablePage(0); setBench([]); setBenchError(null)
  }, [selectedTask?.id])
  useEffect(() => () => {
    queue.cancelAll()
    restoreRef.current?.abort()
    benchRef.current?.abort()
  }, [queue])

  function cancelRun() {
    restoreRef.current?.abort()
    restoreRef.current = null
    setStage(null)
    setMsg('已取消还原任务。')
  }

  function run(name: string, data: Uint8Array, truth?: TruthRegion[], note?: string) {
    if (benchBusy || restoreRef.current) { setMsg('请等待还原或外部对照任务完成。'); return }
    setMsg(null)
    queue.add([{ name, size: data.length, read: async () => data, truth, note }])
  }

  function onFiles(files: FileList | null) {
    if (!files?.length) return
    if (restoreRef.current || benchBusy) { setMsg('请等待还原或外部对照任务完成。'); return }
    setMsg(null)
    queue.add(Array.from(files, file => ({
      name: file.name, size: file.size,
      read: async () => new Uint8Array(await file.arrayBuffer()),
    })))
  }

  async function runBench() {
    if (!res || benchBusy || busy || stage) return
    const controller = new AbortController()
    benchRef.current = controller
    setBenchBusy(true); setBenchError(null); setBench([])
    try {
      const response = await fetch('/api/bench', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-UCZ-Benchmark': 'yes' }, body: res.data as unknown as BodyInit, signal: controller.signal })
      if (!response.ok) throw new Error(`服务返回 HTTP ${response.status}`)
      const value = await response.json() as { results: BenchmarkResult[] }
      if (!controller.signal.aborted) setBench(value.results)
    } catch (error) {
      if (!controller.signal.aborted) setBenchError(`对照服务不可用：${error instanceof Error ? error.message : String(error)}。请启动 npm run benchmark。`)
    } finally {
      if (benchRef.current === controller) { benchRef.current = null; setBenchBusy(false) }
    }
  }

  async function restore(read: () => Promise<Uint8Array>, name: string) {
    if (busy || benchBusy || restoreRef.current) return
    const controller = new AbortController()
    restoreRef.current = controller
    setMsg(null)
    setStage({ msg: '后台解压中…', pct: 0 })
    try {
      const data = await read()
      const out = await callCodecWorker(createCodecWorker, 'restore', data, controller.signal,
        (msg, pct) => { if (!controller.signal.aborted) setStage({ msg, pct }) })
      if (!controller.signal.aborted) {
        download(out, name)
        setMsg(`已还原 ${fmt(out.length)}，文件已下载。`)
      }
    } catch (error) {
      if (!controller.signal.aborted) setMsg('还原失败：' + (error instanceof Error ? error.message : String(error)))
    } finally {
      if (restoreRef.current === controller) { restoreRef.current = null; setStage(null) }
    }
  }

  function onRestore(file: File | undefined | null) {
    if (file) void restore(async () => new Uint8Array(await file.arrayBuffer()), file.name.replace(/\.ucz$/i, '') + '.restored')
  }

  function downloadRestored() {
    if (res) void restore(async () => res.comp.container.slice(), res.name)
  }

  const colors = useMemo(() => (res ? res.comp.segs.map((s) => hexToRgb(CODECS[s.spec.id].color)) : []), [res])
  const entropyVal = useMemo(() => (res ? Float32Array.from(res.comp.analysis.blocks.map((b) => b.h0)) : null), [res])
  const mapEntropy = useMemo(
    () => (res && entropyVal ? buildMapModel(res.data, BLOCK, entropyVal, res.comp.blockSeg) : null),
    [res, entropyVal],
  )
  const mapCost = useMemo(
    () => (res ? buildMapModel(res.data, BLOCK, res.comp.blockCost, res.comp.blockSeg) : null),
    [res],
  )
  const usedCodecs = useMemo(() => (res ? [...new Set(res.comp.segs.map((s) => s.spec.id))] : []), [res])

  const total = res?.data.length ?? 0
  const csize = res?.comp.container.length ?? 0

  return (
    <div className="topo min-h-screen bg-[#070b14] text-slate-200">
      <div className="mx-auto max-w-6xl px-4 pb-24 pt-10 sm:px-6">
        {/* ===== Hero ===== */}
        <header className="mb-8">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1 text-xs text-cyan-200">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300" />
            通用 · 自适应 · 无损
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-white sm:text-5xl">
            UCZ <span className="bg-gradient-to-r from-cyan-300 via-amber-200 to-rose-300 bg-clip-text text-transparent">Universal Adaptive Compression</span>
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-relaxed text-slate-400 sm:text-base">
            不问“这是什么文件”,只问“这一段字节长什么样”。任何输入先变成字节流,折叠成一张<b className="text-slate-200">数据地形图</b>,
            再对每片区域独立<b className="text-slate-200">发现结构 → 选择表示 → 选择压缩规则</b>,最后用算术编码把“模型预测的残差种子”无损写出。
          </p>
        </header>

        {/* ===== 输入 ===== */}
        <Card title="① 输入:一切皆二进制" sub="选一个演示样本,或一次多选 / 拖入多个文件（文本、图片、音频、可执行文件、压缩包……）。地形压缩在浏览器本地完成；外部对照仅在你点击测试后发送到可选的对照服务。">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {SAMPLES.map((s) => (
              <button
                key={s.key}
                disabled={!!stage || benchBusy}
                onClick={() => {
                  const r = s.make()
                  run(s.name, r.data, r.truth)
                }}
                className="group rounded-xl border border-white/10 bg-white/[0.04] p-3 text-left transition hover:border-cyan-300/50 hover:bg-cyan-300/[0.07] disabled:opacity-40"
              >
                <div className="text-sm font-medium text-white group-hover:text-cyan-200">{s.name}</div>
                <div className="mt-1 text-xs leading-snug text-slate-400">{s.desc}</div>
              </button>
            ))}
          </div>
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDrag(true)
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDrag(false)
              onFiles(e.dataTransfer.files)
            }}
            className={
              'mt-4 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition ' +
              (drag ? 'border-cyan-300 bg-cyan-300/10' : 'border-white/15 bg-white/[0.02]')
            }
          >
            <p className="text-sm text-slate-300">把一个或多个文件拖到这里</p>
            <div className="flex flex-wrap justify-center gap-2">
              <button
                disabled={!!stage || benchBusy}
                onClick={() => fileRef.current?.click()}
                className="rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-cyan-300 disabled:opacity-40"
              >
                选择多个文件并压缩
              </button>
              <button
                disabled={busy || !!stage || benchBusy}
                onClick={() => uczRef.current?.click()}
                className="rounded-lg border border-white/20 px-4 py-2 text-sm text-slate-200 hover:bg-white/10 disabled:opacity-40"
              >
                还原 .ucz 文件
              </button>
            </div>
            <p className="max-w-3xl text-xs leading-relaxed text-slate-500">每个文件最多 256 MiB（{formatBytes(MAX_INPUT_BYTES)}），超限或空文件单独提示，不影响其它任务。文件按并发上限排队，开始处理时才读取；大文件模型可能占用数百 MiB 内存，低内存设备建议选择 1 个任务。高并发（24 个以上）会同时驻留多份模型，请确认内存充足。</p>
            <input ref={fileRef} type="file" multiple aria-label="选择待压缩文件" disabled={!!stage || benchBusy} hidden onChange={e => { onFiles(e.target.files); e.target.value = '' }} />
            <input ref={uczRef} type="file" accept=".ucz" aria-label="选择待还原文件" disabled={busy || !!stage || benchBusy} hidden onChange={e => { onRestore(e.target.files?.[0]); e.target.value = '' }} />
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 text-xs">
            <label className="flex items-center gap-2 text-slate-400">
              同时处理
              <select aria-label="同时压缩任务数" value={concurrency} disabled={busy || !!stage || benchBusy} onChange={event => queue.setConcurrency(Number(event.target.value))} className="rounded-lg border border-white/20 bg-[#101827] px-3 py-2 text-slate-200 disabled:opacity-50">
                {CONCURRENCY_CHOICES.map(n => (
                  <option key={n} value={n}>
                    {n === 1 ? '1 个文件 · 节省内存' : n <= 8 ? `${n} 个文件 · 并行压缩` : n <= 16 ? `${n} 个文件 · 多核并行` : `${n} 个文件 · 高并发（内存占用高）`}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="结果大小显示单位">
              <span className="text-slate-400">大小显示</span>
              {([['bytes', '完整字节（B）'], ['auto', '自动单位']] as const).map(([value, label]) => <button key={value} onClick={() => setSizeUnit(value)} aria-pressed={sizeUnit === value} className={`rounded-lg px-3 py-2 ${sizeUnit === value ? 'bg-cyan-300/15 text-cyan-200 ring-1 ring-cyan-300/30' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}>{label}</button>)}
            </div>
          </div>
          {msg && <p role="status" className="mt-3 rounded-lg bg-amber-400/10 px-3 py-2 text-sm text-amber-200">{msg}</p>}
        </Card>

        <BatchResults tasks={tasks} unit={sizeUnit} selectedId={selectedTask?.id} locked={benchBusy || !!stage}
          onSelect={setSelectedId} onCancel={id => queue.cancel(id)} onCancelAll={() => queue.cancelAll()} onClear={() => queue.clearFinished()}
          onDownload={task => { if (task.result) download(task.result.comp.container, task.name + '.ucz') }} />

        {/* ===== 进度 ===== */}
        {stage && (
          <div className="mt-6 rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.05] p-5">
            <div className="mb-2 flex items-center justify-between gap-3 text-sm">
              <span className="truncate text-cyan-100">{stage.msg}</span>
              <div className="flex shrink-0 items-center gap-3">
                <span className="tabular-nums text-cyan-300">{Math.round(stage.pct)}%</span>
                <button
                  onClick={cancelRun}
                  className="rounded-md border border-rose-300/40 px-2 py-1 text-xs text-rose-200 hover:bg-rose-300/10"
                >
                  取消
                </button>
              </div>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-amber-200 transition-all" style={{ width: stage.pct + '%' }} />
            </div>
          </div>
        )}

        {/* ===== 结果 ===== */}
        {res && mapEntropy && mapCost && entropyVal && (
          <div className="mt-6 space-y-6">
            <h2 className="break-all text-lg font-semibold text-white">文件详情 · {res.name}</h2>
            {res.note && <p className="rounded-lg bg-amber-400/10 px-3 py-2 text-sm text-amber-200">{res.note}</p>}

            {/* 概览 */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="原始大小" value={fmt(total)} sub={res.name} />
              <Stat label="自适应压缩后" value={fmt(csize)} sub={`${((csize / total) * 100).toFixed(1)}% · ${(total / csize).toFixed(2)}×`} accent />
              <Stat
                label="无损校验"
                value={res.verified ? '逐字节一致 ✓' : '校验失败 ✗'}
                sub={`独立解码 ${res.tVer.toFixed(0)} ms`}
                tone={res.verified ? 'ok' : 'bad'}
              />
              <Stat label="压缩耗时" value={`${res.tComp.toFixed(0)} ms`} sub={`${res.comp.segs.length} 个区域 · ${res.comp.analysis.blocks.length} 块`} />
            </div>

            {/* 诊断指标：容器版本 / 格式标志 / 吞吐 / 解码耗时 */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="容器格式"
                value={`v${containerVersion(res.comp)}`}
                sub={flagSummary(res.comp)}
              />
              <Stat
                label="压缩吞吐"
                value={`${throughput(total, res.tComp)}`}
                sub={`解码 ${throughput(total, res.tVer)}`}
              />
              <Stat
                label="校验耗时"
                value={`${res.tVer.toFixed(0)} ms`}
                sub={`占压缩 ${((res.tVer / Math.max(1, res.tComp)) * 100).toFixed(0)}%`}
              />
              <Stat
                label="模型标志"
                value={`0x${containerFlags(res.comp).toString(16).toUpperCase()}`}
                sub={flagBits(res.comp)}
              />
            </div>

            {/* 区域条带 */}
            <Card
              title="② 分区:每片地形一条规则"
              sub="下方色带按字节偏移铺开,颜色 = 系统为该区域自动选定的压缩规则。点击区域可在所有图中聚焦它。"
            >
              <Strip res={res} sel={sel} setSel={setSel} formatSize={fmt} />
              <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5">
                {usedCodecs.map((id) => (
                  <span key={id} className="flex items-center gap-1.5 text-xs text-slate-300">
                    <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: CODECS[id].color }} />
                    {CODECS[id].short} · {CODECS[id].name}
                  </span>
                ))}
              </div>
              {res.truth && (
                <>
                  <p className="mt-5 mb-2 text-xs text-slate-400">
                    对照:这个演示文件的真实构成(系统分析时<b>并不知道</b>,上面的分区完全由数据自己的统计特征得出)——注意图片里夹着的 XMP 文本被单独识别了出来:
                  </p>
                  <div className="flex h-9 w-full overflow-hidden rounded-lg border border-white/10">
                    {res.truth.map((t, i) => (
                      <div
                        key={i}
                        title={`${t.label} (${fmt(t.end - t.start)})`}
                        className="flex items-center justify-center overflow-hidden border-r border-black/40 bg-white/[0.07] px-1 text-[10px] text-slate-300 last:border-r-0"
                        style={{ width: `${((t.end - t.start) / total) * 100}%`, minWidth: 2 }}
                      >
                        <span className="truncate">{t.label}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Card>

            {/* 地形图 */}
            <div className="grid gap-6 lg:grid-cols-2">
              <Card
                title="③ 希尔伯特折叠地形图(一维 → 二维)"
                sub="希尔伯特曲线把字节流折成方阵,保证“偏移相近的字节在图上也相邻”。颜色 = 压缩规则;亮度/等高线 = 高度(熵或压缩后代价)。"
              >
                <div className="mb-3 flex gap-1 text-xs">
                  {(
                    [
                      ['entropy', '高度 = 原始熵'],
                      ['cost', '高度 = 压缩后 bit/字节'],
                    ] as const
                  ).map(([k, l]) => (
                    <button
                      key={k}
                      onClick={() => setMode(k)}
                      className={'rounded-md px-3 py-1.5 ' + (mode === k ? 'bg-cyan-400 font-semibold text-slate-900' : 'bg-white/10 text-slate-300 hover:bg-white/15')}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                <HilbertView
                  model={mode === 'entropy' ? mapEntropy : mapCost}
                  colors={colors}
                  sel={sel}
                  vmax={8}
                  segs={res.comp.segs}
                  blockVal={mode === 'entropy' ? entropyVal : res.comp.blockCost}
                  valueName={mode === 'entropy' ? '原始熵' : '压缩后'}
                  B={BLOCK}
                />
                <p className="mt-2 text-xs text-slate-500">
                  {mapEntropy.unit > 1 ? `每个像素 = ${mapEntropy.unit} 字节` : '每个像素 = 1 字节'} · 悬停查看偏移与区域。
                </p>
              </Card>

              <Card title="等距 3D 地形" sub="同一张图抬升成立体地形:山峰 = 高熵/难压缩,盆地 = 规则、可预测。两种“高度”切换同上。">
                <IsoView
                  blockVal={mode === 'entropy' ? entropyVal : res.comp.blockCost}
                  blockSeg={res.comp.blockSeg}
                  colors={colors}
                  sel={sel}
                  vmax={8}
                />
              </Card>

              <Card
                title="多维映射 A:相邻字节对平面"
                sub="横轴 = 第 i 个字节,纵轴 = 第 i+1 个字节。一维序列里看不出的相关性在这里成形:文本聚成团块,渐变数据贴着对角线,噪声铺满全平面。"
              >
                <DigramView data={res.data} segs={res.comp.segs} colors={colors} sel={sel} />
              </Card>

              <Card
                title="多维映射 B:8 维特征 → PCA 降维"
                sub={`每个 512 字节块被描述为 ${res.comp.analysis.features.length} 维向量(${res.comp.analysis.features.join('、')}),主成分分析压到 2 维。同类结构自然聚团,这就是“按地形选规则”的依据。`}
              >
                <PcaView pts={res.comp.analysis.pca} blockSeg={res.comp.blockSeg} colors={colors} sel={sel} />
              </Card>
            </div>

            <Card title="④ 处理过程与地形共享" sub="从分块、规则试探到坍缩位图和共享模型；大小为实际容器数据，候选试编码是采样值。">
              <div className="grid gap-3 text-xs text-slate-300 sm:grid-cols-3">
                <div className="rounded-lg bg-black/25 p-3">① 地形扫描<br /><b className="text-white">{res.comp.analysis.blocks.length} 块 / {res.comp.analysis.segs.length} 初始区域</b><br />块大小 {BLOCK} B，提取 {res.comp.analysis.features.length} 项特征</div>
                <div className="rounded-lg bg-black/25 p-3">② 规则选择与合并<br /><b className="text-white">{res.comp.segs.length} 个最终区域</b><br />按采样试编码决定，不保证全局最优</div>
                <div className="rounded-lg bg-black/25 p-3">③ 共享模型与封装<br /><b className="text-white">{fmt(res.comp.overhead)} 头部 / {fmt(csize - res.comp.overhead)} 数据</b><br />UCZ v{res.comp.container[3]} · 变换按区域重置；依规则共享或独立编码</div>
              </div>
              <details className="mt-4 text-xs text-slate-300">
                <summary className="cursor-pointer text-cyan-200">展开每个规则的聚合与位图统计</summary>
                {(() => {
                  const groups = new Map<string, {label:string; count:number; raw:number; packed:number}>()
                  for (const sg of res.comp.segs) {
                    const key = `${sg.spec.id},${sg.spec.s},${sg.spec.r}`
                    const g = groups.get(key) ?? {label:sg.label, count:0, raw:0, packed:0}
                    g.count++; g.raw += sg.rawLen; g.packed += sg.compLen; groups.set(key, g)
                  }
                  const sorted = [...groups.values()].sort((a,b) => b.count - a.count)
                  let remaining = res.comp.segs.length, bits = 0
                  for (let i = 0; i + 1 < sorted.length; i++) { bits += remaining; remaining -= sorted[i].count }
                  return <div className="mt-3 space-y-2"><p>规则 {sorted.length} 种 · 坍缩位图 {bits} bit / {Math.ceil(bits / 8)} B · 最后一种不写位图</p>{sorted.map((g, i) => <p key={i}>{i + 1}. {g.label} · {g.count} 个区域 · 原始 {fmt(g.raw)} · 共享负载 {fmt(g.packed)}</p>)}</div>
                })()}
              </details>
              <details className="mt-3 text-xs text-slate-400"><summary className="cursor-pointer text-cyan-200">展开阶段日志（最多 200 条）</summary><div className="mt-2 max-h-52 overflow-y-auto font-mono">{steps.map((step, i) => <div key={i}>{step}</div>)}</div></details>
            </Card>

            {/* 区域表 */}
            <Card
              title="⑤ 每个区域的自动决策"
              sub="地形类型决定候选规则集;系统在采样上真实试编码,比较实际大小后选出最优者(都不如原样存储时就放弃压缩)。"
            >
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-xs">
                  <thead className="text-slate-400">
                    <tr className="border-b border-white/10">
                      <th className="py-2 pr-3 font-medium">#</th>
                      <th className="pr-3 font-medium">范围</th>
                      <th className="pr-3 font-medium">识别的地形</th>
                      <th className="pr-3 font-medium">选定的规则</th>
                      <th className="pr-3 text-right font-medium">原始</th>
                      <th className="pr-3 text-right font-medium">压缩后</th>
                      <th className="text-right font-medium">bit/字节</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.comp.segs.slice(tablePage * 100, (tablePage + 1) * 100).map((s, index) => {
                      const i = tablePage * 100 + index
                      return <tr
                        key={i}
                        onClick={() => setSel(sel === i ? -1 : i)}
                        className={'cursor-pointer border-b border-white/5 hover:bg-white/5 ' + (sel === i ? 'bg-white/10' : '')}
                      >
                        <td className="py-2 pr-3 text-slate-500">{i + 1}</td>
                        <td className="pr-3 tabular-nums text-slate-300">
                          {s.start.toLocaleString()} – {s.end.toLocaleString()}
                        </td>
                        <td className="pr-3 text-slate-300">{CLS_NAME[s.cls]}</td>
                        <td className="pr-3">
                          <span className="mr-1.5 inline-block h-2 w-2 rounded-sm" style={{ background: CODECS[s.spec.id].color }} />
                          <span className="text-white">{s.label}</span>
                        </td>
                        <td className="pr-3 text-right tabular-nums text-slate-300">{fmt(s.rawLen)}</td>
                        <td className="pr-3 text-right tabular-nums text-slate-300">{fmt(s.compLen)}</td>
                        <td className="text-right tabular-nums text-cyan-200">{((s.compLen * 8) / s.rawLen).toFixed(2)}</td>
                      </tr>
                    })}
                  </tbody>
                </table>
              </div>
              {res.comp.segs.length > 100 && <div className="mt-3 flex items-center gap-3 text-xs text-slate-400">
                <button disabled={tablePage === 0} onClick={() => setTablePage(p => p - 1)} className="rounded border border-white/20 px-2 py-1 disabled:opacity-30">上一页</button>
                <span>第 {tablePage + 1} / {Math.ceil(res.comp.segs.length / 100)} 页 · 共 {res.comp.segs.length} 个区域</span>
                <button disabled={(tablePage + 1) * 100 >= res.comp.segs.length} onClick={() => setTablePage(p => p + 1)} className="rounded border border-white/20 px-2 py-1 disabled:opacity-30">下一页</button>
              </div>}
              {sel >= 0 && res.comp.segs[sel] && (
                <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-4">
                  <p className="mb-1 text-sm font-medium text-white">
                    区域 {sel + 1}:{CODECS[res.comp.segs[sel].spec.id].name}
                  </p>
                  <p className="mb-3 text-xs text-slate-400">{CODECS[res.comp.segs[sel].spec.id].desc}</p>
                  {(() => {
                    const sg = res.comp.segs[sel]
                    const blocks = res.comp.analysis.blocks.filter(b => b.start >= sg.start && b.start < sg.end)
                    const avg = (key: 'h0' | 'hd' | 'text' | 'rep' | 'mad') => blocks.reduce((sum, b) => sum + b[key], 0) / Math.max(1, blocks.length)
                    return <p className="mb-3 text-xs text-slate-400">{blocks.length} 块 · 平均零阶熵 {avg('h0').toFixed(2)} bit/B · 差分熵 {avg('hd').toFixed(2)} bit/B · 文本率 {(avg('text') * 100).toFixed(1)}% · 重复率 {(avg('rep') * 100).toFixed(1)}% · 平均差分 {avg('mad').toFixed(3)} · 首块步长 {blocks[0]?.bestS ?? '—'}</p>
                  })()}
                  {res.comp.segs[sel].micro && <p className="mb-3 text-xs text-amber-300">微种子权重（左、上、左上、左两步、常量）：{res.comp.segs[sel].micro!.weights.join('，')} · 量化比例 {res.comp.segs[sel].micro!.scale}</p>}
                  {res.comp.segs[sel].subPeel && <details className="mb-3 rounded border border-orange-400/30 p-2 text-xs text-slate-300">
                    <summary className="cursor-pointer text-orange-300">查看子通道模态（同一块内跨区域聚合）</summary>
                    {(() => { const info=res.comp.segs[sel].subPeel!; const names=['STORE','RLE+O0','DELTA+O0','DELTA+BIN','RAW+CM']; return 'modes' in info ?
                      <div className="mt-2">{info.grouped ? '同模态共享' : '各列独立'} · {info.modes.map((m,i)=><span key={i} className="mr-2 inline-block">列{i}: {names[m]}</span>)}</div> :
                      <div className="mt-2">{info.channels.map(c=><span key={c.column} className="mr-2 inline-block">列{c.column}: {names[c.mode]} {c.rawLen}→{c.payloadSize} B</span>)}尾流: {names[info.tailMode]} {info.tailSize} B</div> })()}
                  </details>}
                  {res.comp.segs[sel].peel && <details className="mb-3 rounded border border-violet-400/30 p-2 text-xs text-slate-300">
                    <summary className="cursor-pointer text-violet-300">查看递归子流 · {res.comp.segs[sel].peel!.length} 列（深度 1）</summary>
                    <div className="mt-2 max-h-64 space-y-2 overflow-y-auto">
                      {res.comp.segs[sel].peel!.map(col => <div key={col.column}>
                        <b className="text-slate-200">列 {col.column}：{col.rawLen} B → {col.payloadSize} B</b>
                        <div>{col.regions.map((r,i) => <span key={i} className="mr-2 inline-block">[{r.start}–{r.end}) {r.terrain === 'whole' ? '整体试编码' : CLS_NAME[r.terrain]} → {r.rule} {r.payloadSize} B</span>)}</div>
                      </div>)}
                    </div>
                  </details>}
                  <p className="mb-2 text-xs text-slate-500">候选规则试编码结果（对齐窗口独立试探；合并区域时显示首个原始区域的结果）:</p>
                  <div className="space-y-1.5">
                    {res.comp.segs[sel].trials.map((t, i) => (
                      <div key={i} className="flex items-center gap-3 text-xs">
                        <span className="w-44 shrink-0 truncate text-slate-300">{t.label}</span>
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${Math.min(100, t.ratio * 100)}%`, background: CODECS[t.spec.id].color, opacity: i === 0 ? 1 : 0.5 }}
                          />
                        </div>
                        <span title={`采样起点（区域内偏移）：${(t.sampleStarts ?? [t.sampleStart ?? 0]).join(', ')} B${t.fullSize !== undefined ? `；完整区域独立试编码：${t.fullSize} B` : ''}`} className="w-36 text-right tabular-nums text-slate-400">{t.payloadSize} / {t.sampleLen} B · {(t.ratio * 100).toFixed(1)}%{t.fullSize !== undefined && ` · 全区${t.fullSize} B`}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            {/* 对照 */}
            <Card title="⑥ 压缩算法实测对照" sub="同一份输入、包含各格式封装开销；固定规则为全文件单一通用 CM。外部算法需手动启动对照服务并点击测试；单一 CM 对照限 10 MiB。">
              <Bars
                formatSize={fmt}
                items={[
                  { label: '原始', size: total, color: '#475569' },
                  ...(res.gzip != null ? [{ label: 'gzip(浏览器内置)', size: res.gzip, color: '#94a3b8' }] : []),
                  ...(res.single != null ? [{ label: '单一通用 CM(固定规则)', size: res.single, color: '#fb7185' }] : []),
                  ...bench.filter(b => b.size != null && b.verified).map(b => ({ label: b.label, size: b.size!, color: '#a78bfa' })),
                  { label: '地形自适应(本系统)', size: csize, color: '#22d3ee' },
                ]}
                total={total}
              />
              {res.single == null && <p className="mt-3 text-xs text-amber-300">{total > MAX_SINGLE_CM_BYTES ? '超过 10 MiB：已跳过全文件 Single CM 对照（非采样估算）；UCZ 压缩和逐字节解压校验仍对完整文件执行。' : 'Single CM 对照已跳过。'}</p>}
              <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-4 text-xs text-slate-300">
                <p>可选外部实测：Zstandard 3 / 19、Brotli quality 5、xz/LZMA2 6、bzip2 9、ZPAQ m1。点击后会把当前输入发送到对照服务；请只在信任该服务时运行。ZPAQ 为归档格式，包含文件名等元数据；xz 与 7-Zip 不是同一种封装。外部进程的编码耗时包含启动开销，不能直接与浏览器计时严格比较。</p>
                <button disabled={benchBusy || busy || !!stage} onClick={runBench} className="mt-3 rounded-lg border border-violet-400/50 px-3 py-2 text-violet-200 disabled:opacity-50">{benchBusy ? '正在实测（高等级可能较慢）…' : '运行外部对照测试'}</button>
                {benchError && <p className="mt-2 text-amber-300">{benchError}</p>}
                {bench.length > 0 && <div className="mt-3 space-y-1">{bench.map(b => <p key={b.label}>{b.label}：{b.error ? `不可用 · ${b.error}` : `${fmt(b.size!)} · ${((b.size! / total) * 100).toFixed(2)}% · 编码 ${(b.encodeMs! / 1000).toFixed(3)} s · 含校验及文件 I/O ${(b.ms! / 1000).toFixed(3)} s · ${b.verified ? '逐字节校验通过' : '校验失败，不计入图表'}`}</p>)}</div>}
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                <button
                  onClick={() => download(res.comp.container, res.name + '.ucz')}
                  className="rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-cyan-300"
                >
                  下载 .ucz 压缩文件
                </button>
                <button
                  disabled={busy || !!stage || benchBusy}
                  onClick={downloadRestored}
                  className="rounded-lg border border-white/20 px-4 py-2 text-sm hover:bg-white/10"
                >
                  解压并下载还原文件
                </button>
              </div>
              <p className="mt-3 text-xs text-slate-500">
                容器额外开销 {fmt(res.comp.overhead)}（魔数、规则字典、区域长度与坍缩位图）。同规则区域共享编码流；区域体积按模型成本分摊。
              </p>
            </Card>
          </div>
        )}


        <footer className="mt-12 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-4 text-xs text-slate-500">
          <span>UCZ v{VERSION} · Universal Adaptive Compression</span>
          <a href="/LICENSE" className="underline decoration-dotted hover:text-slate-300">MPL-2.0</a>
        </footer>
      </div>
    </div>
  )
}

// ---------- 诊断指标的纯函数 ----------
// 版本就是容器魔数后的第 4 个字节；flags 是 v19+ 才有的 uint16 字段。
function containerVersion(comp: Compressed): number { return comp.container[3] ?? 0 }
function containerFlags(comp: Compressed): number {
  return containerVersion(comp) >= 19 ? ((comp.container[4] | ((comp.container[5] ?? 0) << 8)) >>> 0) : 0
}
/** 只陈列该容器实际置位的格式化标志，避免把整张表贴给用户。 */
function flagBits(comp: Compressed): string {
  const v = containerVersion(comp), f = containerFlags(comp)
  if (v < 19) return '该版本无格式标志字段'
  const bits: string[] = []
  if (f & V20_FLAG_CM) bits.push('v20 内核')
  if (f & V21_FLAG_CONTEXTS) bits.push('上下文')
  if (f & V22_FLAG_MATCH_DISTANCE) bits.push('matchDist')
  if (f & V20_FLAG_TRANSFORMS) bits.push('变换')
  return bits.length ? bits.join(' · ') : '无附加标志'
}
function flagSummary(comp: Compressed): string {
  return `${comp.segs.length} 段 · 容器开销 ${comp.overhead || 0} B`
}
function throughput(bytes: number, ms: number): string {
  if (!(ms > 0)) return '—'
  return `${(bytes / 1024 / (ms / 1000)).toFixed(0)} KiB/s`
}

function Stat(props: { label: string; value: string; sub?: string; accent?: boolean; tone?: 'ok' | 'bad' }) {
  const color = props.tone === 'ok' ? 'text-emerald-300' : props.tone === 'bad' ? 'text-rose-300' : props.accent ? 'text-cyan-300' : 'text-white'
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
      <div className="text-xs text-slate-400">{props.label}</div>
      <div className={'mt-1 break-words text-xl font-bold tabular-nums ' + color}>{props.value}</div>
      {props.sub && <div className="mt-1 truncate text-xs text-slate-500">{props.sub}</div>}
    </div>
  )
}

function Strip({ res, sel, setSel, formatSize }: { res: Result; sel: number; setSel: (n: number) => void; formatSize: (bytes: number) => string }) {
  const total = res.data.length
  const segs = res.comp.segs
  // Thousands of regions are summarized to bounded-size chunks to keep React responsive.
  const batch = Math.max(1, Math.ceil(segs.length / 200))
  const groups = []
  for (let i = 0; i < segs.length; i += batch) groups.push({ first: i, last: Math.min(segs.length, i + batch), start: segs[i].start, end: segs[Math.min(segs.length, i + batch) - 1].end })
  return (
    <div className="flex h-14 w-full overflow-hidden rounded-xl border border-white/10">
      {groups.map(g => {
        const s = segs[g.first], w = (g.end - g.start) / total * 100
        const selected = sel >= g.first && sel < g.last
        return <button key={g.first} onClick={() => setSel(selected ? -1 : g.first)}
          title={batch === 1 ? `${CLS_NAME[s.cls]} → ${s.label}\n${formatSize(s.rawLen)} → ${formatSize(s.compLen)}` : `区域 ${g.first + 1}–${g.last}（颜色代表首区域；详情见区域表）`}
          className="relative flex items-center justify-center overflow-hidden border-r border-black/50 text-[10px] font-semibold text-slate-950 transition last:border-r-0"
          style={{ width: `${w}%`, minWidth: batch === 1 ? 3 : 0, background: CODECS[s.spec.id].color, opacity: sel >= 0 && !selected ? 0.25 : 1, outline: selected ? '2px solid white' : 'none', outlineOffset: -2 }}>
          {w > 7 && <span className="truncate px-1">{batch === 1 ? CODECS[s.spec.id].short : `${g.last - g.first} 区域`}</span>}
        </button>
      })}
    </div>
  )
}

function Bars({ items, total, formatSize }: { items: { label: string; size: number; color: string }[]; total: number; formatSize: (bytes: number) => string }) {
  return (
    <div className="space-y-3">
      {items.map(it => (
        <div key={it.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-xs sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
          <span className="text-slate-300">{it.label}</span>
          <div className="col-span-2 row-start-2 h-5 overflow-hidden rounded-md bg-white/[0.06] sm:col-span-1 sm:row-start-auto">
            <div className="h-full rounded-md" style={{ width: `${Math.max(0.5, (it.size / total) * 100)}%`, background: it.color }} />
          </div>
          <span title={formatBytes(it.size)} className="col-start-2 row-start-1 whitespace-nowrap text-right tabular-nums text-slate-300 sm:col-start-3">
            {formatSize(it.size)} <span className="text-slate-500">({((it.size / total) * 100).toFixed(1)}%)</span>
          </span>
        </div>
      ))}
    </div>
  )
}
