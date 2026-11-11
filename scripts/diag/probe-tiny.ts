// 诊断：小输入的容器膨胀阈值——从多少字节开始压缩才有意义。
// 用法：node scripts/diag/run.mjs probe-tiny
import { compressAdaptive, decompress, evaluatePlan, ID } from '../../src/lib/codec'

const text = new TextEncoder().encode('the quick brown fox jumps over the lazy dog. '.repeat(400))
const rows = []
for (const n of [1, 8, 16, 32, 64, 128, 256, 512, 1024]) {
  const data = text.subarray(0, n)
  const comp = await compressAdaptive(data)
  const store = evaluatePlan(data, [{ start: 0, end: n, cls: 'binary', spec: { id: ID.STORE, s: 1, r: 1 } }], { alreadyMerged: true }).totalBytes
  rows.push({ n, adaptive: comp.container.length, header: comp.overhead, storeContainer: store, label: comp.segs[0].label, pct: +(comp.container.length / n * 100).toFixed(0) })
}
console.log(JSON.stringify(rows, null, 0))
