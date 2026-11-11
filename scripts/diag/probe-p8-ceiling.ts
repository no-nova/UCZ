// P8-环节五 探针：内部压缩潜力上限估计器（不看任何外部世界纪录）。
//
// 思路：把“还剩多少可压”拆成三个**可以从数据自身算出来**的量：
//   (a) 精确 k 阶条件熵 H0..H3（k=3 的联合键恰好 32 位，用基数排序做**精确**计数，
//       不引入任何哈希碰撞），H4 用可验证哈希并如实报告碰撞率；
//   (b) 贪心 LZ 覆盖率：有多少字节能被“前文出现过的 ≥L 字节串”覆盖，以及覆盖它的
//       距离/长度分布 —— 这是匹配模型理论上能吃到的长程冗余；
//   (c) 编码器实际达到的 bits/byte（与 probe-p8-attrib 同口径）。
// 三者一摆，就能回答“潜力是否到头”：若 achieved ≈ max(未覆盖字节的 H3, 匹配部分的
// log2(dist)/L)，说明剩下的确实是当前模型族吃不到的部分，而不是筛选没做好。
//
// 用法：node scripts/diag/run.mjs probe-p8-ceiling [字节数=4194304] [文件...]
import { readFile, writeFile, mkdir } from 'node:fs/promises'

const argN = Number(process.argv[2] ?? 4 * 1024 * 1024)
const files = process.argv.slice(3).length ? process.argv.slice(3)
  : ['mozilla', 'webster', 'dickens', 'samba', 'osdb', 'ooffice', 'mr', 'sao', 'xml', 'nci', 'reymont', 'x-ray']
await mkdir('/tmp/p8-ceiling', { recursive: true })

/** 32 位键的 LSD 基数排序（精确、无哈希）。 */
function radixSort32(src: Uint32Array): Uint32Array {
  const n = src.length
  let a = src, b = new Uint32Array(n)
  const cnt = new Uint32Array(256)
  for (let shift = 0; shift < 32; shift += 8) {
    cnt.fill(0)
    for (let i = 0; i < n; i++) cnt[(a[i] >>> shift) & 255]++
    let sum = 0
    for (let i = 0; i < 256; i++) { const c = cnt[i]; cnt[i] = sum; sum += c }
    for (let i = 0; i < n; i++) b[cnt[(a[i] >>> shift) & 255]++] = a[i]
    const t = a; a = b; b = t
  }
  return a
}
/**
 * 插入式（plug-in）熵估计在“不同上下文数 m 接近样本量 N”时会**系统性偏低**，
 * 偏差量级为 (m-1)/(2N)（Miller–Madow）。4 MiB 样本上 4 字节上下文可能有几百万个，
 * 不校正的话 H3 会低到 0.38 bit/byte 这种明显不可能的值。
 * 因此这里一律返回 {plugin, mm, m}，报告以 Miller–Madow 校正值为准。
 */
function entropySorted(sorted: Uint32Array): { plugin: number; mm: number; m: number } {
  const n = sorted.length
  if (!n) return { plugin: 0, mm: 0, m: 0 }
  let h = 0, run = 1, m = 0
  const ln = Math.log2(n)
  for (let i = 1; i <= n; i++) {
    if (i < n && sorted[i] === sorted[i - 1]) { run++; continue }
    const p = run / n
    h -= p * (Math.log2(run) - ln)
    m++; run = 1
  }
  return { plugin: h, mm: h + (m - 1) / (2 * n), m }
}
/** 直方图熵：-sum (c/total) log2 (c/total)，同样返回 Miller–Madow 校正值。 */
function entropyHist(hist: Uint32Array, total: number): { plugin: number; mm: number; m: number } {
  if (total <= 0) return { plugin: 0, mm: 0, m: 0 }
  let h = 0, m = 0
  const ln = Math.log2(total)
  for (let i = 0; i < hist.length; i++) {
    const c = hist[i]
    if (c > 0) { h -= (c / total) * (Math.log2(c) - ln); m++ }
  }
  return { plugin: h, mm: h + (m - 1) / (2 * total), m }
}

