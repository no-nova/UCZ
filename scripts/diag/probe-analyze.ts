// 诊断：只看地形分析结果（快），输出分类构成、区域数、区域长度分布。
// 用法：node scripts/diag/run.mjs probe-analyze <文件...>
import { readFile } from 'node:fs/promises'
import { analyze, BLOCK } from '../../src/lib/analyze'

for (const file of process.argv.slice(2)) {
  const data = await readFile(file)
  const t = performance.now()
  const a = analyze(data)
  const ms = Math.round(performance.now() - t)
  const byCls = new Map<string, { n: number; bytes: number }>()
  for (const s of a.segs) {
    const e = byCls.get(s.cls) ?? { n: 0, bytes: 0 }
    e.n++; e.bytes += s.end - s.start
    byCls.set(s.cls, e)
  }
  const lens = a.segs.map(s => s.end - s.start).sort((x, y) => x - y)
  const cls = [...byCls.entries()].sort((x, y) => y[1].bytes - x[1].bytes)
    .map(([k, v]) => `${k}:${v.n}seg/${(v.bytes / data.length * 100).toFixed(1)}%`)
  console.log(JSON.stringify({
    file: file.split('/').pop(), size: data.length, ms,
    blocks: a.blocks.length, segs: a.segs.length,
    medianSeg: lens[Math.floor(lens.length / 2)] ?? 0,
    maxSeg: lens[lens.length - 1] ?? 0,
    segsUnder2k: lens.filter(x => x < 2048).length,
    cls,
  }))
}
