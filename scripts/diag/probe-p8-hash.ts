// P8：线上行为回归哨兵——固定切片 + 固定规则的容器 sha256，用于验证诊断改动零影响。
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { compressAdaptive, decompress } from '../../src/lib/codec'
const h = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 24)
for (const [f, n] of [['osdb', 262144], ['xml', 262144], ['mr', 131072], ['sao', 131072]] as [string, number][]) {
  const raw = await readFile('/tmp/corpus/' + f)
  const data = raw.subarray(0, n)
  const c = await compressAdaptive(data, undefined, { serial: true })
  const back = decompress(c.container)
  console.log(f, n, 'segs=' + c.segs.length, 'ucz=' + c.container.length, 'hdr=' + c.overhead, 'sha=' + h(c.container),
    'ok=' + Buffer.from(back.buffer, back.byteOffset, back.byteLength).equals(data))
}
