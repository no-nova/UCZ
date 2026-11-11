// P6-3：bin 4 字节步长上下文 (a) 与断续匹配恢复 (b) 的分别收益。
// 用法：node scripts/diag/run.mjs probe-match3 [切片字节数]
import { readFile } from 'node:fs/promises'
import { encodeCM, match3Tuning } from '../../src/lib/coder'

const limit = Number(process.argv[2] ?? 1024 * 1024)
const files = process.argv[3] ? process.argv.slice(3) : ['mozilla', 'samba', 'osdb', 'ooffice']
const rows: Record<string, unknown>[] = []
for (const f of files) {
  const raw = await readFile('/tmp/corpus/' + f)
  const data = raw.subarray(0, Math.min(limit, raw.length))
  const profile = f === 'dickens' || f === 'webster' ? 'text' : 'bin'
  const enc = () => encodeCM(data, profile, 1, 1, undefined, 0, undefined, undefined, 'v15', 0).length
  match3Tuning.binCtx8 = false; match3Tuning.gapResume = false
  const base = enc()
  match3Tuning.binCtx8 = true; match3Tuning.gapResume = false
  const ctx8 = enc()
  match3Tuning.binCtx8 = false; match3Tuning.gapResume = true
  const gap = enc()
  match3Tuning.binCtx8 = true; match3Tuning.gapResume = true
  const both = enc()
  match3Tuning.binCtx8 = true; match3Tuning.gapResume = true
  rows.push({
    file: f, profile, n: data.length, base,
    ctx8, 'ctx8%': +((ctx8 / base - 1) * 100).toFixed(2),
    gap, 'gap%': +((gap / base - 1) * 100).toFixed(2),
    both, 'both%': +((both / base - 1) * 100).toFixed(2),
  })
  console.error('.. ' + f)
}
console.table(rows)