const out: unknown[] = []
for (const f of files) {
  const raw = await readFile('/tmp/corpus/' + f)
  const data = argN > 0 ? raw.subarray(0, Math.min(argN, raw.length)) : raw
  const n = data.length
  const t0 = Date.now()

  // ---- (a) 精确 H0..H3 ----
  // H0
  const h0hist = new Uint32Array(256)
  for (let i = 0; i < n; i++) h0hist[data[i]]++
  const e0 = entropyHist(h0hist, n)
  const H0 = e0.mm
  // H1: 联合键 16 位、上下文键 8 位（都小，直接直方图）
  const j1 = new Uint32Array(65536), c1 = new Uint32Array(256)
  for (let i = 1; i < n; i++) { j1[(data[i - 1] << 8) | data[i]]++; c1[data[i - 1]]++ }
  const e1 = entropyHist(j1, n - 1), f1 = entropyHist(c1, n - 1)
  const H1c = (e1.mm - f1.mm) * (n - 1) / n
  const H1p = (e1.plugin - f1.plugin) * (n - 1) / n
  // H2: 联合键 24 位、上下文 16 位
  const j2 = new Uint32Array(1 << 24), c2 = new Uint32Array(65536)
  for (let i = 2; i < n; i++) { j2[(data[i - 2] << 16) | (data[i - 1] << 8) | data[i]]++; c2[(data[i - 2] << 8) | data[i - 1]]++ }
  const e2 = entropyHist(j2, n - 2), f2 = entropyHist(c2, n - 2)
  const H2c = (e2.mm - f2.mm) * (n - 2) / n
  const H2p = (e2.plugin - f2.plugin) * (n - 2) / n
  // H3: 联合键 32 位（精确），上下文 24 位
  const j3 = new Uint32Array(n - 3)
  for (let i = 3; i < n; i++) j3[i - 3] = ((data[i - 3] << 24) | (data[i - 2] << 16) | (data[i - 1] << 8) | data[i]) >>> 0
  const c3 = new Uint32Array(1 << 24)
  for (let i = 3; i < n; i++) c3[(data[i - 3] << 16) | (data[i - 2] << 8) | data[i - 1]]++
  const e3 = entropySorted(radixSort32(j3)), f3 = entropyHist(c3, n - 3)
  const H3c = (e3.mm - f3.mm) * (n - 3) / n
  const H3p = (e3.plugin - f3.plugin) * (n - 3) / n
  const ctx = { m1: e1.m, m2: e2.m, m3: e3.m, m3ctx: f3.m }

  // ---- (b) 贪心 LZ 覆盖率（精确匹配，最长 258）----
  const H_BITS = 22, H_SIZE = 1 << H_BITS, H_MASK = H_SIZE - 1
  const head = new Int32Array(H_SIZE).fill(-1)
  const MIN_L = 4, MAX_L = 258
  const cover = new Float64Array(8) // 覆盖字节数，按最小匹配长度分档
  let pos = 0, matches = 0
  const distSum = { sum: 0, n: 0 }
  const hkey = (p: number) => (((data[p] << 16) | (data[p + 1] << 8) | data[p + 2]) * 0x9e3779b1) >>> 0 & H_MASK
  // 先插入前 MIN_L-1 个位置
  while (pos + MIN_L <= n) {
    const h = hkey(pos)
    let best = 0, bestDist = 0
    let cand = head[h], guard = 0
    while (cand >= 0 && guard++ < 32) {
      let l = 0
      while (l < MAX_L && pos + l < n && data[cand + l] === data[pos + l]) l++
      if (l > best) { best = l; bestDist = pos - cand }
      cand = -1 // 单候选哈希（链式会拖慢 10 倍；单候选给出的是覆盖率下界）
    }
    head[h] = pos
    if (best >= MIN_L) {
      matches++
      distSum.sum += Math.log2(Math.max(2, bestDist)); distSum.n++
      for (const L of [4, 8, 16, 32, 64, 128, 258]) if (best >= L) cover[L === 4 ? 0 : L === 8 ? 1 : L === 16 ? 2 : L === 32 ? 3 : L === 64 ? 4 : L === 128 ? 5 : 6] += best
      // 跳过匹配体，但把体内位置也登记进哈希表（保持后续匹配可达）
      for (let k = 1; k < best && pos + k + MIN_L <= n; k++) head[hkey(pos + k)] = pos + k
      pos += best
    } else pos++
  }
  const lzCov = {
    match4: +(cover[0] / n * 100).toFixed(2), match8: +(cover[1] / n * 100).toFixed(2),
    match16: +(cover[2] / n * 100).toFixed(2), match32: +(cover[3] / n * 100).toFixed(2),
    match64: +(cover[4] / n * 100).toFixed(2), match128: +(cover[5] / n * 100).toFixed(2),
    matches, meanLog2Dist: +(distSum.sum / Math.max(1, distSum.n)).toFixed(2),
  }

  // ---- (c) 内部上限估计 ----
  // 未被 ≥4 匹配覆盖的字节按 H3 付费；被覆盖的字节按“距离+长度”的 LZ 记号付费。
  const uncov = Math.max(0, n - cover[0])
  const lzBits = matches * (distSum.sum / Math.max(1, distSum.n) + 8 + 8) // 距离 + 长度 + 标志
  const estBits = uncov * H3c + lzBits
  const rec = {
    file: f, n, ms: Date.now() - t0,
    exactEntropy: { H0: +H0.toFixed(4), H1: +H1c.toFixed(4), H2: +H2c.toFixed(4), H3: +H3c.toFixed(4),
      plugin: { H1: +H1p.toFixed(4), H2: +H2p.toFixed(4), H3: +H3p.toFixed(4) }, distinctContexts: ctx },
    lz: lzCov,
    internalEstimate: { bitsPerByte: +(estBits / n).toFixed(4), bytes: Math.round(estBits / 8), pct: +(estBits / 8 / n * 100).toFixed(2) },
  }
  out.push(rec)
  await writeFile(`/tmp/p8-ceiling/${f}.json`, JSON.stringify(rec))
  console.log(JSON.stringify({ file: f, n, H0: +H0.toFixed(3), H1: +H1c.toFixed(3), H2: +H2c.toFixed(3), H3: +H3c.toFixed(3),
    pluginH3: +H3p.toFixed(3), m3: ctx.m3, lzCov }))
}
console.log(JSON.stringify({ kind: 'done', files: out.map(o => (o as any).file) }))
