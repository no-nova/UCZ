// P4-2 探针：WORD-PRE 在 v15 词元模式下的净收益、可逆性与分块对照。
// 用法：node scripts/diag/run.mjs probe-wordpre2 <文件> [切片] [chunkKB=0 表示整块]
import { readFile } from 'node:fs/promises'
import { encodeCM, decodeCM } from '../../src/lib/coder'
import { wordPreFwd, wordPreInv, wordPreChunkedFwd, wordPreChunkedInv } from '../../src/lib/wordpre'

const file = process.argv[2] ?? '/tmp/corpus/xml'
const limit = Number(process.argv[3] ?? 1048576)
const chunkKB = Number(process.argv[4] ?? 0)
const raw = await readFile(file)
const data = raw.length > limit ? raw.subarray(0, limit) : raw
const profile = /xml|nci/.test(file) ? 'text' : 'text'

const direct = encodeCM(data, profile, 1, 1, undefined, 0, undefined, undefined, 'v15' as never, 0).length
const out: any = { file: file.split('/').pop(), size: data.length, direct }

if (chunkKB > 0) {
  const pre = wordPreChunkedFwd(data, chunkKB * 1024)!
  const ok = Buffer.from(wordPreChunkedInv(pre.raw, data.length)).equals(Buffer.from(data))
  const cod = encodeCM(pre.raw, profile, 1, 1, undefined, 0, undefined, undefined, 'v15' as never, 0, true)
  const tot = cod.length + 4
  out.mode = `chunked${chunkKB}`
  out.chunks = pre.chunks; out.invertible = ok; out.collapse = +(pre.raw.length / data.length).toFixed(3)
  out.bytes = tot; out.pct = +((tot / direct - 1) * 100).toFixed(2)
  // 端到端可解性
  out.decodeOk = Buffer.from(decodeCM(cod, pre.raw.length, profile, 1, 1, undefined, 'v15' as never, 0, true)).equals(Buffer.from(pre.raw))
} else {
  const pre = wordPreFwd(data)!
  const ok = Buffer.from(wordPreInv(pre.header, pre.body, data.length)).equals(Buffer.from(data))
  const body = new Uint8Array(pre.header.length + pre.body.length)
  body.set(pre.header, 0); body.set(pre.body, pre.header.length)
  const cod = encodeCM(body, profile, 1, 1, undefined, 0, undefined, undefined, 'v15' as never, 0, true)
  out.mode = 'single'; out.invertible = ok; out.collapse = +(pre.body.length / data.length).toFixed(3)
  out.header = pre.header.length; out.bytes = cod.length; out.pct = +((cod.length / direct - 1) * 100).toFixed(2)
  out.decodeOk = Buffer.from(decodeCM(cod, body.length, profile, 1, 1, undefined, 'v15' as never, 0, true)).equals(Buffer.from(body))
}
console.log(JSON.stringify(out))
