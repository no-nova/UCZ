// P6-2：双路细粒度混洗器（weights2）的收益与学习率扫描。
// 用法：node scripts/diag/run.mjs probe-mixer [切片字节数]
import { readFile } from 'node:fs/promises'
import { encodeCM, mixer2Tuning, type Profile } from '../../src/lib/coder'
import { deltaFwd, medFwd } from '../../src/lib/transforms'

const limit = Number(process.argv[2] ?? 512 * 1024)
const cases: Array<[string, Profile, number, number, 'raw' | 'delta' | 'med']> = [
  ['dickens', 'text', 1, 1, 'raw'],
  ['webster', 'text', 1, 1, 'raw'],
  ['mozilla', 'bin', 1, 1, 'raw'],
  ['samba', 'bin', 1, 1, 'raw'],
  ['osdb', 'bin', 1, 1, 'raw'],
  ['ooffice', 'bin', 1, 1, 'raw'],
]
const lrs = [2, 4, 8]
const rows: Record<string, unknown>[] = []
for (const [file, profile, s, r, prep] of cases) {
  const raw = await readFile('/tmp/corpus/' + file)
  const slice = raw.subarray(0, Math.min(limit, raw.length))
  const data = prep === 'delta' ? deltaFwd(slice, s) : prep === 'med' ? medFwd(slice, s, r) : slice
  const v13 = encodeCM(data, profile, s, r, undefined, 0, undefined, undefined, 'v13', 0).length
  mixer2Tuning.on = false
  const off = encodeCM(data, profile, s, r, undefined, 0, undefined, undefined, 'v15', 0).length
  mixer2Tuning.on = true
  const row: Record<string, unknown> = { file, profile, n: data.length, v13, 'a1+a2': off, 'v15 vs v13%': +((off / v13 - 1) * 100).toFixed(2) }
  for (const lr of lrs) {
    mixer2Tuning.lr2 = lr
    const on = encodeCM(data, profile, s, r, undefined, 0, undefined, undefined, 'v15', 0).length
    row[`lr${lr}`] = on
    row[`lr${lr}%`] = +((on / off - 1) * 100).toFixed(2)
  }
  rows.push(row)
  console.error('.. ' + file + ' ' + profile)
}
mixer2Tuning.lr2 = 4
console.table(rows)
