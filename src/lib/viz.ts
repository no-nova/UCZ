// 可视化:希尔伯特折叠地形图、等距 3D 地形、字节对图、PCA 降维散点

export function d2xy(side: number, d: number): [number, number] {
  let x = 0
  let y = 0
  let t = d
  for (let s = 1; s < side; s *= 2) {
    const rx = 1 & (t >> 1)
    const ry = 1 & (t ^ rx)
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x
        y = s - 1 - y
      }
      const tmp = x
      x = y
      y = tmp
    }
    x += s * rx
    y += s * ry
    t = t >> 2
  }
  return [x, y]
}

export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)
const rgbStr = (c: number[], f: number, a = 1) =>
  `rgba(${clamp(Math.round(c[0] * f), 0, 255)},${clamp(Math.round(c[1] * f), 0, 255)},${clamp(Math.round(c[2] * f), 0, 255)},${a})`

export interface MapModel {
  side: number
  unit: number
  dOf: Int32Array
  seg: Int32Array
  blk: Int32Array
  h: Float32Array
  tex: Uint8Array
}

export function buildMapModel(data: Uint8Array, B: number, blockVal: Float32Array, blockSeg: Int32Array): MapModel {
  const len = data.length
  const unit = len > 65536 ? Math.ceil(len / 65536) : 1
  const px = Math.max(1, Math.ceil(len / unit))
  let side = 16
  while (side * side < px) side *= 2
  const N = side * side
  const m: MapModel = {
    side,
    unit,
    dOf: new Int32Array(N).fill(-1),
    seg: new Int32Array(N),
    blk: new Int32Array(N),
    h: new Float32Array(N),
    tex: new Uint8Array(N),
  }
  const nb = blockVal.length
  for (let d = 0; d < px; d++) {
    const [x, y] = d2xy(side, d)
    const i = y * side + x
    const off = d * unit
    const b = Math.min(nb - 1, Math.floor(off / B))
    m.dOf[i] = d
    m.seg[i] = blockSeg[b]
    m.blk[i] = b
    m.h[i] = blockVal[b]
    m.tex[i] = data[Math.min(len - 1, off)]
  }
  return m
}

