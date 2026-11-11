// 诊断：解压 .ucz 时没有任何输出上限校验——伪造一个声明巨大长度的最小容器即可触发大额分配。
// 同时展示小输入时容器头占比。
import { decompress } from '../../src/lib/codec'
import { MAX_INPUT_BYTES } from '../../src/lib/limits'

const putVar = (v: number) => { const o: number[] = []; while (v >= 128) { o.push((v % 128) | 128); v = Math.floor(v / 128) } o.push(v); return o }
const cases = [MAX_INPUT_BYTES, 512 * 1024 * 1024, 1024 * 1024 * 1024]
for (const n of cases) {
  const c = Uint8Array.from([0x55, 0x43, 0x5a, 14, ...putVar(n), ...putVar(1)])
  const t = performance.now()
  let alloc: number | string
  try { alloc = decompress(c).length } catch (e) { alloc = 'throw: ' + String((e as Error).message).slice(0, 40) }
  const rss = process.memoryUsage().rss / 1048576
  console.log(JSON.stringify({ claimed: n, containerBytes: c.length, result: alloc, ms: +(performance.now() - t).toFixed(1), rssMiB: +rss.toFixed(1) }))
}
