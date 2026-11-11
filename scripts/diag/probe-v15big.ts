// P4-1 复核：1 MiB 切片上 v13 vs v15（含 mht8 + a2）的字节与耗时。
import { readFile } from 'node:fs/promises'
import { encodeCM } from '../../src/lib/coder'
const limit = Number(process.argv[2] ?? 1048576)
const profile = (process.argv[3] ?? 'text') as 'text' | 'bin'
for (const f of ['xml', 'nci', 'dickens', 'osdb', 'mozilla', 'ooffice', 'webster']) {
  const raw = await readFile('/tmp/corpus/' + f)
  const d = raw.subarray(0, Math.min(limit, raw.length))
  const t0 = performance.now()
  const a = encodeCM(d, profile === 'text' ? 'text' : 'bin', 1, 1, undefined, 0, undefined, undefined, 'v13' as never, 0).length
  const t1 = performance.now()
  const b = encodeCM(d, profile === 'text' ? 'text' : 'bin', 1, 1, undefined, 0, undefined, undefined, 'v15' as never, 0).length
  const t2 = performance.now()
  console.log(JSON.stringify({ file: f, n: d.length, v13: a, v15: b, pct: +((b / a - 1) * 100).toFixed(2), ms13: Math.round(t1 - t0), ms15: Math.round(t2 - t1) }))
}
