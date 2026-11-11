// P5-4 可行性：LZ-PRE（长匹配预坍缩）在 mozilla / samba / ooffice 上的理论上限。
//
// 只做统计，不改比特流：用 8 字节哈希找 ≥MIN_LEN 的长距离精确重复，贪心取不重叠
// 区间，报告"可被坍缩掉的字节占比"。坍缩后的编码形式是
//   [esc, len-15, dist_lo, dist_mid, dist_hi]  → 5 字节
// 因此净收益 ≈ Σ(len - 5)；覆盖率太低就没必要上这套预变换。
//
// 用法：node scripts/diag/run.mjs probe-lzcover [切片字节数]
import { readFile } from 'node:fs/promises'

const limit = Number(process.argv[2] ?? 2 * 1024 * 1024)
const MIN_LEN = 16
const FILES = ['mozilla', 'samba', 'ooffice', 'xml', 'nci', 'dickens']

const rows: Record<string, unknown>[] = []
for (const f of FILES) {
  const raw = await readFile('/tmp/corpus/' + f)
  const data = raw.subarray(0, Math.min(limit, raw.length))
  const n = data.length
  const table = new Int32Array(1 << 20).fill(-1)
  let covered = 0, matches = 0, sumLen = 0, sumDist = 0
  let i = 0
  while (i + MIN_LEN <= n) {
    let h = 2166136261
    for (let k = 0; k < 8; k++) h = Math.imul(h ^ data[i + k], 16777619)
    const slot = (h ^ (h >>> 15)) & ((1 << 20) - 1)
    const cand = table[slot]
    table[slot] = i
    if (cand >= 0) {
      let l = 0
      while (i + l < n && data[cand + l] === data[i + l]) l++
      if (l >= MIN_LEN) {
        covered += l; matches++; sumLen += l; sumDist += i - cand
        i += l
        continue
      }
    }
    i++
  }
  const net = covered - matches * 5
  rows.push({
    file: f, n,
    matches, '覆盖率%': +((covered / n) * 100).toFixed(1),
    '净收益B': net, '净收益%': +((net / n) * 100).toFixed(2),
    '平均长度': matches ? Math.round(sumLen / matches) : 0,
    '平均距离': matches ? Math.round(sumDist / matches) : 0,
  })
}
console.table(rows)
