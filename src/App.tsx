import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { BLOCK, CLS_NAME } from './lib/analyze'
import { MAX_INPUT_BYTES, MAX_SINGLE_CM_BYTES } from './lib/limits'
import CodecWorker from './lib/compress.worker?worker&inline'
import { CODECS, type Compressed, type CompressionLevel } from './lib/codec'
import { CLS_LABEL_EN, CODEC_LABEL_EN, SAMPLE_LABEL_EN, TRUTH_LABEL_EN, translateProgress } from './lib/ui-locale'
import { V20_FLAG_CM, V20_FLAG_TRANSFORMS, V22_FLAG_MATCH_DISTANCE } from './lib/coder'
import { V21_FLAG_CONTEXTS } from './lib/context-policy'
import { SAMPLES, type TruthRegion } from './lib/samples'
import { buildMapModel, hexToRgb } from './lib/viz'
import { fingerprintStream, inspectContainer, profileResidual, type ContainerAnatomy, type ManifoldFingerprint, type ResidualProfile } from './lib/inspect'
import { computeNCDMatrix, type NCDMatrixResult } from './lib/ncd'
import { DICT, type Lang } from './lib/i18n'
import { DigramView, HilbertView, IsoView } from './components/Views'
import { NcdPanel, ResidualPanel } from './components/Inspect'
import { BatchResults } from './components/BatchResults'
import { CompressionQueue, CONCURRENCY_CHOICES, isPending, type CompressionResult as Result } from './utils/compression-queue'
import { callCodecWithFallback } from './utils/codec-worker-client'
import { formatBytes, type SizeUnit } from './utils/format-bytes'
import { VERSION } from './version'

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

const TIERS: readonly CompressionLevel[] = ['fast', 'balanced', 'max']

