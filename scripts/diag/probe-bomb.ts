// 诊断：手工构造的极小容器头声称巨大解压长度时，decompress 是否会分配巨量内存。
import { decompress } from '../../src/lib/codec'
const putVar = (v: number) => { const o: number[] = []; while (v >= 128) { o.push((v % 128) | 128); v = Math.floor(v / 128) } o.push(v); return o }
// 上限默认 256 MiB：64 MiB（正常上限内）必须仍可解码，1 GiB/1 TiB 必须被拒。
for (const n of [64 * 1024 * 1024, 256 * 1024 * 1024 + 1, 1024 * 1024 * 1024, 2 ** 40]) {
  const c = Uint8Array.from([0x55, 0x43, 0x5a, 14, ...putVar(n), ...putVar(1)])
  const t = performance.now()
  try {
    const out = decompress(c)
    console.log(n, '-> 分配并返回', out.length, '字节, ms', Math.round(performance.now() - t))
  } catch (e) {
    console.log(n, '-> 抛出:', String((e as Error).message).slice(0, 80), '| ms', Math.round(performance.now() - t), '| rssMiB', Math.round(process.memoryUsage().rss / 1048576))
  }
}
