// 噪声区特征分布：哪些 'noise' 段其实可压。
import { readFile } from 'node:fs/promises'
import { analyze } from '../../src/lib/analyze'

const n = Number(process.argv[2] ?? 2 * 1024 * 1024)
for (const f of process.argv.slice(3).length ? process.argv.slice(3) : ['mozilla', 'samba', 'osdb', 'ooffice']) {
  const data = (await readFile('/tmp/corpus/' + f)).subarray(0, n)
  const a = analyze(data)
  for (const s of a.segs) {
    if (s.cls !== 'noise') continue
    const seg = data.subarray(s.start, s.end)
    const h = new Float64Array(256), hd = new Float64Array(256)
    let rep = 0
    for (let i = 0; i < seg.length; i++) {
      h[seg[i]]++
      if (i) { const d = (seg[i] - seg[i - 1]) & 255; hd[d]++; if (!d) rep++ }
    }
    const ent = (x: Float64Array, t: number) => { let e = 0; for (let i = 0; i < 256; i++) if (x[i]) { const p = x[i] / t; e -= p * Math.log2(p) } return e }
    console.log(`${f} ${s.start}-${s.end} len=${seg.length} h0=${ent(h, seg.length).toFixed(2)} hd=${ent(hd, Math.max(1, seg.length - 1)).toFixed(2)} rep=${(rep / Math.max(1, seg.length - 1)).toFixed(3)}`)
  }
}
