/**
 * 自包含的对照基准：`npm run bench:quick`（< 15 s，零外部文件依赖）。
 *
 * 6 条确定性合成流覆盖六种流形：分号表格、准周期 P=73、2D 光栅 W=113、
 * 4 通道传感器 s=4、DNA 四符号马尔可夫、高熵噪声。
 *
 * 每个 UCZ 结果都做完整往返并用 SHA-256 校验；任何往返不一致都让进程失败。
 * 每个流的 UCZ 体积也与 `bench-public-baseline.json` 锁定比较。压缩器有意
 * 改变字节时，用 `npm run bench:quick -- --update-baseline` 明确更新基线，
 * 并在提交里说明原因。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { compressAdaptive, decompress } from '../dist/index.js'

const BASELINE_PATH = fileURLToPath(new URL('./bench-public-baseline.json', import.meta.url))
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const updateBaseline = process.argv.includes('--update-baseline')

const xorshift = (seed) => { let s = seed >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s } }

function tabular(rows = 1400, seed = 0x1234) {
  const r = xorshift(seed), out = ['id;name;weight;score;flag']
  for (let i = 0; i < rows; i++) out.push(`${i};item${i % 37};${(r() % 1000) / 10};${(r() % 100000) / 1000};${i % 2}`)
  return new TextEncoder().encode(out.join('\n') + '\n')
}
function quasiPeriodic(period, rows, seed) {
  const r = xorshift(seed), out = new Uint8Array(period * rows)
  for (let i = 0; i < out.length; i++) {
    const base = Math.round(64 + 48 * Math.sin((2 * Math.PI * (i % period)) / period))
    out[i] = (base + (r() % 9) - 4) & 0xff
  }
  return out
}
function raster2d(width, rows, seed) {
  const r = xorshift(seed), out = new Uint8Array(width * rows)
  for (let y = 0; y < rows; y++) {
    const edge = (y * 7 + 13) % width
    for (let x = 0; x < width; x++) out[y * width + x] = x === edge ? 0x80 : x > edge && x < edge + 3 ? 0xc0 : 0x00
    if (r() % 5 === 0) out[y * width + ((edge + 5) % width)] = 0xff
  }
  return out
}
function multiChannel(channels, frames, seed) {
  const r = xorshift(seed), out = new Uint8Array(channels * frames), base = new Array(channels).fill(0).map(() => r() % 64)
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) {
    base[c] = (base[c] + ((r() % 7) - 3) + 256) % 256
    out[f * channels + c] = base[c]
  }
  return out
}
function dna(length, seed) {
  const r = xorshift(seed), out = new Uint8Array(length), sym = [0x41, 0x43, 0x47, 0x54]
  let prev = 0
  for (let i = 0; i < length; i++) { prev = (prev * 3 + (r() % 4)) & 3; out[i] = sym[(prev + (r() % 3 === 0 ? 1 : 0)) & 3] }
  return out
}
function noise(bytes, seed) {
  const r = xorshift(seed), out = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) out[i] = r() & 0xff
  return out
}

const streams = [
  ['tabular CSV', tabular()],
  ['quasi-periodic P=73', quasiPeriodic(73, 400, 0x51)],
  ['2D raster W=113', raster2d(113, 220, 0x77)],
  ['4-channel sensor s=4', multiChannel(4, 4000, 0x33)],
  ['DNA 4-symbol Markov', dna(65536, 0xabc)],
  ['high-entropy noise', noise(49152, 0x99)],
]

const sha = (b) => createHash('sha256').update(b).digest('hex')
const corpusHash = createHash('sha256')
for (const [name, buf] of streams) corpusHash.update(name).update('\0').update(buf)

const t0 = Date.now()
const lines = ['| stream | raw | gzip -9 | UCZ | ratio | rt |', '|---|---|---|---|---|---|']
const actual = { version: 1, corpusSha256: corpusHash.digest('hex'), streams: {}, total: { raw: 0, ucz: 0 } }
const failures = []
const roundtripFailures = []
let tr = 0, tg = 0, tu = 0
for (const [name, buf] of streams) {
  const enc = await compressAdaptive(new Uint8Array(buf))
  const back = await decompress(enc.container)
  const rt = back.length === buf.length && sha(back) === sha(buf)
  if (!rt) {
    const message = `${name}: roundtrip mismatch`
    failures.push(message)
    roundtripFailures.push(message)
  }
  const gz = gzipSync(buf, { level: 9 }).length
  tr += buf.length; tg += gz; tu += enc.container.length
  actual.streams[name] = { raw: buf.length, sha256: sha(buf), ucz: enc.container.length }
  actual.total.raw += buf.length
  actual.total.ucz += enc.container.length
  lines.push(`| ${name} | ${buf.length.toLocaleString()} | ${gz.toLocaleString()} | **${enc.container.length.toLocaleString()}** | ${((enc.container.length / buf.length) * 100).toFixed(2)}% | ${rt ? '✅' : '❌'} |`)
}
lines.push(`| **total** | ${tr.toLocaleString()} | ${tg.toLocaleString()} | **${tu.toLocaleString()}** | ${((tu / tr) * 100).toFixed(2)}% | |`)

let baseline = null
if (existsSync(BASELINE_PATH)) {
  try { baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) }
  catch (err) { if (!updateBaseline) failures.push(`cannot read baseline ${BASELINE_PATH}: ${err.message}`) }
}
if (!baseline && !updateBaseline) {
  failures.push(`missing baseline ${BASELINE_PATH}; run npm run bench:quick -- --update-baseline`)
}
if (baseline) {
  for (const [name, now] of Object.entries(actual.streams)) {
    const locked = baseline.streams?.[name]
    if (!locked) { failures.push(`${name}: no baseline entry`); continue }
    if (locked.raw !== now.raw) failures.push(`${name}: raw ${now.raw} B != baseline ${locked.raw} B`)
    if (locked.sha256 !== now.sha256) failures.push(`${name}: corpus SHA-256 changed`)
    if (locked.ucz !== now.ucz) {
      const delta = now.ucz - locked.ucz
      failures.push(`${name}: UCZ ${now.ucz} B != baseline ${locked.ucz} B (${delta >= 0 ? '+' : ''}${delta})`)
    }
  }
  for (const name of Object.keys(baseline.streams ?? {})) {
    if (!(name in actual.streams)) failures.push(`${name}: baseline stream no longer generated`)
  }
  if (baseline.total?.ucz !== actual.total.ucz) {
    const delta = actual.total.ucz - (baseline.total?.ucz ?? 0)
    failures.push(`total: UCZ ${actual.total.ucz} B != baseline ${baseline.total?.ucz} B (${delta >= 0 ? '+' : ''}${delta})`)
  }
}

let commit = 'unknown'
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
} catch { /* not a git checkout */ }
const maxRss = process.resourceUsage().maxRSS
const peakMiB = maxRss > 0 ? (maxRss / 1024).toFixed(0) : (process.memoryUsage().rss / 1024 / 1024).toFixed(0)

