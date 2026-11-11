// P7-1 对照：大区域复核"单探针" vs "候选专属对齐 + 归一化率"。
// 用法：node scripts/diag/run.mjs probe-planab [切片字节数] [文件...]
import { readFile } from 'node:fs/promises'
import { compressAdaptive, planTuning } from '../../src/lib/codec'

const n = Number(process.argv[2] ?? 2 * 1024 * 1024)
const files = process.argv.slice(3).length ? process.argv.slice(3)
  : ['mozilla', 'samba', 'osdb', 'ooffice', 'nci', 'xml', 'sao']
const rows: Record<string, unknown>[] = []
for (const f of files) {
  const raw = await readFile('/tmp/corpus/' + f)
  const data = raw.subarray(0, Math.min(n, raw.length))
  planTuning.perCandidateAlign = false
  const t0 = Date.now()
  const old = (await compressAdaptive(data, undefined, { serial: true })).container.length
  const oldMs = Date.now() - t0
  planTuning.perCandidateAlign = true
  const t1 = Date.now()
  const neu = (await compressAdaptive(data, undefined, { serial: true })).container.length
  const newMs = Date.now() - t1
  rows.push({ file: f, n: data.length, old, new: neu, delta: neu - old, 'pct%': +((neu / old - 1) * 100).toFixed(3), oldMs, newMs })
  console.error('.. ' + f)
}
planTuning.perCandidateAlign = true
console.table(rows)
