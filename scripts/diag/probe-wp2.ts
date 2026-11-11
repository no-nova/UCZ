// P5-2：WORD-PRE v1（单字节、无空格吞并）vs v2（尾随空格 + 双层词表）。
// 用法：node scripts/diag/probe-wp2 [切片字节数] [文件...]
import { readFile } from 'node:fs/promises'
import { encodeCM } from '../../src/lib/coder'
import { wordPreFwdSampled, wordPreFwd2Sampled, wordPreInv2, wordPreInv } from '../../src/lib/wordpre'

const limit = Number(process.argv[2] ?? 512 * 1024)
const files = process.argv.slice(3)
const list = files.length ? files : ['dickens', 'webster', 'reymont', 'xml', 'nci', 'samba', 'ooffice']

/** 与 codec.ts 的 wordPreTry 相同的封装：4 字节词元流长度 + CM(header||body)。 */
function wrapped(header: Uint8Array, body: Uint8Array, wordTokens: boolean): Uint8Array {
  const stream = new Uint8Array(header.length + body.length)
  stream.set(header, 0); stream.set(body, header.length)
  const cm = encodeCM(stream, 'text', 1, 1, undefined, 0, undefined, undefined, 'v15', 0, wordTokens)
  const out = new Uint8Array(cm.length + 4)
  out[0] = stream.length & 255; out[1] = (stream.length >>> 8) & 255
  out[2] = (stream.length >>> 16) & 255; out[3] = (stream.length >>> 24) & 255
  out.set(cm, 4)
  return out
}

const rows: Record<string, unknown>[] = []
for (const f of list) {
  const raw = await readFile('/tmp/corpus/' + f)
  const data = raw.subarray(0, Math.min(limit, raw.length))
  const plain = encodeCM(data, 'text', 1, 1, undefined, 0, undefined, undefined, 'v15', 0).length
  const v1 = wordPreFwdSampled(data, 256 * 1024)
  const v2 = wordPreFwd2Sampled(data, 256 * 1024)
  const s1 = v1 ? wrapped(v1.header, v1.body, true).length : Infinity
  const s2 = v2 ? wrapped(v2.header, v2.body, true).length : Infinity
  // 可逆性自检
  const ok1 = v1 ? Buffer.from(wordPreInv(v1.header, v1.body, data.length)).equals(Buffer.from(data)) : null
  const ok2 = v2 ? Buffer.from(wordPreInv2(v2.header, v2.body, data.length)).equals(Buffer.from(data)) : null
  rows.push({
    file: f, n: data.length,
    plain, v1: v1 ? s1 : null, v2: v2 ? s2 : null,
    'v1%': v1 ? +((s1 / plain - 1) * 100).toFixed(2) : null,
    'v2%': v2 ? +((s2 / plain - 1) * 100).toFixed(2) : null,
    'Δ(v2-v1)%': v1 && v2 ? +((s2 / s1 - 1) * 100).toFixed(2) : null,
    '塌缩v1': v1 ? +(v1.body.length / data.length).toFixed(3) : null,
    '塌缩v2': v2 ? +(v2.body.length / data.length).toFixed(3) : null,
    K1: v2?.dict.one.length ?? null, K2: v2?.dict.two.length ?? null,
    rev: `${ok1}/${ok2}`,
  })
  console.error(`.. ${f} done`)
}
console.table(rows)
