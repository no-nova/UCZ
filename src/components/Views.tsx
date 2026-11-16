import { useEffect, useRef, useState } from 'react'
import { drawDigram, drawHilbert, drawIso, drawPca, type MapModel } from '../lib/viz'

interface SegLite {
  start: number
  end: number
  label: string
  cls: string
}

export function HilbertView(props: {
  model: MapModel
  colors: number[][]
  sel: number
  vmax: number
  segs: SegLite[]
  blockVal: Float32Array
  valueName: string
  B: number
  lang?: 'en' | 'zh'
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const { model, colors, sel, vmax, segs, blockVal, valueName, B, lang = 'zh' } = props
  useEffect(() => {
    if (ref.current) drawHilbert(ref.current, model, colors, sel, vmax)
  }, [model, colors, sel, vmax])

  const onMove = (e: React.MouseEvent) => {
    const cv = ref.current
    if (!cv) return
    const r = cv.getBoundingClientRect()
    const px = Math.floor(((e.clientX - r.left) / r.width) * model.side)
    const py = Math.floor(((e.clientY - r.top) / r.height) * model.side)
    const i = py * model.side + px
    if (px < 0 || py < 0 || px >= model.side || py >= model.side || model.dOf[i] < 0) return setTip(null)
    const off = model.dOf[i] * model.unit
    const sg = segs[model.seg[i]]
    setTip({
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      text: lang === 'en'
        ? `offset ${off.toLocaleString()} · ${sg ? 'region #' + model.seg[i] : 'unmapped'}\n${valueName} ${blockVal[model.blk[i]].toFixed(2)} bit/byte · block #${model.blk[i]} (${B} B)`
        : `偏移 ${off.toLocaleString()} · ${sg?.label ?? ''}\n${valueName} ${blockVal[model.blk[i]].toFixed(2)} bit/字节 · 块 #${model.blk[i]} (${B}B)`,
    })
  }
  return (
    <div className="relative">
      <canvas
        ref={ref}
        onMouseMove={onMove}
        onMouseLeave={() => setTip(null)}
        className="aspect-square w-full rounded-xl border border-white/10 bg-black/40"
        style={{ imageRendering: 'pixelated' }}
      />
      {tip && (
        <div
          className="pointer-events-none absolute z-10 max-w-[260px] whitespace-pre-line rounded-lg border border-white/15 bg-[#0b1220]/95 px-3 py-2 text-xs text-slate-200 shadow-xl"
          style={{ left: Math.min(tip.x + 12, 9999), top: tip.y + 12 }}
        >
          {tip.text}
        </div>
      )}
    </div>
  )
}

export function IsoView(props: { blockVal: Float32Array; blockSeg: Int32Array; colors: number[][]; sel: number; vmax: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (ref.current) drawIso(ref.current, props.blockVal, props.blockSeg, props.colors, props.sel, props.vmax)
  }, [props.blockVal, props.blockSeg, props.colors, props.sel, props.vmax])
  return <canvas ref={ref} className="w-full rounded-xl border border-white/10 bg-gradient-to-b from-[#0a1222] to-[#060a13]" />
}

export function DigramView(props: {
  data: Uint8Array
  segs: { start: number; end: number }[]
  colors: number[][]
  sel: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (ref.current) drawDigram(ref.current, props.data, props.segs, props.colors, props.sel)
  }, [props.data, props.segs, props.colors, props.sel])
  return (
    <canvas
      ref={ref}
      className="aspect-square w-full rounded-xl border border-white/10 bg-black/40"
      style={{ imageRendering: 'pixelated' }}
    />
  )
}

export function PcaView(props: {
  pts?: { x: number; y: number; block: number }[] | null
  blockSeg: Int32Array
  colors: number[][]
  sel: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (ref.current) drawPca(ref.current, props.pts ?? [], props.blockSeg, props.colors, props.sel)
  }, [props.pts, props.blockSeg, props.colors, props.sel])
  return <canvas ref={ref} className="w-full rounded-xl border border-white/10 bg-black/40" />
}
