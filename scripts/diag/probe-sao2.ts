// P6-4：在整份 sao 上直接测 TRANSPOSE-G3 的 v13 / v15 / v15-无 a2 / v15-无混洗。
// 用法：node scripts/diag/run.mjs probe-sao2 [步长]
import { readFile } from 'node:fs/promises'
import { encodeTerrainGroup } from '../../src/lib/codec'
import { apm2Tuning, mixer2Tuning } from '../../src/lib/coder'

const s = Number(process.argv[2] ?? 28)
const data = await readFile('/tmp/corpus/sao')
const spec = { id: 30, s, r: 1 } as const
const enc = (kernel: 'v13' | 'v15') => encodeTerrainGroup([data], spec, undefined, undefined, undefined, [0], kernel).length
const t0 = Date.now()
const v13 = enc('v13'); console.error('v13 ' + (Date.now() - t0) + 'ms')
const t1 = Date.now()
const v15 = enc('v15'); console.error('v15 ' + (Date.now() - t1) + 'ms')
apm2Tuning.on = false
const v15NoA2 = enc('v15'); apm2Tuning.on = true
mixer2Tuning.on = false
const v15NoMix = enc('v15'); mixer2Tuning.on = true
console.log(JSON.stringify({
  s, n: data.length, v13, v15, 'v15%': +((v15 / v13 - 1) * 100).toFixed(3),
  v15NoA2, 'noA2%': +((v15NoA2 / v13 - 1) * 100).toFixed(3),
  v15NoMix, 'noMix%': +((v15NoMix / v13 - 1) * 100).toFixed(3),
}))
