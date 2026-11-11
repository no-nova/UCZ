#!/usr/bin/env node
// inspect-structure.mjs — read-only structural forensics for a file or directory.
//
// Purpose: answer "what is in these bytes that the pipeline may be leaving on the
// table?" WITHOUT encoding anything. Every number is a property of the input, so
// the same report can be produced before and after a change and compared.
//
//   node scripts/diag/inspect-structure.mjs <file|dir> [--max-bytes N] [--json]
//                                          [--no-ucsegs] [--samples N]
//
// The JSON document goes to stdout; a compact human table goes to stderr. Nothing
// is written to disk (except a short-lived esbuild bundle in .diag-state/ for the
// optional UCZ segment section, deleted afterwards).
//
// Sections
//   1. entropy    H0/H1/H2 over the whole input, then per 4 KiB block, plus the
//                 Jensen-Shannon divergence between consecutive blocks. That is the
//                 stationarity question: "is one model enough for this input?"
//   2. stride     for d in [1,256]: mutual information I(x_i; x_i+d), equality rate,
//                 and how far the d-lagged difference lowers order-1 entropy.
//                 Detects fixed-width records, interleaved planes, 16/32/64-bit
//                 alignment. The MI is ESTIMATED on a bounded prefix (see
//                 `stride.sampleBytes`), never presented as a full-file figure.
//   3. longrange  greedy LZ77 with a 4-byte hash chain at 64 KiB / 1 MiB / whole
//                 input: matchable byte share, mean match length, repeat-offset hit
//                 rate. This is the redundancy a back-end with a persistent
//                 dictionary would exploit and an independent per-segment CM cannot;
//                 it bounds the "cross-segment dictionary loss" of the design.
//   4. subbyte    per-bit-plane entropy, nibble conditional entropies, and the
//                 independence gap (8*H0 - sum of plane entropies). Positive means
//                 the byte is not eight independent bits, i.e. a bit-plane coder has
//                 cross-plane redundancy to model; <= 0 means it does not.
//   5. ucsegs     the real UCZ segment decision for this input (class histogram,
//                 segment count, largest segments). Needs esbuild; skipped cleanly
//                 if absent.
//
// Honesty rules baked in:
//   * every truncated input says so, in JSON and in the table, and no number from a
//     truncated run is a statement about the whole file;
//   * the LZ pass is greedy with a hash chain, not an optimal parse and not a
//     suffix-array longest-match oracle. "matchableShare" is a lower bound on the
//     redundancy available to a dictionary coder;
//   * nothing here ranks transforms or predicts a container size.

import { readFileSync, readdirSync, statSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, basename, resolve, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const DEFAULT_CAP = 16 * 1024 * 1024
const BLOCK = 4096
const STRIDE_LIMIT = 256
const STRIDE_SAMPLE = 256 * 1024

// ------------------------------------------------------------------ statistics
function byteCounts(data) {
  const c = new Uint32Array(256)
  for (let i = 0; i < data.length; i++) c[data[i]]++
  return c
}

function entropyOf(counts, total) {
  let h = 0
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i]
    if (c) { const p = c / total; h -= p * Math.log2(p) }
  }
  return h
}

const h0 = (data) => (data.length ? entropyOf(byteCounts(data), data.length) : 0)

/** Order-1 byte entropy, computed from the 65,536-cell bigram table. */
function h1(data) {
  if (data.length < 2) return 0
  const bigram = new Uint32Array(1 << 16)
  const prev = new Uint32Array(256)
  const total = data.length - 1
  for (let i = 1; i < data.length; i++) {
    bigram[(data[i - 1] << 8) | data[i]]++
    prev[data[i - 1]]++
  }
  let h = 0
  for (let a = 0; a < 256; a++) {
    const row = prev[a]
    if (!row) continue
    let cond = 0
    const base = a << 8
    for (let b = 0; b < 256; b++) {
      const c = bigram[base | b]
      if (c) { const p = c / row; cond -= p * Math.log2(p) }
    }
    h += (row / total) * cond
  }
  return h
}

/** Order-2 nibble entropy: 12-bit context (high nibble of x[i-2], full x[i-1]). */
function h2(data) {
  if (data.length < 3) return 0
  const ctx = new Uint32Array(1 << 13)
  const joint = new Uint32Array(1 << 17)
  const n = data.length - 2
  for (let i = 2; i < data.length; i++) {
    const c = ((data[i - 2] >>> 4) << 8) | data[i - 1]
    ctx[c]++
    joint[(c << 4) | (data[i] >>> 4)]++
  }
  let h = 0
  for (let c = 0; c < (1 << 12); c++) {
    const tot = ctx[c]
    if (!tot) continue
    let cond = 0
    for (let b = 0; b < 16; b++) {
      const k = joint[(c << 4) | b]
      if (k) { const p = k / tot; cond -= p * Math.log2(p) }
    }
    h += (tot / n) * cond
  }
  return h
}

