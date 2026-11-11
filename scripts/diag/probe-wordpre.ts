// P3-2 探针：词元预坍缩（WORD-PRE）→ CM 二次精压的净收益与可逆性。
// 用法：node scripts/diag/run.mjs probe-wordpre <文件> [切片字节数] [--k=120]
import { readFile } from 'node:fs/promises'
import { encodeCM } from '../../src/lib/coder'
import { wordPreFwd, wordPreInv } from '../../src/lib/wordpre'

const args = process.argv.slice(2)
const file = args.find(a => !a.startsWith('--')) ?? '/tmp/corpus/xml'
const limit = Number(args.filter(a => !a.startsWith('--'))[1] ?? (1 << 22))
const k = Number((args.find(a => a.startsWith('--k=')) ?? '--k=120').slice(4))
const raw = await readFile(file)
const data = raw.length > limit ? raw.subarray(0, limit) : raw

const pre = wordPreFwd(data, k)
if (!pre) { console.log(JSON.stringify({ file, note: '没有可用词元' })); process.exit(0) }

// 可逆性
const back = wordPreInv(pre.header, pre.body, data.length)
const invertible = Buffer.from(back).equals(Buffer.from(data))

const t0 = performance.now()
const direct = encodeCM(data, 'text', 1, 1, undefined, 0, undefined, undefined, 'v15' as never, 0)
const tDirect = performance.now() - t0
const t1 = performance.now()
const viaPre = encodeCM(pre.body, 'text', 1, 1, undefined, 0, undefined, undefined, 'v15' as never, 0)
const tPre = performance.now() - t1

const total = viaPre.length + pre.header.length
console.log(JSON.stringify({
  file: file.split('/').pop(), size: data.length, k, dict: pre.dict.length, invertible,
  headerBytes: pre.header.length,
  collapseRatio: +(pre.body.length / data.length).toFixed(3),
  direct: direct.length, preCM: viaPre.length, total,
  delta: total - direct.length, deltaPct: +((total / direct.length - 1) * 100).toFixed(2),
  cMMs: { direct: Math.round(tDirect), pre: Math.round(tPre), speedup: +(tDirect / tPre).toFixed(2) },
  sample: pre.dict.slice(0, 8),
}, null, 1))