export function drawHilbert(cv: HTMLCanvasElement, m: MapModel, colors: number[][], sel: number, vmax: number) {
  const side = m.side
  cv.width = side
  cv.height = side
  const ctx = cv.getContext('2d')!
  const img = ctx.createImageData(side, side)
  const H = m.h
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const i = y * side + x
      const o = i * 4
      if (m.dOf[i] < 0) {
        img.data[o] = 8
        img.data[o + 1] = 12
        img.data[o + 2] = 22
        img.data[o + 3] = 255
        continue
      }
      const h = H[i]
      const nb = (j: number) => (j >= 0 && j < H.length && m.dOf[j] >= 0 ? H[j] : h)
      const xr = x + 1 < side ? nb(i + 1) : h
      const xl = x > 0 ? nb(i - 1) : h
      const yd = y + 1 < side ? nb(i + side) : h
      const yu = y > 0 ? nb(i - side) : h
      const shade = clamp(1 - 0.09 * (xr - xl + yd - yu), 0.6, 1.4)
      let contour = 1
      if (Math.floor(h) !== Math.floor(xr) || Math.floor(h) !== Math.floor(yd)) contour = 1.22
      const base = 0.2 + 0.8 * clamp(h / vmax, 0, 1)
      const tex = 0.9 + 0.2 * (m.tex[i] / 255)
      const sg = m.seg[i]
      const dim = sel >= 0 && sg !== sel ? 0.2 : 1
      const c = colors[sg] || [120, 120, 120]
      const f = base * shade * contour * tex * dim
      img.data[o] = clamp(c[0] * f, 0, 255)
      img.data[o + 1] = clamp(c[1] * f, 0, 255)
      img.data[o + 2] = clamp(c[2] * f, 0, 255)
      img.data[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
}

export function drawIso(
  cv: HTMLCanvasElement,
  blockVal: Float32Array,
  blockSeg: Int32Array,
  colors: number[][],
  sel: number,
  vmax: number,
) {
  const nb = blockVal.length
  const group = Math.ceil(nb / 4096)
  const cells = Math.ceil(nb / group)
  let side = 8
  while (side * side < cells) side *= 2
  const W = 900
  const tw = (W * 0.96) / side
  const th = tw / 2
  const base = side * th
  const hmax = base * 0.32
  const Hh = Math.ceil(base + hmax + 30)
  cv.width = W
  cv.height = Hh
  const ctx = cv.getContext('2d')!
  ctx.clearRect(0, 0, W, Hh)
  const list: { gx: number; gy: number; v: number; sg: number }[] = []
  for (let c = 0; c < cells; c++) {
    const [gx, gy] = d2xy(side, c)
    let v = 0
    let cnt = 0
    for (let b = c * group; b < Math.min(nb, (c + 1) * group); b++) {
      v += blockVal[b]
      cnt++
    }
    list.push({ gx, gy, v: v / Math.max(1, cnt), sg: blockSeg[c * group] })
  }
  list.sort((a, b) => a.gx + a.gy - (b.gx + b.gy))
  for (const c of list) {
    const col = colors[c.sg] || [120, 120, 120]
    const dim = sel >= 0 && c.sg !== sel ? 0.25 : 1
    const h = Math.max(1.5, (c.v / vmax) * hmax)
    const cx = W / 2 + ((c.gx - c.gy) * tw) / 2
    const cy = 10 + hmax + ((c.gx + c.gy) * th) / 2 + th / 2
    const topY = cy - h
    // 左侧面
    ctx.fillStyle = rgbStr(col, 0.5 * dim + 0.1)
    ctx.beginPath()
    ctx.moveTo(cx - tw / 2, topY)
    ctx.lineTo(cx, topY + th / 2)
    ctx.lineTo(cx, cy + th / 2)
    ctx.lineTo(cx - tw / 2, cy)
    ctx.closePath()
    ctx.fill()
    // 右侧面
    ctx.fillStyle = rgbStr(col, 0.32 * dim + 0.08)
    ctx.beginPath()
    ctx.moveTo(cx + tw / 2, topY)
    ctx.lineTo(cx, topY + th / 2)
    ctx.lineTo(cx, cy + th / 2)
    ctx.lineTo(cx + tw / 2, cy)
    ctx.closePath()
    ctx.fill()
    // 顶面
    ctx.fillStyle = rgbStr(col, (0.55 + 0.6 * (c.v / vmax)) * dim + 0.1)
    ctx.beginPath()
    ctx.moveTo(cx, topY - th / 2)
    ctx.lineTo(cx + tw / 2, topY)
    ctx.lineTo(cx, topY + th / 2)
    ctx.lineTo(cx - tw / 2, topY)
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'
    ctx.lineWidth = 0.6
    ctx.stroke()
  }
}

export function drawDigram(
  cv: HTMLCanvasElement,
  data: Uint8Array,
  segs: { start: number; end: number }[],
  segColors: number[][],
  sel: number,
) {
  cv.width = 256
  cv.height = 256
  const ctx = cv.getContext('2d')!
  const K = segs.length
  // Aggregate colors per byte pair rather than K × 65,536 counters.
  const total = new Uint32Array(65536)
  const red = new Uint32Array(65536), green = new Uint32Array(65536), blue = new Uint32Array(65536)
  const maxPairs = 3_000_000
  for (let k = 0; k < K; k++) {
    if (sel >= 0 && k !== sel) continue
    const sg = segs[k]
    const len = sg.end - sg.start
    const step = Math.max(1, Math.ceil(len / (maxPairs / Math.max(1, K))))
    for (let i = sg.start; i + 1 < sg.end; i += step) {
      const c = data[i] * 256 + data[i + 1]
      total[c]++
      red[c] += segColors[k][0]
      green[c] += segColors[k][1]
      blue[c] += segColors[k][2]
    }
  }
  let mx = 1
  for (let i = 0; i < 65536; i++) if (total[i] > mx) mx = total[i]
  const img = ctx.createImageData(256, 256)
  const lm = Math.log(1 + mx)
  for (let a = 0; a < 256; a++) {
    for (let b = 0; b < 256; b++) {
      const c = a * 256 + b
      const o = ((255 - b) * 256 + a) * 4
      let r = 8,
        g = 12,
        bl = 22
      if (total[c] > 0) {
        const cr = red[c], cg = green[c], cb = blue[c]
        const t = total[c]
        const br = 0.35 + 0.65 * Math.pow(Math.log(1 + t) / lm, 0.8)
        r = (cr / t) * br
        g = (cg / t) * br
        bl = (cb / t) * br
      }
      img.data[o] = r
      img.data[o + 1] = g
      img.data[o + 2] = bl
      img.data[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
}

export function drawPca(
  cv: HTMLCanvasElement,
  pts: { x: number; y: number; block: number }[] | null | undefined,
  blockSeg: Int32Array,
  colors: number[][],
  sel: number,
) {
  const W = 480
  const H = 320
  cv.width = W
  cv.height = H
  const ctx = cv.getContext('2d')!
  ctx.clearRect(0, 0, W, H)
  ctx.strokeStyle = 'rgba(148,163,184,0.12)'
  ctx.lineWidth = 1
  for (let i = 1; i < 8; i++) {
    ctx.beginPath()
    ctx.moveTo((W * i) / 8, 0)
    ctx.lineTo((W * i) / 8, H)
    ctx.stroke()
  }
  for (let i = 1; i < 5; i++) {
    ctx.beginPath()
    ctx.moveTo(0, (H * i) / 5)
    ctx.lineTo(W, (H * i) / 5)
    ctx.stroke()
  }
  const pad = 22
  const list = Array.isArray(pts) ? pts : []
  // 先画未选中,再画选中
  for (const pass of [0, 1]) {
    for (const p of list) {
      const sg = blockSeg[p.block]
      const isSel = sel < 0 || sg === sel
      if ((pass === 1) !== isSel) continue
      const c = colors[sg] || [150, 150, 150]
      ctx.fillStyle = rgbStr(c, 1, isSel ? 0.75 : 0.12)
      ctx.beginPath()
      ctx.arc(pad + p.x * (W - 2 * pad), H - pad - p.y * (H - 2 * pad), isSel ? 4 : 3, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}
