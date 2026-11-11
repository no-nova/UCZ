// P2-2 探针：mozilla 上 BCJ3 区域的真实构成 —— 为什么 bpi 高达 7.5。
// 取几个 BCJ3 区域，测：原始 / BCJ 变换后 / x86 扫描 / Alpha BSR 扫描。
import { readFile } from 'node:fs/promises'
import { encodeCM } from '../../src/lib/coder'
import { bcjFwd } from '../../src/lib/transforms'
import { compressAdaptive } from '../../src/lib/codec'

const raw = await readFile('/tmp/corpus/mozilla')
const c = await compressAdaptive(raw)
const targets = c.segs.filter(s => s.label.startsWith('BCJ')).slice(0, 6)
console.log('BCJ regions:', c.segs.filter(s => s.label.startsWith('BCJ')).length,
  'total raw', c.segs.filter(s => s.label.startsWith('BCJ')).reduce((a, s) => a + s.rawLen, 0),
  'total comp', c.segs.filter(s => s.label.startsWith('BCJ')).reduce((a, s) => a + s.compLen, 0))

for (const sg of targets) {
  const part = raw.subarray(sg.start, Math.min(sg.end, sg.start + 65536))
  const tr = bcjFwd(part, sg.start)
  const a = encodeCM(part, 'bin', 1, 1).length
  const b = encodeCM(tr, 'bin', 1, 1).length
  const a3 = encodeCM(part, 'bin', 1, 1, undefined, 0, undefined, undefined, 'v13').length
  const b3 = encodeCM(tr, 'bin', 1, 1, undefined, 0, undefined, undefined, 'v13').length
  // 字节熵
  const hist = new Uint32Array(256); for (const x of part) hist[x]++
  let H = 0; for (const k of hist) if (k) { const p = k / part.length; H -= p * Math.log2(p) }
  // 4 字节对齐零字比例
  let zero = 0, n = part.length >> 2
  const w = new Uint32Array(part.buffer, part.byteOffset, n)
  for (let i = 0; i < n; i++) if (w[i] === 0) zero++
  console.log(JSON.stringify({
    start: sg.start, len: part.length, label: sg.label, compBpi: +(sg.compLen * 8 / sg.rawLen).toFixed(2),
    entropy: +H.toFixed(3), zeroWords: +(zero / n * 100).toFixed(1),
    bin: a, bcj: b, bin3: a3, bcj3: b3,
  }))
}
