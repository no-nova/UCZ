// P5-4：LZ-PRE + CM 是否真的比纯 CM 更小（只测压缩率，不接入容器）。
// 用法：node scripts/diag/run.mjs probe-lzpre [切片字节数] [文件...]
import { readFile } from 'node:fs/promises'
import { encodeCM } from '../../src/lib/coder'
import { lzPreFwd, lzPreInv } from '../../src/lib/lzpre'

const limit = Number(process.argv[2] ?? 2 * 1024 * 1024)
const files = process.argv.slice(3)
const list = files.length ? files : ['mozilla', 'samba', 'ooffice', 'xml', 'nci']
const rows: Record<string, unknown>[] = []
for (const f of list) {
  const raw = await readFile('/tmp/corpus/' + f)
  const data = raw.subarray(0, Math.min(limit, raw.length))
  // 先按最可能的形态量一次：不做任何正向变换，直接 bin profile。
  const plain = encodeCM(data, 'bin', 1, 1, undefined, 0, undefined, undefined, 'v15', 0).length
  const lz = lzPreFwd(data)
  const back = lzPreInv(lz.body, data.length, lz.esc)
  const ok = Buffer.from(back).equals(Buffer.from(data))
  // 4 字节 esc + 4 字节原始长度做头（真实接入时会更紧凑）
  const stream = new Uint8Array(lz.body.length + 5)
  stream[0] = lz.esc; stream[1] = lz.body.length & 255; stream[2] = (lz.body.length >>> 8) & 255
  stream[3] = (lz.body.length >>> 16) & 255; stream[4] = (lz.body.length >>> 24) & 255
  stream.set(lz.body, 5)
  const coll = encodeCM(stream, 'bin', 1, 1, undefined, 0, undefined, undefined, 'v15', 0).length
  rows.push({
    file: f, n: data.length, plain, lzCm: coll,
    'Δ%': +((coll / plain - 1) * 100).toFixed(2),
    '塌缩后%': +((lz.body.length / data.length) * 100).toFixed(1),
    matches: lz.matches, rev: ok,
  })
  console.error('.. ' + f)
}
console.table(rows)
