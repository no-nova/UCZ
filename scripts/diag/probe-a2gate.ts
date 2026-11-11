// 自检：res2d 的 v15 流必须与 a2 开关无关；text 必须随开关变化。
import { encodeCM, apm2Tuning } from '../../src/lib/coder'
const body = new Uint8Array(6000)
for (let i = 0; i < body.length; i++) body[i] = (i * 37 + (i >> 3)) & 255
const enc = (p: 'res2d' | 'text') => encodeCM(body, p, 4, 64, undefined, 0, undefined, undefined, 'v15', 0)
const rOn = enc('res2d'); apm2Tuning.on = false
const rOff = enc('res2d'); const tOff = enc('text'); apm2Tuning.on = true
const tOn = enc('text')
console.log({
  res2dSame: Buffer.from(rOn).equals(Buffer.from(rOff)), res2dOn: rOn.length, res2dOff: rOff.length,
  textDiff: !Buffer.from(tOn).equals(Buffer.from(tOff)), textOn: tOn.length, textOff: tOff.length,
})