export default function App() {
  const [lang, setLang] = useState<Lang>('en')
  const t = DICT[lang]
  const [level, setLevel] = useState<CompressionLevel>('max')
  // The queue is created once, so the executor reads the tier through a ref.
  const levelRef = useRef<CompressionLevel>('max')
  // The document language must follow the UI language so screen readers and
  // hyphenation do not stay on the initial zh-CN.
  useEffect(() => { document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en' }, [lang])
  levelRef.current = level
  const [queue] = useState(() => new CompressionQueue(
    (data, signal, progress) => callCodecWithFallback(createCodecWorker, 'run', data, signal, progress, { level: levelRef.current })
        .then(out => ({ ...out, level: levelRef.current })),
    initialConcurrency(),
  ))
  const { tasks, concurrency } = useSyncExternalStore(queue.subscribe, queue.getSnapshot)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedTask = tasks.find(task => task.id === selectedId && task.result) ?? tasks.find(task => task.result)
  const res = selectedTask?.result ?? null
  const busy = tasks.some(isPending)
  const [sizeUnit, setSizeUnit] = useState<SizeUnit>('bytes')
  const fmt = (bytes: number) => formatBytes(bytes, sizeUnit)
  const [stage, setStage] = useState<{ msg: string; pct: number } | null>(null)
  const [sel, setSel] = useState(-1)
  const [tablePage, setTablePage] = useState(0)
  const [mode, setMode] = useState<'entropy' | 'cost'>('cost')
  const [msg, setMsg] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const [fingerprint, setFingerprint] = useState<ManifoldFingerprint | null>(null)
  const [anatomy, setAnatomy] = useState<ContainerAnatomy | null>(null)
  const [residual, setResidual] = useState<ResidualProfile | null>(null)
  const [inspectBusy, setInspectBusy] = useState(false)
  const [ncd, setNcd] = useState<NCDMatrixResult | null>(null)
  const [ncdBusy, setNcdBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const uczRef = useRef<HTMLInputElement>(null)
  const restoreRef = useRef<AbortController | null>(null)

  // Select the first completed file once; later completions do not steal focus.
  useEffect(() => {
    setSelectedId(selectedTask?.id ?? null)
  }, [selectedTask?.id])
  useEffect(() => {
    setSel(-1); setTablePage(0)
    setFingerprint(null); setAnatomy(null); setResidual(null)
  }, [selectedTask?.id])
  useEffect(() => { setNcd(null) }, [tasks.length])
  useEffect(() => () => {
    queue.cancelAll()
    restoreRef.current?.abort()
  }, [queue])

  function cancelRun() {
    restoreRef.current?.abort()
    restoreRef.current = null
    setStage(null)
    setMsg(t.cancelled)
  }

  function run(name: string, data: Uint8Array, truth?: TruthRegion[], note?: string) {
    if (restoreRef.current) { setMsg(t.waitBusy); return }
    setMsg(null)
    queue.add([{ name, size: data.length, read: async () => data, truth, note }])
  }

  function onFiles(files: FileList | null) {
    if (!files?.length) return
    if (restoreRef.current) { setMsg(t.waitBusy); return }
    setMsg(null)
    queue.add(Array.from(files, file => ({
      name: file.name, size: file.size,
      read: async () => new Uint8Array(await file.arrayBuffer()),
    })))
  }

  /** Cheap, synchronous anatomy + fingerprint; the residual profile is the expensive part. */
  function inspect(withResidual: boolean) {
    if (!res) return
    setInspectBusy(true)
    // Yield once so the button can repaint before the encode blocks the thread.
    setTimeout(() => {
      try {
        setFingerprint(fingerprintStream(res.data))
        setAnatomy(inspectContainer(res.comp.container))
        if (withResidual) setResidual(profileResidual(res.data, { maxBytes: 65536 }))
      } finally {
        setInspectBusy(false)
      }
    }, 0)
  }

  async function runNcd() {
    const done = tasks.filter(task => task.status === 'done' && task.result)
    if (done.length < 2 || ncdBusy) return
    setNcdBusy(true)
    try {
      const value = await computeNCDMatrix(done.map(task => ({ name: task.name, data: task.result!.data })), { maxBytes: 32768, level })
      setNcd(value)
    } finally {
      setNcdBusy(false)
    }
  }

  async function restore(read: () => Promise<Uint8Array>, name: string) {
    if (busy || restoreRef.current) return
    const controller = new AbortController()
    restoreRef.current = controller
    setMsg(null)
    setStage({ msg: '…', pct: 0 })
    try {
      const data = await read()
      const out = await callCodecWithFallback(createCodecWorker, 'restore', data, controller.signal,
        (msg, pct) => { if (!controller.signal.aborted) setStage({ msg, pct }) })
      if (!controller.signal.aborted) download(out, name)
    } catch (error) {
      if (!controller.signal.aborted) setMsg(`${error instanceof Error ? error.message : String(error)}`)
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
  const clsLabel = (cls: keyof typeof CLS_LABEL_EN) => (lang === 'en' ? CLS_LABEL_EN[cls] : CLS_NAME[cls])
  const codecName = (id: number) => (lang === 'en' ? CODEC_LABEL_EN[id] ?? CODECS[id].short : CODECS[id].name)
  const ruleLabel = (seg: { spec: { id: number; s: number } }) =>
    lang === 'en' ? `${CODECS[seg.spec.id].short}${seg.spec.s > 1 ? ` · s=${seg.spec.s}` : ''}` : (seg as { label?: string }).label ?? CODECS[seg.spec.id].name
  const truthLabel = (label: string) => (lang === 'en' ? TRUTH_LABEL_EN[label] ?? label : label)
  const usedCodecs = useMemo(() => (res ? [...new Set(res.comp.segs.map((s) => s.spec.id))] : []), [res])
  const doneCount = tasks.filter(task => task.status === 'done' && task.result).length

  const total = res?.data.length ?? 0
  const csize = res?.comp.container.length ?? 0

  return (
    <div className="topo min-h-screen bg-[#070b14] text-slate-200">
      <div className="mx-auto max-w-6xl px-4 pb-24 pt-10 sm:px-6">
        {/* ===== Hero + controls ===== */}
        <header className="mb-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <h1 className="text-3xl font-bold tracking-tight text-white sm:text-5xl">
              UCZ <span className="bg-gradient-to-r from-cyan-300 via-amber-200 to-rose-300 bg-clip-text text-transparent">{t.tagline}</span>
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <div role="group" aria-label={t.tier} className="flex items-center gap-1 rounded-xl border border-white/15 bg-white/5 p-1 text-xs">
                <span className="px-2 text-slate-400">{t.tier}</span>
                {TIERS.map(value => (
                  <button
                    key={value}
                    onClick={() => setLevel(value)}
                    aria-pressed={level === value}
                    title={t.tierHint}
                    className={'rounded-lg px-3 py-1.5 font-medium ' + (level === value ? 'bg-cyan-400 text-slate-900' : 'text-slate-300 hover:bg-white/10')}
                  >
                    {value === 'fast' ? t.tierFast : value === 'balanced' ? t.tierBalanced : t.tierMax}
                    <span className="ml-1 opacity-60">{value === 'fast' ? '-1' : value === 'balanced' ? '-2' : '-3'}</span>
                  </button>
                ))}
              </div>
              <button
                onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}
                className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-white/10"
                aria-label="Switch language"
              >
                {t.lang}
              </button>
            </div>
          </div>
        </header>

        {/* ===== Input ===== */}
        <Card title={t.inputTitle}>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {SAMPLES.map((sample) => (
              <button
                key={sample.key}
                disabled={!!stage}
                onClick={() => {
                  const r = sample.make()
                  const label = lang === 'en' ? SAMPLE_LABEL_EN[sample.key] ?? sample.name : sample.name
                  run(label, r.data, r.truth)
                }}
                className="group rounded-xl border border-white/10 bg-white/[0.04] p-3 text-left text-sm font-medium text-white transition hover:border-cyan-300/50 hover:bg-cyan-300/[0.07] hover:text-cyan-200 disabled:opacity-40"
              >
                {lang === 'en' ? SAMPLE_LABEL_EN[sample.key] ?? sample.name : sample.name}
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
            <p className="text-sm text-slate-300">{t.dropHere}</p>
            <div className="flex flex-wrap justify-center gap-2">
              <button
                disabled={!!stage}
                onClick={() => fileRef.current?.click()}
                className="rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-cyan-300 disabled:opacity-40"
              >
                {t.pickFiles}
              </button>
              <button
                disabled={busy || !!stage}
                onClick={() => uczRef.current?.click()}
                className="rounded-lg border border-white/20 px-4 py-2 text-sm text-slate-200 hover:bg-white/10 disabled:opacity-40"
              >
                {t.restoreUcz}
              </button>
            </div>
            <p className="max-w-3xl text-xs leading-relaxed text-slate-500">{t.limits(formatBytes(MAX_INPUT_BYTES))}</p>
            <input ref={fileRef} type="file" multiple aria-label={t.pickFiles} disabled={!!stage} hidden onChange={e => { onFiles(e.target.files); e.target.value = '' }} />
            <input ref={uczRef} type="file" accept=".ucz" aria-label={t.restoreUcz} disabled={busy || !!stage} hidden onChange={e => { onRestore(e.target.files?.[0]); e.target.value = '' }} />
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 text-xs">
            <label className="flex items-center gap-2 text-slate-400">
              {t.concurrency}
              <select aria-label={t.concurrency} value={concurrency} disabled={busy || !!stage} onChange={event => queue.setConcurrency(Number(event.target.value))} className="rounded-lg border border-white/20 bg-[#101827] px-3 py-2 text-slate-200 disabled:opacity-50">
                {CONCURRENCY_CHOICES.map(n => <option key={n} value={n}>{n === 1 ? t.conc1 : t.concN(n)}</option>)}
              </select>
            </label>
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t.sizeUnit}>
              <span className="text-slate-400">{t.sizeUnit}</span>
              {([['bytes', t.unitBytes], ['auto', t.unitAuto]] as const).map(([value, label]) => <button key={value} onClick={() => setSizeUnit(value)} aria-pressed={sizeUnit === value} className={`rounded-lg px-3 py-2 ${sizeUnit === value ? 'bg-cyan-300/15 text-cyan-200 ring-1 ring-cyan-300/30' : 'bg-white/5 text-slate-400 hover:bg-white/10'}`}>{label}</button>)}
            </div>
          </div>
          {msg && <p role="status" className="mt-3 rounded-lg bg-amber-400/10 px-3 py-2 text-sm text-amber-200">{msg}</p>}
        </Card>

        <BatchResults lang={lang} tasks={tasks} unit={sizeUnit} selectedId={selectedTask?.id} locked={!!stage}
          onSelect={setSelectedId} onCancel={id => queue.cancel(id)} onCancelAll={() => queue.cancelAll()} onClear={() => queue.clearFinished()}
          onDownload={task => { if (task.result) download(task.result.comp.container, task.name + '.ucz') }} />

        {/* ===== Progress ===== */}
        {stage && (
          <div className="mt-6 rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.05] p-5">
            <div className="mb-2 flex items-center justify-between gap-3 text-sm">
              <span className="truncate text-cyan-100">{lang === 'en' ? translateProgress(stage.msg || t.working) : stage.msg}</span>
              <div className="flex shrink-0 items-center gap-3">
                <span className="tabular-nums text-cyan-300">{Math.round(stage.pct)}%</span>
                <button onClick={cancelRun} className="rounded-md border border-rose-300/40 px-2 py-1 text-xs text-rose-200 hover:bg-rose-300/10">{t.cancel}</button>
              </div>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-amber-200 transition-all" style={{ width: stage.pct + '%' }} />
            </div>
          </div>
        )}

        {/* ===== Results ===== */}
        {res && mapEntropy && mapCost && entropyVal && (
          <div className="mt-6 space-y-6">
            <h2 className="break-all text-lg font-semibold text-white">{t.details} · {res.name}</h2>
            {res.note && <p className="rounded-lg bg-amber-400/10 px-3 py-2 text-sm text-amber-200">{res.note}</p>}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label={t.rawSize} value={fmt(total)} sub={res.name} />
              <Stat label={t.compressedSize} value={fmt(csize)} sub={`${((csize / total) * 100).toFixed(1)}% · ${(total / csize).toFixed(2)}×`} accent />
              <Stat label={t.verified} value={res.verified ? t.verifiedOk : t.verifiedBad} sub={`${t.decodeMs} ${res.tVer.toFixed(0)} ms`} tone={res.verified ? 'ok' : 'bad'} />
              <Stat label={t.encodeMs} value={`${res.tComp.toFixed(0)} ms`} sub={`${res.comp.segs.length} ${t.regions} · ${res.comp.analysis.blocks.length} ${t.blocks}`} />
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label={t.container} value={`v${containerVersion(res.comp)}`} sub={`${res.comp.segs.length} · ${res.comp.overhead || 0} B`} />
              <Stat label={t.throughput} value={throughput(total, res.tComp)} sub={`${t.decodeMs} ${throughput(total, res.tVer)}`} />
              <Stat label={t.modelFlags} value={`0x${containerFlags(res.comp).toString(16).toUpperCase()}`} sub={flagBits(res.comp)} />
              <Stat label={t.tier} value={res.level ?? level} sub={lang === 'en' ? 'planner search depth used for this result' : '本次结果使用的规划深度'} />
            </div>

            <Card title={t.segmentsTitle} sub={t.segmentsSub}>
              <Strip res={res} sel={sel} setSel={setSel} formatSize={fmt} clsLabel={clsLabel} ruleLabel={ruleLabel} />
              <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5">
                {usedCodecs.map((id) => (
                  <span key={id} className="flex items-center gap-1.5 text-xs text-slate-300">
                    <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: CODECS[id].color }} />
                    {CODECS[id].short} · {codecName(id)}
                  </span>
                ))}
              </div>
              {res.truth && (
                <>
                  <p className="mt-5 mb-2 text-xs text-slate-400">{t.truthTitle}</p>
                  <div className="flex h-9 w-full overflow-hidden rounded-lg border border-white/10">
                    {res.truth.map((tr, i) => (
                      <div
                        key={i}
                        title={`${truthLabel(tr.label)} (${fmt(tr.end - tr.start)})`}
                        className="flex items-center justify-center overflow-hidden border-r border-black/40 bg-white/[0.07] px-1 text-[10px] text-slate-300 last:border-r-0"
                        style={{ width: `${((tr.end - tr.start) / total) * 100}%`, minWidth: 2 }}
                      >
                        <span className="truncate">{truthLabel(tr.label)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Card>

            <ResidualPanel t={t} profile={residual} busy={inspectBusy} onRun={() => inspect(true)} fingerprint={fingerprint} anatomy={anatomy} />

            <div className="grid gap-6 lg:grid-cols-2">
              <Card title={t.terrainTitle} sub={t.terrainSub}>
                <div className="mb-3 flex gap-1 text-xs">
                  {([['entropy', t.heightEntropy], ['cost', t.heightCost]] as const).map(([k, l]) => (
                    <button key={k} onClick={() => setMode(k)} className={'rounded-md px-3 py-1.5 ' + (mode === k ? 'bg-cyan-400 font-semibold text-slate-900' : 'bg-white/10 text-slate-300 hover:bg-white/15')}>{l}</button>
                  ))}
                </div>
                <HilbertView lang={lang}
                  model={mode === 'entropy' ? mapEntropy : mapCost}
                  colors={colors}
                  sel={sel}
                  vmax={8}
                  segs={res.comp.segs}
                  blockVal={mode === 'entropy' ? entropyVal : res.comp.blockCost}
                  valueName={mode === 'entropy' ? 'H0' : 'cost'}
                  B={BLOCK}
                />
              </Card>

              <Card title={t.isoTitle} sub={t.isoSub}>
                <IsoView blockVal={mode === 'entropy' ? entropyVal : res.comp.blockCost} blockSeg={res.comp.blockSeg} colors={colors} sel={sel} vmax={8} />
              </Card>

              <Card title={t.digramTitle} sub={t.digramSub}>
                <DigramView data={res.data} segs={res.comp.segs} colors={colors} sel={sel} />
              </Card>

            </div>

            <Card title={t.tableTitle} sub={t.tableSub}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-xs">
                  <thead className="text-slate-400">
                    <tr className="border-b border-white/10">
                      <th className="py-2 pr-3 font-medium">#</th>
                      <th className="pr-3 font-medium">{t.range}</th>
                      <th className="pr-3 font-medium">{t.terrain}</th>
                      <th className="pr-3 font-medium">{t.rule}</th>
                      <th className="pr-3 text-right font-medium">{t.rawSize}</th>
                      <th className="pr-3 text-right font-medium">{t.compressedSize}</th>
                      <th className="text-right font-medium">{t.bpb}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.comp.segs.slice(tablePage * 100, (tablePage + 1) * 100).map((s, index) => {
                      const i = tablePage * 100 + index
                      return <tr key={i} onClick={() => setSel(sel === i ? -1 : i)} className={'cursor-pointer border-b border-white/5 hover:bg-white/5 ' + (sel === i ? 'bg-white/10' : '')}>
                        <td className="py-2 pr-3 text-slate-500">{i + 1}</td>
                        <td className="pr-3 tabular-nums text-slate-300">{s.start.toLocaleString()} – {s.end.toLocaleString()}</td>
                        <td className="pr-3 text-slate-300">{clsLabel(s.cls)}</td>
                        <td className="pr-3">
                          <span className="mr-1.5 inline-block h-2 w-2 rounded-sm" style={{ background: CODECS[s.spec.id].color }} />
                          <span className="text-white">{ruleLabel(s)}</span>
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
                <button disabled={tablePage === 0} onClick={() => setTablePage(p => p - 1)} className="rounded border border-white/20 px-2 py-1 disabled:opacity-30">{t.prev}</button>
                <span>{t.page(tablePage + 1, Math.ceil(res.comp.segs.length / 100), res.comp.segs.length)}</span>
                <button disabled={(tablePage + 1) * 100 >= res.comp.segs.length} onClick={() => setTablePage(p => p + 1)} className="rounded border border-white/20 px-2 py-1 disabled:opacity-30">{t.next}</button>
              </div>}
              {sel >= 0 && res.comp.segs[sel] && (
                <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-4">
                  <p className="mb-3 text-sm font-medium text-white">{sel + 1} · {CODECS[res.comp.segs[sel].spec.id].short} · {codecName(res.comp.segs[sel].spec.id)}</p>
                  <p className="mb-2 text-xs text-slate-500">{t.trials}</p>
                  <div className="space-y-1.5">
                    {res.comp.segs[sel].trials.map((tr, i) => (
                      <div key={i} className="flex items-center gap-3 text-xs">
                        <span className="w-44 shrink-0 truncate text-slate-300">{tr.label}</span>
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                          <div className="h-full rounded-full" style={{ width: `${Math.min(100, tr.ratio * 100)}%`, background: CODECS[tr.spec.id].color, opacity: i === 0 ? 1 : 0.5 }} />
                        </div>
                        <span className="w-36 text-right tabular-nums text-slate-400">{tr.payloadSize} / {tr.sampleLen} B · {(tr.ratio * 100).toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            <Card title={t.benchTitle} sub={t.benchSub}>
              <Bars
                formatSize={fmt}
                items={[
                  { label: t.rawSize, size: total, color: '#475569' },
                  ...(res.gzip != null ? [{ label: 'gzip', size: res.gzip, color: '#94a3b8' }] : []),
                  ...(res.single != null ? [{ label: 'single CM', size: res.single, color: '#fb7185' }] : []),
                  { label: 'UCZ', size: csize, color: '#22d3ee' },
                ]}
                total={total}
              />
              {res.single == null && <p className="mt-3 text-xs text-amber-300">{total > MAX_SINGLE_CM_BYTES ? t.singleCmSkipped : t.singleCmSkipped}</p>}
              <div className="mt-5 flex flex-wrap gap-2">
                <button onClick={() => download(res.comp.container, res.name + '.ucz')} className="rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-cyan-300">{t.downloadUcz}</button>
                <button disabled={busy || !!stage} onClick={downloadRestored} className="rounded-lg border border-white/20 px-4 py-2 text-sm hover:bg-white/10">{t.downloadRestored}</button>
              </div>
              <p className="mt-3 text-xs text-slate-500">{t.containerOverhead}</p>
            </Card>
          </div>
        )}

        <NcdPanel t={t} result={ncd} busy={ncdBusy} count={doneCount} onRun={() => void runNcd()} />

        <footer className="mt-12 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-4 text-xs text-slate-500">
          <span>UCZ v{VERSION} · {t.tagline}</span>
          <a href="./LICENSE" className="underline decoration-dotted hover:text-slate-300">MPL-2.0</a>
        </footer>
      </div>
    </div>
  )
}

// ---------- pure helpers for the diagnostics row ----------
function containerVersion(comp: Compressed): number { return comp.container[3] ?? 0 }
function containerFlags(comp: Compressed): number {
  return containerVersion(comp) >= 19 ? ((comp.container[4] | ((comp.container[5] ?? 0) << 8)) >>> 0) : 0
}
function flagBits(comp: Compressed): string {
  const v = containerVersion(comp), f = containerFlags(comp)
  if (v < 19) return '—'
  const bits: string[] = []
  if (f & V20_FLAG_CM) bits.push('cm')
  if (f & V21_FLAG_CONTEXTS) bits.push('ctx')
  if (f & V22_FLAG_MATCH_DISTANCE) bits.push('md')
  if (f & V20_FLAG_TRANSFORMS) bits.push('xform')
  return bits.length ? bits.join(' · ') : '—'
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

function Strip({ res, sel, setSel, formatSize, clsLabel, ruleLabel }: { res: Result; sel: number; setSel: (n: number) => void; formatSize: (bytes: number) => string; clsLabel: (cls: keyof typeof CLS_LABEL_EN) => string; ruleLabel: (seg: { spec: { id: number; s: number } }) => string }) {
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
          title={batch === 1 ? `${clsLabel(s.cls)} → ${ruleLabel(s)}\n${formatSize(s.rawLen)} → ${formatSize(s.compLen)}` : `${g.first + 1}–${g.last}`}
          className="relative flex items-center justify-center overflow-hidden border-r border-black/50 text-[10px] font-semibold text-slate-950 transition last:border-r-0"
          style={{ width: `${w}%`, minWidth: batch === 1 ? 3 : 0, background: CODECS[s.spec.id].color, opacity: sel >= 0 && !selected ? 0.25 : 1, outline: selected ? '2px solid white' : 'none', outlineOffset: -2 }}>
          {w > 7 && <span className="truncate px-1">{batch === 1 ? CODECS[s.spec.id].short : `${g.last - g.first}`}</span>}
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
