// 诊断：把“最终编码”这段工作单独放进全新进程，比较冷态与热态的耗时，
// 从而区分「算法本身的开销」与「JIT / 大表首次分配」的开销。
import { readFile } from 'node:fs/promises'
import { compressAdaptive, encodeTerrainGroup } from '../../src/lib/codec'
import { BLOCK } from '../../src/lib/analyze'

const file = process.argv[2] ?? '/tmp/corpus/xml'
const data = await readFile(file)
// 只做分析+选择（compressAdaptive 会顺带完成最终编码，这里接受这次开销）
const comp = await compressAdaptive(data)
const groups = new Map<string, number[]>()
comp.segs.forEach((s, i) => {
  const k = `${s.spec.id},${s.spec.s},${s.spec.r}`
  if (!groups.has(k)) groups.set(k, [])
  groups.get(k)!.push(i)
})
function encodeAll() {
  let bytes = 0
  const t = performance.now()
  for (const [, idx] of groups) {
    const segs = idx.map(i => comp.segs[i])
    const parts = segs.map(s => data.subarray(s.start, s.end))
    const ends: number[] = []
    let logical = 0
    for (const sg of segs) for (let p = sg.start; p < sg.end;) {
      const end = Math.min(sg.end, (Math.floor(p / BLOCK) + 1) * BLOCK)
      logical += end - p; ends.push(logical); p = end
    }
    const bins = { values: new Float32Array(ends.length), blockSize: BLOCK, ends: Uint32Array.from(ends) }
    bytes += encodeTerrainGroup(parts, segs[0].spec, undefined, bins, undefined, segs.map(s => s.start)).length
  }
  return { ms: Math.round(performance.now() - t), bytes }
}
const passes = [encodeAll(), encodeAll(), encodeAll()]
console.log(JSON.stringify({ file: file.split('/').pop(), size: data.length, groups: groups.size, passes, ratioPass2vs1: +(passes[1].ms / passes[0].ms).toFixed(2) }))
