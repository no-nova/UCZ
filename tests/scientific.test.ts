/**
 * P31.0：科学仪器测试（`ucz inspect` / `ucz ncd` / CLI 往返）。
 *
 * 所有断言都基于**在线统计量**，不使用文件名、目录名或任何领域先验 —— 这正是
 * 我们要证明的东西：UCZ 只靠数据本身的几何/统计性质就能做分类与聚类。
 */
import assert from 'node:assert/strict'
import { compressAdaptive, decompress } from '../src/lib/codec'
import { formatInspectionReport, inspectContainer, inspectStream, isContainer } from '../src/lib/inspect'
import { computeNCD, computeNCDMatrix, formatNCDMatrixReport } from '../src/lib/ncd'
import { fastDeepEqual } from './fast-equal'

function xorshift(seed: number): () => number {
  let s = seed >>> 0
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s }
}

function csvTable(rows: number, seed: number): Uint8Array {
  const r = xorshift(seed)
  let text = 'id,name,weight,score,flag\n'
  for (let i = 0; i < rows; i++) text += `${i},item${i % 37},${(r() % 1000) / 10},${(r() % 100000) / 1000},${i % 2}\n`
  return new TextEncoder().encode(text)
}

function raster2d(width: number, rows: number): Uint8Array {
  const out = new Uint8Array(width * rows)
  for (let y = 0; y < rows; y++) for (let x = 0; x < width; x++) {
    const edge = (x + 2 * y) % 61 === 0 || (x - 3 * y + 2000) % 97 === 0
    out[y * width + x] = edge ? 0xff : (y % 5 === 0 ? 0x00 : 0x00)
  }
  return out
}

function multiChannel(channels: number, frames: number, seed: number): Uint8Array {
  const r = xorshift(seed)
  const out = new Uint8Array(channels * frames)
  const base = new Array(channels).fill(0).map(() => r() % 64)
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) {
    base[c] = (base[c] + ((r() % 7) - 3) + 256) % 256
    out[f * channels + c] = base[c]
  }
  return out
}

function prose(words: number, seed: number, offset: number): Uint8Array {
  const r = xorshift(seed)
  const vocab = ['the', 'compression', 'model', 'entropy', 'context', 'stream', 'entropy', 'adaptive', 'window', 'bits']
  let text = ''
  for (let i = 0; i < words; i++) text += vocab[(r() + offset) % vocab.length] + (i % 11 === 10 ? '.\n' : ' ')
  return new TextEncoder().encode(text)
}

function code(seed: number, variant: number): Uint8Array {
  const r = xorshift(seed)
  let text = '#include <stdio.h>\n'
  for (let i = 0; i < 220; i++) text += `static int fn${i}(int a, int b) { int c = a ${variant ? '+' : '*'} b; if (c > ${r() % 1000}) return c - a; return b; }\n`
  return new TextEncoder().encode(text)
}

export async function testInspectMicroscope(): Promise<void> {
  const csv = csvTable(600, 0x1234)
  const table = await inspectStream(csv, { compress: false })
  assert.ok(table.fingerprint.printableAsciiRatio > 0.95, 'CSV 应几乎全可打印')
  assert.ok(table.fingerprint.detectedDelimiters.comma > 100, '应识别逗号分隔符')
  assert.ok(table.fingerprint.detectedDelimiters.newline > 100, '应识别换行')
  assert.equal(table.fingerprint.inferredManifoldClass, 'tabular-ascii')
  assert.ok(formatInspectionReport(table).includes('Residual Information Microscope'))

  const raster = raster2d(113, 220)
  const rInfo = await inspectStream(raster, { compress: false })
  assert.ok(rInfo.fingerprint.flatByteRatio > 0.9, '位图应被 0x00/0xFF 主导')
  assert.ok(rInfo.fingerprint.detectedScanPeriod > 0, '应给出扫描线周期')
  assert.equal(rInfo.fingerprint.inferredManifoldClass, '2d-periodic-raster')

  const mc = multiChannel(4, 4000, 0x77)
  const mInfo = await inspectStream(mc, { compress: false })
  assert.ok(mInfo.fingerprint.byteLength === mc.length)

  // 容器解剖必须与真实容器一致，并且能直接吃 `.ucz` 字节。
  const enc = await compressAdaptive(csv, undefined, { level: 'fast' })
  assert.ok(isContainer(enc.container))
  const anatomy = inspectContainer(enc.container)
  assert.equal(anatomy.totalRawBytes, csv.length)
  assert.equal(anatomy.totalCompressedBytes, enc.container.length)
  assert.ok(anatomy.segments.length >= 1)
  assert.ok(anatomy.segments.every(s => s.transformName.length > 0))
  const sumComp = anatomy.segments.reduce((n, s) => n + s.compressedBytes, 0)
  assert.equal(sumComp + anatomy.headerBytes, enc.container.length)
  fastDeepEqual(decompress(enc.container), csv, 'inspect 容器必须可解回')
  console.log(`[inspect] csv uz=${enc.container.length} ver=${anatomy.containerVersion} segs=${anatomy.segments.length} scan=${rInfo.fingerprint.detectedScanPeriod}`)
}

export async function testNcdClustering(): Promise<void> {
  // 三个家族各两个样本：散文 / 代码 / 多通道传感器。名字刻意不含家族信息。
  const items = [
    { name: 's1', data: prose(900, 0x51, 0) },
    { name: 's2', data: prose(900, 0x99, 1) },
    { name: 'c1', data: code(0x31, 0) },
    { name: 'c2', data: code(0x32, 1) },
    { name: 'm1', data: multiChannel(4, 3000, 0x11) },
    { name: 'm2', data: multiChannel(4, 3000, 0x22) },
  ]
  const family = ['text', 'text', 'code', 'code', 'signal', 'signal']
  const res = await computeNCDMatrix(items)
  assert.equal(res.names.length, 6)
  for (let i = 0; i < 6; i++) {
    assert.equal(res.matrix[i][i], 0, '对角线必须为 0')
    for (let j = 0; j < 6; j++) assert.equal(res.matrix[i][j], res.matrix[j][i], 'NCD 必须对称')
  }
  for (let i = 0; i < 6; i++) {
    const nb = res.nearest[i]
    assert.ok(nb.index >= 0, `${items[i].name} 应有最近邻`)
    assert.equal(family[nb.index], family[i], `${items[i].name} 的最近邻应属于同一家族，得到 ${res.names[nb.index]}`)
  }
  const pair = await computeNCD(items[0].data, items[0].data)
  assert.ok(pair.ncd < 0.05, `NCD(x,x) 应接近 0，得到 ${pair.ncd}`)
  const intra = Math.max(res.matrix[0][1], res.matrix[2][3])
  const inter = Math.min(res.matrix[0][2], res.matrix[0][4], res.matrix[2][4])
  assert.ok(intra < inter, `族内距离(${intra.toFixed(3)}) 应小于族间距离(${inter.toFixed(3)})`)
  assert.ok(formatNCDMatrixReport(res).includes('Nearest neighbour'))
  console.log(`[ncd] intra=${intra.toFixed(4)} inter=${inter.toFixed(4)} nn=${res.nearest.map(r => res.names[r.index]).join(',')}`)
}

export async function testScientificInstruments(): Promise<void> {
  await testInspectMicroscope()
  await testNcdClustering()
}