console.log('\n### UCZ quick benchmark (`npm run bench:quick`)\n')
console.log(lines.join('\n'))
console.log(`\nUCZ 相对 gzip -9：${(tg / tu).toFixed(2)}× 更小；耗时 ${((Date.now() - t0) / 1000).toFixed(1)} s`)
console.log(`commit ${commit} · corpus SHA-256 ${actual.corpusSha256} · threads ${process.env.UCZ_THREADS ?? 'auto'} · node ${process.version} · peak RSS ${peakMiB} MiB`)

if (updateBaseline) {
  // Size changes are the reason to run this flag; roundtrip failures are not.
  if (roundtripFailures.length > 0) {
    console.error(`\nbaseline NOT updated because the run failed:\n- ${failures.join('\n- ')}`)
    process.exitCode = 1
  } else {
    writeFileSync(BASELINE_PATH, JSON.stringify(actual, null, 2) + '\n')
    console.log(`\nbaseline updated: ${BASELINE_PATH}`)
    if (failures.length > 0) console.log(`rewrote ${failures.length} prior size/corpus difference(s)`)
  }
} else if (failures.length > 0) {
  console.error(`\nbenchmark FAILED:\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log(`\nbaseline: OK (${Object.keys(actual.streams).length} streams, ${actual.total.ucz.toLocaleString()} B total)`)
}
