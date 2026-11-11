// P5-1：a2（第二级 APM）按 profile 的收益扫描。
//
// P4-1 的定标只在 text profile 上做过（7/7 正收益），但 v15 是**按 profile 共用**
// 的：res / res2d（图像残差、梯度、delta）也一起被套上了 a2。本机全量显示 mr /
// x-ray 回退，所以这里按 profile 拆开验证"a2 到底该给谁开"。
//
// 用法：node scripts/diag/run.mjs probe-a2prof [切片字节数]
import { readFile } from 'node:fs/promises'
import { encodeCM, apm2Tuning, type Profile } from '../../src/lib/coder'
import { deltaFwd, medFwd } from '../../src/lib/transforms'

const limit = Number(process.argv[2] ?? 512 * 1024)
const cases: Array<[string, string, Profile, number, number, 'raw' | 'delta' | 'med']> = [
  ['dickens', 'text', 'text', 1, 1, 'raw'],
  ['xml', 'text', 'text', 1, 1, 'raw'],
  ['mozilla', 'bin', 'bin', 1, 1, 'raw'],
  ['ooffice', 'bin', 'bin', 1, 1, 'raw'],
  ['mr', 'res2d', 'res2d', 4, 64, 'med'],
  ['x-ray', 'res2d', 'res2d', 2, 128, 'med'],
  ['mr', 'res', 'res', 4, 1, 'delta'],
  ['ooffice', 'res', 'res', 2, 1, 'delta'],
]

const rows: Record<string, unknown>[] = []
for (const [file, label, profile, s, r, prep] of cases) {
  const raw = await readFile('/tmp/corpus/' + file)
  const slice = raw.subarray(0, Math.min(limit, raw.length))
  const data = prep === 'delta' ? deltaFwd(slice, s) : prep === 'med' ? medFwd(slice, s, r) : slice
  const enc = (a2: boolean) => {
    apm2Tuning.on = a2
    return encodeCM(data, profile, s, r, undefined, 0, undefined, undefined, 'v15', 0).length
  }
  const base = encodeCM(data, profile, s, r, undefined, 0, undefined, undefined, 'v13', 0).length
  const off = enc(false)
  const on = enc(true)
  rows.push({
    file, profile: label, n: data.length,
    v13: base, a1: off, a1a2: on,
    'a1%': +((off / base - 1) * 100).toFixed(2),
    'a2增量%': +((on / off - 1) * 100).toFixed(2),
    better: on < off ? 'a1+a2' : on > off ? 'a1' : 'tie',
  })
}
apm2Tuning.on = true
console.table(rows)
