// P6 A/B：v13（P2 基线）/ P5（v15，无辅混洗）/ P6（v15 + 辅混洗 lr2=2）在 2 MiB 切片上。
import { readFile } from 'node:fs/promises'
import { encodeCM, mixer2Tuning, type Profile } from '../../src/lib/coder'
const n = Number(process.argv[2] ?? 2 * 1024 * 1024)
const cases: Array<[string, Profile]> = [
  ['mozilla', 'bin'], ['webster', 'text'], ['dickens', 'text'], ['samba', 'bin'], ['osdb', 'bin'],
]
const rows = []
for (const [f, prof] of cases) {
  const raw = await readFile('/tmp/corpus/' + f)
  const d = raw.subarray(0, Math.min(n, raw.length))
  const v13 = encodeCM(d, prof, 1, 1, undefined, 0, undefined, undefined, 'v13', 0).length
  mixer2Tuning.on = false
  const p5 = encodeCM(d, prof, 1, 1, undefined, 0, undefined, undefined, 'v15', 0).length
  mixer2Tuning.on = true
  const p6 = encodeCM(d, prof, 1, 1, undefined, 0, undefined, undefined, 'v15', 0).length
  rows.push({ file: f, profile: prof, n: d.length, v13, p5, 'p5%': +((p5 / v13 - 1) * 100).toFixed(2),
    p6, 'p6%': +((p6 / v13 - 1) * 100).toFixed(2), 'p6-p5': p6 - p5, 'p6-p5%': +((p6 / p5 - 1) * 100).toFixed(3) })
  console.error('.. ' + f)
}
console.table(rows)
