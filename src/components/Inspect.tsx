import type { Dict } from '../lib/i18n'
import type { ContainerAnatomy, ManifoldFingerprint, ResidualProfile } from '../lib/inspect'
import type { NCDMatrixResult } from '../lib/ncd'
import { formatBytes } from '../utils/format-bytes'

/** Bar chart + sparkline for the local conditional-entropy profile. */
export function ResidualPanel(props: {
  t: Dict
  profile: ResidualProfile | null
  busy: boolean
  onRun: () => void
  fingerprint: ManifoldFingerprint | null
  anatomy: ContainerAnatomy | null
}) {
  const { t, profile, fingerprint, anatomy } = props
  const bars = profile?.binsBpb ?? []
  const peak = profile ? Math.max(profile.maxBpb, 1) : 1
  const main = anatomy?.segments.reduce((best, s) => (s.compressedBytes > best.compressedBytes ? s : best), anatomy.segments[0])

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.035] p-5 backdrop-blur">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-white">{t.residualTitle}</h3>
          <p className="mt-1 mb-3 max-w-3xl text-xs leading-relaxed text-slate-400">{t.residualSub}</p>
        </div>
        <button
          disabled={props.busy}
          onClick={props.onRun}
          className="rounded-lg border border-cyan-300/40 px-3 py-2 text-xs text-cyan-200 hover:bg-cyan-300/10 disabled:opacity-40"
        >
          {props.busy ? t.inspecting : profile ? t.inspect + ' ↻' : t.inspect}
        </button>
      </div>

      {fingerprint && (
        <dl className="mt-1 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t.manifold} value={fingerprint.inferredManifoldClass} />
          <Field label="H₀" value={`${fingerprint.entropyH0.toFixed(3)} bit/B`} />
          <Field label={t.stride} value={fingerprint.detectedStride > 1 ? String(fingerprint.detectedStride) : '—'} />
          <Field label={t.scanPeriod} value={fingerprint.detectedScanPeriod > 1 ? String(fingerprint.detectedScanPeriod) : '—'} />
          {anatomy && <Field label={t.container} value={`v${anatomy.containerVersion} · ${formatBytes(anatomy.totalCompressedBytes)}`} />}
          {main && <Field label={t.rule} value={`${main.transformName}${main.stride > 1 ? ` s=${main.stride}` : ''}`} />}
          {main?.context && <Field label={t.contextLabel} value={main.context} />}
          {main && <Field label={t.flags} value={main.flags || '—'} />}
        </dl>
      )}

      {profile && (
        <>
          <div className="mt-4 flex h-28 items-end gap-[1px] overflow-hidden rounded-lg border border-white/10 bg-black/30 p-2">
            {bars.map((bpb, i) => {
              const h = Math.max(2, Math.round((bpb / peak) * 100))
              const hot = bpb > profile.meanBpb + Math.max(1, profile.meanBpb * 0.3)
              return (
                <div
                  key={i}
                  title={`${i * profile.blockSize}–${(i + 1) * profile.blockSize} B · ${bpb.toFixed(2)} bit/B`}
                  className={'flex-1 rounded-sm ' + (hot ? 'bg-rose-400/80' : 'bg-cyan-300/70')}
                  style={{ height: `${h}%` }}
                />
              )
            })}
          </div>
          <p className="mt-2 font-mono text-sm tracking-tight text-cyan-200">{profile.sparkline}</p>
          <p className="mt-1 text-xs text-slate-500">
            {t.residualStats(bars.length, profile.blockSize, profile.meanBpb.toFixed(2), profile.minBpb.toFixed(2), profile.maxBpb.toFixed(2))}
          </p>
          <div className="mt-3 text-xs text-slate-300">
            <span className="text-slate-400">{t.anomalies}: </span>
            {profile.anomalies.length === 0 ? (
              <span className="text-slate-500">{t.noAnomalies}</span>
            ) : (
              <span className="space-x-3">
                {profile.anomalies.slice(0, 8).map((a, i) => (
                  <span key={i} className="tabular-nums">
                    <b className="text-amber-200">{a.offset.toLocaleString()}</b> ({formatBytes(a.length)}, {a.bpb.toFixed(2)} bit/B, {t.anomalyKind[a.kind]})
                  </span>
                ))}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-black/25 px-3 py-2">
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words font-medium text-slate-200">{value}</dd>
    </div>
  )
}

/** Compact N × N UCZ-NCD heat map plus nearest-neighbour pairings. */
export function NcdPanel(props: { t: Dict; result: NCDMatrixResult | null; busy: boolean; count: number; onRun: () => void }) {
  const { t, result } = props
  if (props.count < 2) return null
  const shade = (v: number) => `rgba(34, 211, 238, ${Math.min(0.9, 0.08 + v * 0.8)})`

  return (
    <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.035] p-5 backdrop-blur">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-white">{t.ncdTitle}</h3>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">{t.ncdSub}</p>
        </div>
        <button
          disabled={props.busy}
          onClick={props.onRun}
          className="rounded-lg border border-violet-400/40 px-3 py-2 text-xs text-violet-200 hover:bg-violet-400/10 disabled:opacity-40"
        >
          {props.busy ? t.ncdRunning : t.ncdRun(props.count)}
        </button>
      </div>
      {result && (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-[320px] border-collapse text-left text-xs">
            <thead>
              <tr>
                <th className="py-1 pr-3 font-medium text-slate-500">#</th>
                {result.names.map((n, i) => (
                  <th key={i} title={n} className="px-2 py-1 text-right font-medium text-slate-400">
                    {i + 1}
                  </th>
                ))}
                <th className="px-2 py-1 text-right font-medium text-slate-400">{t.ncdNearest}</th>
              </tr>
            </thead>
            <tbody>
              {result.matrix.map((row, i) => (
                <tr key={i}>
                  <th title={result.names[i]} className="max-w-[12rem] truncate py-1 pr-3 font-medium text-slate-300">
                    {result.names[i]}
                  </th>
                  {row.map((v, j) => (
                    <td
                      key={j}
                      title={`${result.names[i]} ↔ ${result.names[j]}: ${v.toFixed(3)}`}
                      className="px-2 py-1 text-right tabular-nums text-slate-100"
                      style={{ background: i === j ? 'transparent' : shade(v) }}
                    >
                      {i === j ? '—' : v.toFixed(2)}
                    </td>
                  ))}
                  <td className="px-2 py-1 text-right text-slate-400">
                    {result.nearest[i].index < 0 ? '—' : `#${result.nearest[i].index + 1} · ${result.nearest[i].distance.toFixed(2)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-slate-500">{t.ncdNote}</p>
        </div>
      )}
    </section>
  )
}
