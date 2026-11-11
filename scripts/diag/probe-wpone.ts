// 单个大分组上的 WORD-PRE 净收益（不跑全流程）。
import { readFile } from 'node:fs/promises'
import { encodeCM } from '../../src/lib/coder'
import { wordPreFwdSampled, wordPreInv, dictHeaderLen } from '../../src/lib/wordpre'
const file = process.argv[2] ?? '/tmp/corpus/xml'
const limit = Number(process.argv[3] ?? 0)
const raw = await readFile(file)
const data = limit ? raw.subarray(0, limit) : raw
const plain = encodeCM(data, 'text', 1, 1, undefined, 0, undefined, undefined, 'v15', 0)
const out: any = { file: file.split('/').pop(), n: data.length, plain: plain.length }
for (const samp of [64 * 1024, 256 * 1024, 1024 * 1024]) {
  const t0 = performance.now()
  const pre = wordPreFwdSampled(data, samp)!
  const shape = pre.body.length / data.length
  const body = new Uint8Array(pre.header.length + pre.body.length)
  body.set(pre.header, 0); body.set(pre.body, pre.header.length)
  const cm = encodeCM(body, 'text', 1, 1, undefined, 0, undefined, undefined, 'v15', 0, true)
  const back = Buffer.from(wordPreInv(body.subarray(0, pre.header.length), body.subarray(pre.header.length), data.length)).equals(Buffer.from(data))
  out[`s${samp / 1024}`] = { collapse: +shape.toFixed(3), hdr: pre.header.length, bytes: cm.length + 4, pct: +(((cm.length + 4) / plain.length - 1) * 100).toFixed(2), ok: back, ms: Math.round(performance.now() - t0) }
}
console.log(JSON.stringify(out))