function jsDivergence(a, b) {
  let na = 0, nb = 0
  for (let i = 0; i < 256; i++) { na += a[i]; nb += b[i] }
  if (!na || !nb) return 0
  let js = 0
  for (let i = 0; i < 256; i++) {
    const p = a[i] / na, q = b[i] / nb, m = (p + q) / 2
    if (p > 0) js += 0.5 * p * Math.log2(p / m)
    if (q > 0) js += 0.5 * q * Math.log2(q / m)
  }
  return js
}

// ------------------------------------------------------------------ 1. entropy
function entropySpectrum(data) {
  const blocks = []
  const hist = []
  for (let off = 0; off < data.length; off += BLOCK) {
    const part = data.subarray(off, Math.min(off + BLOCK, data.length))
    const h = byteCounts(part)
    hist.push(h)
    blocks.push({ offset: off, bytes: part.length, h0: +entropyOf(h, part.length).toFixed(4) })
  }
  let jsSum = 0, jsMax = 0, jsMaxAt = 0, above = 0
  for (let i = 1; i < blocks.length; i++) {
    const d = jsDivergence(hist[i - 1], hist[i])
    blocks[i].jsPrev = +d.toFixed(5)
    jsSum += d
    if (d > jsMax) { jsMax = d; jsMaxAt = blocks[i].offset }
    if (d > 0.05) above++
  }
  const hs = blocks.map(b => b.h0)
  const mean = hs.length ? hs.reduce((s, v) => s + v, 0) / hs.length : 0
  const sd = hs.length ? Math.sqrt(hs.reduce((s, v) => s + (v - mean) ** 2, 0) / hs.length) : 0
  return {
    whole: { H0: +h0(data).toFixed(4), H1: +h1(data).toFixed(4), H2nibble: +h2(data).toFixed(4) },
    blocks: {
      count: blocks.length,
      size: BLOCK,
      H0mean: +mean.toFixed(4),
      H0stdev: +sd.toFixed(4),
      H0min: hs.length ? +Math.min(...hs).toFixed(4) : 0,
      H0max: hs.length ? +Math.max(...hs).toFixed(4) : 0,
      jsMean: +(jsSum / Math.max(1, blocks.length - 1)).toFixed(5),
      jsMax: +jsMax.toFixed(5),
      jsMaxAt,
      jsOver005: above,
    },
    perBlock: blocks,
  }
}

// ------------------------------------------------------------------ 2. stride
/**
 * MI/equality/difference-entropy per lag on a bounded prefix. The sample is a
 * prefix, not a stride, so an interleaved file is not aliased by the sampling.
 */
function strideSpectrum(data) {
  const n = Math.min(data.length, STRIDE_SAMPLE)
  const x = data.subarray(0, n)
  const base = byteCounts(x)
  const baseH = entropyOf(base, n)
  const maxD = Math.min(STRIDE_LIMIT, n - 1)
  if (n < 8192 || maxD < 1) return { rows: [], note: 'input too short for stride analysis' }
  const joint = new Uint32Array(1 << 16)
  const diff = new Uint32Array(256)
  const rows = []
  for (let d = 1; d <= maxD; d++) {
    joint.fill(0); diff.fill(0)
    const m = n - d
    let eq = 0
    for (let i = 0; i < m; i++) {
      const a = x[i], b = x[i + d]
      joint[(a << 8) | b]++
      diff[(b - a) & 255]++
      if (a === b) eq++
    }
    // column marginals, needed for MI
    const colA = new Uint32Array(256), colB = new Uint32Array(256)
    for (let a = 0; a < 256; a++) {
      const rowBase = a << 8
      for (let b = 0; b < 256; b++) {
        const c = joint[rowBase | b]
        if (c) { colA[a] += c; colB[b] += c }
      }
    }
    let mi = 0
    for (let a = 0; a < 256; a++) {
      const rowBase = a << 8
      for (let b = 0; b < 256; b++) {
        const c = joint[rowBase | b]
        if (c) mi += (c / m) * Math.log2((c * m) / (colA[a] * colB[b]))
      }
    }
    const diffH = entropyOf(diff, m)
    rows.push({
      d,
      mi: +mi.toFixed(5),
      equalityRate: +(eq / m).toFixed(5),
      diffH1: +diffH.toFixed(4),
      diffDrop: +(baseH - diffH).toFixed(4),
    })
  }
  const sorted = [...rows].sort((a, b) => b.mi - a.mi || b.equalityRate - a.equalityRate)
  const byD = new Map(rows.map(r => [r.d, r]))
  const powerOfTwo = [2, 4, 8, 16, 32, 64, 128, 256].filter(d => byD.has(d)).map(d => {
    const r = byD.get(d)
    const nb = [byD.get(d - 1), byD.get(d + 1)].filter(Boolean)
    const nbMean = nb.length ? nb.reduce((s, v) => s + v.mi, 0) / nb.length : 0
    return { d, mi: r.mi, neighbourMi: +nbMean.toFixed(5), peak: +(r.mi - nbMean).toFixed(5) }
  })
  return { sampleBytes: n, lagMax: maxD, top: sorted.slice(0, 12), powerOfTwo }
}

