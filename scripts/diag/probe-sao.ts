// P6-4：sao 专项诊断。
//   1. 当前分段 / 规则 / v15 是否被选中；
//   2. 28 字节记录按列拆开：各列 Order-0 / Order-1 / Delta 后的熵；
//   3. TRANSPOSE_GROUP_V3 在 v13 / v15（以及关掉 a2 / 混洗器）下的实际载荷大小。
// 用法：node scripts/diag/run.mjs probe-sao [切片字节数]
import { readFile } from 'node:fs/promises'
import { compressAdaptive, encodeTerrainGroup, ID } from '../../src/lib/codec'
import { apm2Tuning, encodeCM, mixer2Tuning } from '../../src/lib/coder'

const limit = Number(process.argv[2] ?? 2 * 1024 * 1024)
const raw = await readFile('/tmp/corpus/sao')
const data = raw.subarray(0, Math.min(limit, raw.length))

// ---- 1. 分段与规则 ----
const comp = await compressAdaptive(data, undefined, { serial: true })
console.log(JSON.stringify({
  slice: data.length, ucz: comp.container.length, ver: comp.container[3],
  segs: comp.segs.map(s => ({ spec: s.spec, label: s.label, raw: s.rawLen, comp: s.compLen })),
}))

const spec = comp.segs[0].spec
const width = spec.s
if (!width || width < 2) { console.log('该段不是转置规则，跳过列分析'); process.exit(0) }

// ---- 2. 逐列统计 ----
const rows = width
const col = Array.from({ length: width }, () => new Uint8Array(Math.floor(data.length / width)))
for (let i = 0; i * width + width <= data.length; i++) {
  for (let c = 0; c < width; c++) col[c][i] = data[i * width + c]
}
const ent = (buf: Uint8Array): number => {
  const h = new Float64Array(256)
  for (let i = 0; i < buf.length; i++) h[buf[i]]++
  let e = 0
  for (let i = 0; i < 256; i++) if (h[i]) { const p = h[i] / buf.length; e -= p * Math.log2(p) }
  return e
}
const ent1 = (buf: Uint8Array): number => {
  const h = new Float64Array(65536)
  for (let i = 1; i < buf.length; i++) h[(buf[i - 1] << 8) | buf[i]]++
  let e = 0, n = buf.length - 1
  const prev = new Float64Array(256)
  for (let i = 0; i < n; i++) prev[buf[i]]++
  for (let i = 0; i < 65536; i++) if (h[i]) {
    const p = h[i] / n, pp = prev[i >> 8] / n
    e -= p * Math.log2(p / pp)
  }
  return e
}
const delta = (buf: Uint8Array): Uint8Array => {
  const o = new Uint8Array(buf.length)
  let prev = 0
  for (let i = 0; i < buf.length; i++) { o[i] = (buf[i] - prev) & 255; prev = buf[i] }
  return o
}
console.log('col  H0   H1   HΔ   |col|')
for (let c = 0; c < width; c++) {
  console.log(`${String(c).padStart(3)}  ${ent(col[c]).toFixed(2)} ${ent1(col[c]).toFixed(2)} ${ent(delta(col[c])).toFixed(2)}  ${col[c].length}`)
}

// ---- 2b. 逐列独立 CM（每列一套新模型）vs 一条拼接 CM ----
let sumBin = 0, sumDelta = 0
const perCol: Record<string, number> = {}
for (let c = 0; c < width; c++) {
  const a = encodeCM(col[c], 'bin', 1, 1, undefined, 0, undefined, undefined, 'v13', 0).length
  const d = encodeCM(delta(col[c]), 'bin', 1, 1, undefined, 0, undefined, undefined, 'v13', 0).length
  perCol[c] = Math.min(a, d)
  sumBin += a; sumDelta += Math.min(a, d)
}
const cat = new Uint8Array(width * col[0].length)
for (let c = 0; c < width; c++) cat.set(col[c], c * col[0].length)
const catBin = encodeCM(cat, 'bin', 1, 1, undefined, 0, undefined, undefined, 'v13', 0).length
console.log(JSON.stringify({ perCol, sumBin, sumPerColBest: sumDelta, catBin }))

// ---- 3. 整组 v13 / v15 的载荷大小（四种调参组合）----
const parts = [data]
const size = (kernel: 'v13' | 'v15') => encodeTerrainGroup(parts, spec, undefined, undefined, undefined, [0], kernel).length
const v13 = size('v13')
const v15 = size('v15')
mixer2Tuning.on = false
const v15NoMix = size('v15')
mixer2Tuning.on = true
apm2Tuning.on = false
const v15NoA2 = size('v15')
apm2Tuning.on = true
console.log(JSON.stringify({
  spec, width,
  v13, v15, 'v15%': +((v15 / v13 - 1) * 100).toFixed(3),
  v15NoMix, 'noMix%': +((v15NoMix / v13 - 1) * 100).toFixed(3),
  v15NoA2, 'noA2%': +((v15NoA2 / v13 - 1) * 100).toFixed(3),
  isTransposeV3: spec.id === ID.TRANSPOSE_GROUP_V3,
}))
