// P6-4：sao 的分组是否真的进入了 v15 择优（打印每组 base/alt 与是否采纳）。
import { readFile } from 'node:fs/promises'
import { compressAdaptive } from '../../src/lib/codec'
const limit = Number(process.argv[2] ?? 2 * 1024 * 1024)
const raw = await readFile('/tmp/corpus/sao')
const data = raw.subarray(0, Math.min(limit, raw.length))
;(globalThis as any).__V15_STATS = []
;(globalThis as any).__GRP_STATS = []
const t0 = Date.now()
const comp = await compressAdaptive(data, undefined, { serial: true })
console.error('serial ms ' + (Date.now() - t0))
console.table((globalThis as any).__GRP_STATS)
console.table((globalThis as any).__V15_STATS)
console.log(JSON.stringify({ n: data.length, ucz: comp.container.length, ver: comp.container[3] }))