// ------------------------------------------------------------------ 3. long range
/**
 * Greedy LZ77 with a 4-byte hash table and a bounded chain. Cost O(n * chain);
 * `chain = 16` is the same order of effort as zstd's fast mode. This is a LOWER
 * bound on the redundancy a dictionary coder could reach, not an optimal parse.
 */
function longRange(data, windowBytes, chain = 16) {
  const n = Math.min(data.length, windowBytes)
  if (n < 4096) return { windowBytes: n, note: 'too short' }
  const w = data.subarray(0, n)
  const HASH = 1 << 16
  const head = new Int32Array(HASH).fill(-1)
  const prev = new Int32Array(n).fill(-1)
  const hash = (i) => (((w[i] << 16) ^ (w[i + 1] << 8) ^ (w[i + 2] << 4) ^ w[i + 3]) * 2654435761 >>> 8) & (HASH - 1)
  let pos = 0, matched = 0, matches = 0, lenSum = 0, longest = 0
  const offsetSeen = new Map()
  let repeatHits = 0
  const MIN_MATCH = 4
  while (pos + MIN_MATCH <= n) {
    const h = hash(pos)
    let cand = head[h], best = 0, bestSrc = -1
    for (let k = 0; k < chain && cand >= 0; k++) {
      // compare
      let len = 0
      const lim = n - pos
      while (len < lim && w[cand + len] === w[pos + len]) len++
      if (len > best) { best = len; bestSrc = cand }
      if (len >= 258) break
      cand = prev[cand]
    }
    prev[pos] = head[h]
    head[h] = pos
    if (best >= MIN_MATCH && bestSrc >= 0) {
      matched += best; matches++; lenSum += best
      if (best > longest) longest = best
      const off = pos - bestSrc
      if (offsetSeen.has(off)) repeatHits++
      offsetSeen.set(off, true)
      // insert interior positions so later matches can reference them
      for (let i = pos + 1; i < Math.min(pos + best, n - MIN_MATCH + 1); i++) {
        const hi = hash(i)
        prev[i] = head[hi]
        head[hi] = i
      }
      pos += best
    } else {
      pos += 1
    }
  }
  return {
    windowBytes: n,
    matchableShare: +(matched / n).toFixed(4),
    matches,
    meanMatchLength: matches ? +(lenSum / matches).toFixed(2) : 0,
    longestMatch: longest,
    distinctOffsets: offsetSeen.size,
    repeatOffsetHitRate: matches ? +(repeatHits / matches).toFixed(4) : 0,
    chain,
  }
}

// ------------------------------------------------------------------ 4. sub-byte
function subByte(data) {
  const n = data.length
  if (!n) return {}
  const joint = new Uint32Array(256)
  for (let i = 0; i < n; i++) joint[data[i]]++
  const planeEntropy = []
  for (let b = 0; b < 8; b++) {
    let ones = 0
    for (let i = 0; i < n; i++) ones += (data[i] >>> b) & 1
    const p = ones / n
    planeEntropy.push(p <= 0 || p >= 1 ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p)))
  }
  const nib = (shift) => {
    const c = new Uint32Array(16)
    for (let i = 0; i < n; i++) c[(data[i] >>> shift) & 15]++
    return c
  }
  const hi = nib(4), lo = nib(0)
  const cond = (givenHi) => {
    let h = 0
    for (let a = 0; a < 16; a++) {
      let row = 0
      for (let b = 0; b < 16; b++) row += joint[givenHi ? ((a << 4) | b) : ((b << 4) | a)]
      if (!row) continue
      let c = 0
      for (let b = 0; b < 16; b++) {
        const k = joint[givenHi ? ((a << 4) | b) : ((b << 4) | a)]
        if (k) { const p = k / row; c -= p * Math.log2(p) }
      }
      h += (row / n) * c
    }
    return h
  }
  const sum = planeEntropy.reduce((s, v) => s + v, 0)
  // Subadditivity: if the eight bit planes were independent, the byte entropy would
  // equal the sum of the plane entropies. The difference is therefore exactly the
  // cross-plane redundancy a bit-plane coder has left to model. It is >= 0 and
  // measured in bits per byte.
  const whole = h0(data)
  return {
    HhighNibble: +entropyOf(hi, n).toFixed(4),
    HlowNibble: +entropyOf(lo, n).toFixed(4),
    HlowGivenHigh: +cond(true).toFixed(4),
    HhighGivenLow: +cond(false).toFixed(4),
    planeEntropy: planeEntropy.map(v => +v.toFixed(4)),
    planeEntropySum: +sum.toFixed(4),
    planeIndependenceGap: +(sum - whole).toFixed(4),
  }
}

