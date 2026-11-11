// P2-1 探针：v15（v13 上下文 + APM/SSE 二级校准）相对 v13 的净字节收益。
// 用法：node scripts/diag/run.mjs probe-apm <文件> [切片字节数] [--sweep]
// 默认只跑一组参数；--sweep 会扫 ctx/rate/weight 组合（同进程，避免重复读盘）。
import { readFile } from 'node:fs/promises'
import { encodeCM, decodeCM, apmTuning } from '../../src/lib/coder'

const args = process.argv.slice(2)
const file = args[0] ?? '/tmp/corpus/dickens'
const limit = args[1] && !args[1].startsWith('--') ? Number(args[1]) : 1 << 21
const sweep = args.includes('--sweep')
const raw = await readFile(file)
const data = raw.length > limit ? raw.subarray(0, limit) : raw

const enc = (variant: 'v13' | 'v15', profile: string) =>
  encodeCM(data, profile as never, 1, 1, undefined, 0, undefined, undefined, variant as never, 0)

const base: Record<string, number> = {}
const baseMs: Record<string, number> = {}
for (const p of ['text', 'bin', 'res', 'res2d']) {
  const t = performance.now()
  base[p] = enc('v13', p).length
  baseMs[p] = performance.now() - t
}

type Row = { ctx: number; rate: number; weight: number; text: number; bin: number; res2d: number; ms: number; ok: boolean }
const rows: Row[] = []
const grid = sweep
  ? [0, 1, 2, 3].flatMap(ctx => [5, 6, 7].flatMap(rate => [1, 2, 3].map(weight => ({ ctx, rate, weight }))))
  : [{ ...apmTuning }]

for (const cfg of grid) {
  Object.assign(apmTuning, cfg)
  const t = performance.now()
  const out: Record<string, Uint8Array> = {}
  for (const p of ['text', 'bin', 'res2d']) out[p] = enc('v15', p)
  const ms = performance.now() - t
  // 回验：v15 必须能自解码
  const ok = ['text', 'bin', 'res2d'].every(p =>
    Buffer.from(decodeCM(out[p], data.length, p as never, 1, 1, undefined, 'v15' as never, 0)).equals(Buffer.from(data)))
  rows.push({ ...cfg, text: out.text.length, bin: out.bin.length, res2d: out.res2d.length, ms: Math.round(ms), ok })
}

if (sweep) {
  // 按 text+bin+res2d 的总字节排序，最好的排前面
  rows.sort((a, b) => (a.text + a.bin + a.res2d) - (b.text + b.bin + b.res2d))
  const show = rows.slice(0, 12).map(r => ({
    ctx: r.ctx, rate: r.rate, weight: r.weight,
    dText: r.text - base.text, dBin: r.bin - base.bin, dRes2d: r.res2d - base.res2d,
    dSum: (r.text + r.bin + r.res2d) - (base.text + base.bin + base.res2d),
    pctSum: +(((r.text + r.bin + r.res2d) / (base.text + base.bin + base.res2d) - 1) * 100).toFixed(3),
    ok: r.ok,
  }))
  console.log(JSON.stringify({ file: file.split('/').pop(), size: data.length, base, baseMs: Object.fromEntries(Object.entries(baseMs).map(([k, v]) => [k, Math.round(v)])), best: show }, null, 1))
} else {
  const r = rows[0]
  const d = (a: number, b: number) => `${b - a >= 0 ? '+' : ''}${b - a} B (${((b / a - 1) * 100).toFixed(3)}%)`
  console.log(JSON.stringify({
    file: file.split('/').pop(), size: data.length, cfg: r,
    vsV13: { text: d(base.text, r.text), bin: d(base.bin, r.bin), res: d(base.res, r.res2d), res2d: d(base.res2d, r.res2d) },
    baseMs: Object.fromEntries(Object.entries(baseMs).map(([k, v]) => [k, Math.round(v)])),
  }, null, 1))
}
