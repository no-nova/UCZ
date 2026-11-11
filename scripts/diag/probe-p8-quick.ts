// P8：吞吐量标定（临时）
import { readFile } from 'node:fs/promises'
import { encodeCM } from '../../src/lib/coder'
const raw = await readFile('/tmp/corpus/dickens')
for (const n of [64*1024, 256*1024, 1024*1024]) {
  const d = raw.subarray(0, n)
  let t = performance.now(); const a = encodeCM(d, 'text', 1, 1, undefined, 0, undefined, undefined, 'v13')
  const t13 = performance.now() - t
  t = performance.now(); const b = encodeCM(d, 'text', 1, 1, undefined, 0, undefined, undefined, 'v15')
  const t15 = performance.now() - t
  console.log(`n=${n} v13=${t13.toFixed(0)}ms (${(n/1024/t13*1000).toFixed(0)} KB/s) out=${a.length} | v15=${t15.toFixed(0)}ms (${(n/1024/t15*1000).toFixed(0)} KB/s) out=${b.length}`)
}