// ------------------------------------------------------------------ 5. ucsegs
function ucsegs(path, cap) {
  const esbuild = join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild')
  try { statSync(esbuild) } catch { return { skipped: 'esbuild not installed' } }
  const dir = join(process.cwd(), '.diag-state')
  try { mkdirSync(dir, { recursive: true }) } catch { /* exists */ }
  const stem = join(dir, `inspect-ucsegs-${process.pid}-${Date.now()}`)
  const entry = `${stem}.ts`, bundle = `${stem}.cjs`
  try {
    writeFileSync(entry, [
      "import { readFileSync } from 'node:fs'",
      "import { analyze } from '../src/lib/analyze'",
      'const data = new Uint8Array(readFileSync(process.argv[2])).subarray(0, Number(process.argv[3]))',
      'const a = analyze(data)',
      'const classes = {}',
      'for (const s of a.segs) classes[s.cls] = (classes[s.cls] ?? 0) + 1',
      'const sizes = a.segs.map(s => s.end - s.start).sort((x, y) => y - x)',
      'console.log(JSON.stringify({ blocks: a.blocks.length, segments: a.segs.length, classes,',
      '  largest: sizes.slice(0, 8), meanSegment: +(data.length / a.segs.length).toFixed(1) }))',
    ].join('\n'))
    execFileSync(esbuild, [entry, '--bundle', '--platform=node', '--format=cjs', `--outfile=${bundle}`, '--log-level=error'], { stdio: 'pipe' })
    const out = execFileSync(process.execPath, [bundle, path, String(cap)], { encoding: 'utf8', maxBuffer: 1 << 24 })
    return JSON.parse(out.trim().split('\n').at(-1))
  } catch (e) {
    return { skipped: String(e.message ?? e).split('\n')[0] }
  } finally {
    for (const f of [entry, bundle]) { try { unlinkSync(f) } catch { /* already gone */ } }
  }
}

// ------------------------------------------------------------------ driver
const USAGE = 'usage: node scripts/diag/inspect-structure.mjs <file|dir> [--max-bytes N] [--json] [--no-ucsegs]\n'
const SKIP_EXT = new Set(['.json', '.md', '.mjs', '.cjs', '.ts', '.tsx', '.js', '.jsx'])

function listInputs(p) {
  const st = statSync(p)
  if (!st.isDirectory()) return [p]
  return readdirSync(p)
    .map(f => join(p, f))
    .filter(f => {
      try {
        const s = statSync(f)
        if (!s.isFile()) return false
        // Skip this repository's own sources and manifests when pointed at a tree.
        if (SKIP_EXT.has(extname(f).toLowerCase()) && s.size < 65536) return false
        return true
      } catch { return false }
    })
}

function analyse(path, cap, withUcsegs) {
  const raw = readFileSync(path)
  const truncated = raw.length > cap
  const data = truncated ? raw.subarray(0, cap) : raw
  const report = {
    file: basename(path),
    path: resolve(path),
    bytes: raw.length,
    analysedBytes: data.length,
    truncated,
    sha256: createHash('sha256').update(data).digest('hex'),
    entropy: entropySpectrum(data),
    stride: strideSpectrum(data),
    longRange: {
      '64KiB': longRange(data, 64 * 1024),
      '1MiB': longRange(data, 1024 * 1024),
      whole: longRange(data, data.length),
    },
    subByte: subByte(data),
  }
  if (withUcsegs) report.ucsegs = ucsegs(path, cap)
  return report
}

