// P3-1 探针：单遍双算术编码器（encodeCMDual）与"跑两遍 encodeCM"的等价性与提速。
// 用法：node scripts/diag/run.mjs probe-dual <文件> [切片字节数]
import { readFile } from 'node:fs/promises'
import { encodeCM, encodeCMDual } from '../../src/lib/coder'

const file = process.argv[2] ?? '/tmp/corpus/dickens'
const limit = process.argv[3] ? Number(process.argv[3]) : 1 << 20
const raw = await readFile(file)
const data = raw.length > limit ? raw.subarray(0, limit) : raw

const rows: Record<string, unknown>[] = []
for (const [profile, s, r] of [['text', 1, 1], ['bin', 1, 1], ['res2d', 4, 64]] as const) {
  // 冷启动（JIT 预热）
  encodeCM(data.subarray(0, Math.min(1 << 15, data.length)), profile as never, s, r, undefined, 0, undefined, undefined, 'v15' as never, 0)

  let t = performance.now()
  const d = encodeCMDual(data, profile as never, s, r, 'v15', 0)
  const dualMs = performance.now() - t

  t = performance.now()
  const b13 = encodeCM(data, profile as never, s, r, undefined, 0, undefined, undefined, 'v13' as never, 0)
  const t13 = performance.now() - t
  t = performance.now()
  const b15 = encodeCM(data, profile as never, s, r, undefined, 0, undefined, undefined, 'v15' as never, 0)
  const t15 = performance.now() - t

  rows.push({
    profile, s, r,
    identical13: Buffer.from(d.base).equals(Buffer.from(b13)),
    identical15: Buffer.from(d.alt).equals(Buffer.from(b15)),
    bytes13: b13.length, bytes15: b15.length,
    dualMs: Math.round(dualMs), twoPassMs: Math.round(t13 + t15),
    speedup: +((t13 + t15) / dualMs).toFixed(2),
    best: d.base.length <= d.alt.length ? 'v13' : 'v15',
  })
}
console.log(JSON.stringify({ file: file.split('/').pop(), size: data.length, rows }, null, 1))
