// P4-1 探针：拆开看 mht8（8 字节长距匹配）与 a2（第二级 APM）各自的净收益。
import { readFile } from 'node:fs/promises'
import { encodeCM, apm2Tuning, setNoMht8 } from '../../src/lib/coder'

const file = process.argv[2] ?? '/tmp/corpus/xml'
const limit = Number(process.argv[3] ?? 524288)
const profile = process.argv[4] ?? 'text'
const raw = await readFile(file)
const data = raw.length > limit ? raw.subarray(0, limit) : raw

const enc = () => encodeCM(data, profile as never, 1, 1, undefined, 0, undefined, undefined, 'v15' as never, 0).length
const v13 = encodeCM(data, profile as never, 1, 1, undefined, 0, undefined, undefined, 'v13' as never, 0).length

apm2Tuning.on = false
setNoMht8(true)
const plain = enc()
setNoMht8(false)
const withMht8 = enc()
// a2 扫参：上下文粒度 × 权重
const sweep: {cfg:string; bytes:number}[] = []
for (const ctx of [0, 1, 2]) for (const w of [1, 2, 3]) {
  apm2Tuning.on = true; apm2Tuning.ctx = ctx; apm2Tuning.weight = w
  sweep.push({ cfg: `ctx=${ctx} w=${w}`, bytes: enc() })
}
sweep.sort((a,b)=>a.bytes-b.bytes)
apm2Tuning.ctx = 0; apm2Tuning.weight = 1
const both = sweep[0].bytes
const bestCfg = sweep[0].cfg

const pct = (a: number, b: number) => +((b / a - 1) * 100).toFixed(2)
console.log(JSON.stringify({
  file: file.split('/').pop(), size: data.length, profile, v13,
  v15plain: plain, v15mht8: withMht8, v15best: both, bestCfg,
  mht8Pct: pct(v13, withMht8), a2Pct: pct(withMht8, both),
  mht8Gain: withMht8 - plain, a2Gain: both - withMht8, sweep: sweep.slice(0,4),
}, null, 1))