function printTable(r, out) {
  const w = (s) => out.write(s + '\n')
  w('')
  w(`== ${r.file}  ${r.bytes} B${r.truncated ? `  (analysed first ${r.analysedBytes} B only)` : ''}`)
  w(`   H0 ${r.entropy.whole.H0}   H1 ${r.entropy.whole.H1}   H2(nib) ${r.entropy.whole.H2nibble}`)
  w(`   blocks ${r.entropy.blocks.count}x${r.entropy.blocks.size}  H0 ${r.entropy.blocks.H0min}..${r.entropy.blocks.H0max} (sd ${r.entropy.blocks.H0stdev})  JS mean ${r.entropy.blocks.jsMean} max ${r.entropy.blocks.jsMax} @${r.entropy.blocks.jsMaxAt}  nonstationary ${r.entropy.blocks.jsOver005}`)
  const s = r.stride
  if (s.note) w(`   stride: ${s.note}`)
  else {
    w(`   stride (sample ${s.sampleBytes} B, lags 1..${s.lagMax}) — top mutual information:`)
    w('        d        MI   eqRate    diffH1  diffDrop')
    for (const row of s.top) {
      w(`   ${String(row.d).padStart(5)}  ${String(row.mi.toFixed(4)).padStart(8)}  ${String(row.equalityRate.toFixed(4)).padStart(7)}  ${String(row.diffH1.toFixed(3)).padStart(8)}  ${String(row.diffDrop.toFixed(3)).padStart(8)}`)
    }
    const peaks = s.powerOfTwo.filter(p => p.peak > 0.05)
    w(peaks.length ? `   alignment peaks: ${peaks.map(p => `d=${p.d}(+${p.peak})`).join('  ')}` : '   alignment peaks: none above +0.05 MI')
  }
  w('   long range (greedy LZ, 4-byte hash chain):')
  for (const [k, v] of Object.entries(r.longRange)) {
    if (v.note) { w(`     ${k.padEnd(6)} ${v.note}`); continue }
    w(`     ${k.padEnd(6)} window ${String(v.windowBytes).padStart(9)}  matchable ${(v.matchableShare * 100).toFixed(2).padStart(6)}%  matches ${String(v.matches).padStart(8)}  meanLen ${String(v.meanMatchLength).padStart(6)}  longest ${String(v.longestMatch).padStart(7)}  repeatOff ${(v.repeatOffsetHitRate * 100).toFixed(1).padStart(5)}%`)
  }
  const b = r.subByte
  w(`   sub-byte: H(hi) ${b.HhighNibble}  H(lo) ${b.HlowNibble}  H(lo|hi) ${b.HlowGivenHigh}  H(hi|lo) ${b.HhighGivenLow}`)
  w(`             planeH ${JSON.stringify(b.planeEntropy)}`)
  w(`             independenceGap ${b.planeIndependenceGap} bits/byte (positive = bit planes still share information)`)
  if (r.ucsegs) {
    const u = r.ucsegs
    if (u.skipped) w(`   ucsegs: skipped (${u.skipped})`)
    else w(`   ucsegs: ${u.segments} segments / ${u.blocks} blocks  mean ${u.meanSegment} B  classes ${JSON.stringify(u.classes)}\n           largest ${JSON.stringify(u.largest)}`)
  }
}

function main() {
  const argv = process.argv.slice(2)
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
    process.stderr.write(USAGE)
    process.exit(argv.length ? 0 : 2)
  }
  const capIdx = argv.indexOf('--max-bytes')
  const cap = capIdx >= 0 ? Number(argv[capIdx + 1]) : DEFAULT_CAP
  if (!Number.isSafeInteger(cap) || cap < 8192) {
    process.stderr.write('--max-bytes must be an integer >= 8192\n')
    process.exit(2)
  }
  const jsonOnly = argv.includes('--json')
  const withUcsegs = !argv.includes('--no-ucsegs')
  const targets = argv.filter((a, i) => !a.startsWith('--') && !(capIdx >= 0 && i === capIdx + 1))
  if (!targets.length) { process.stderr.write(USAGE); process.exit(2) }

  const reports = []
  for (const t of targets.flatMap(listInputs)) {
    try {
      const r = analyse(t, cap, withUcsegs)
      reports.push(r)
      if (!jsonOnly) printTable(r, process.stderr)
    } catch (e) {
      const err = { file: basename(t), path: resolve(t), error: String(e.message ?? e) }
      reports.push(err)
      if (!jsonOnly) process.stderr.write(`== ${basename(t)}: ${err.error}\n`)
    }
  }
  process.stdout.write(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2) + '\n')
}

main()
