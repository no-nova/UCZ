// 诊断：并行 vs 串行 编码结果是否逐字节一致，以及各自的耗时。
// 用法：node scripts/diag/run.mjs probe-parallel <文件> [--threads N]
import { readFile } from 'node:fs/promises'
import { compressAdaptive, parallelReport } from '../../src/lib/codec'
import { closePool, parallelReady } from '../../src/lib/parallel-pool'
import { threadCount } from '../../src/lib/parallel'

const file = process.argv[2] ?? '/tmp/corpus/xml'
const data = await readFile(file)
console.log(`并行可用=${parallelReady()} 线程=${threadCount()}`)

const t0 = performance.now()
const par = await compressAdaptive(data)
const parMs = performance.now() - t0
const parUsed = parallelReport.used
await closePool()

process.env.UCZ_THREADS = '1'
delete process.env.UCZ_THREADS
const t1 = performance.now()
const ser = await compressAdaptive(data, undefined, { serial: true })
const serMs = performance.now() - t1

const same = par.container.length === ser.container.length && Buffer.from(par.container).equals(Buffer.from(ser.container))
console.log(JSON.stringify({
  file: file.split('/').pop(), parallelUsed: parUsed,
  parBytes: par.container.length, serBytes: ser.container.length, identical: same,
  parMs: Math.round(parMs), serMs: Math.round(serMs), speedup: +(serMs / parMs).toFixed(2),
}))
