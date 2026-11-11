// P7-0 对照：1D 残差 'res' 上开/关 a2 的端到端差异（D16 / WIDE_GRAD 已按 spec.id 精确抑制）。
// 用法：node scripts/diag/run.mjs probe-p7a2 [切片字节数]
import { readFile } from 'node:fs/promises'
import { compressAdaptive } from '../../src/lib/codec'
import { a2Tuning, mixer2Tuning } from '../../src/lib/coder'

const n = Number(process.argv[2] ?? 2 * 1024 * 1024)
const files = ['mozilla', 'samba', 'ooffice', 'osdb', 'x-ray', 'mr', 'xml', 'nci']
const rows: Record<string, unknown>[] = []
for (const f of files) {
  const raw = await readFile('/tmp/corpus/' + f)
  const data = raw.subarray(0, Math.min(n, raw.length))
  a2Tuning.resOn = false; mixer2Tuning.on = true
  const p6 = (await compressAdaptive(data, undefined, { serial: true })).container.length
  a2Tuning.resOn = true
  const p7 = (await compressAdaptive(data, undefined, { serial: true })).container.length
  rows.push({ file: f, n: data.length, 'P6(a2=text|bin)': p6, 'P7(a2=+res)': p7, delta: p7 - p6,
    'pct%': +((p7 / p6 - 1) * 100).toFixed(3) })
  console.error('.. ' + f)
}
a2Tuning.resOn = true
console.table(rows)
