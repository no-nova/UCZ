import { readFile } from 'node:fs/promises'
import { compressAdaptive } from '../../src/lib/codec'
import { apm2Tuning, mixer2Tuning } from '../../src/lib/coder'
const raw = await readFile('/tmp/corpus/xray2m')
for (const a2 of [true, false]) for (const mx of [true, false]) {
  apm2Tuning.on = a2; mixer2Tuning.on = mx
  const c = await compressAdaptive(raw, undefined, { serial: true })
  console.log(`a2=${a2} mix=${mx} -> ${c.container.length} ver${c.container[3]} ${c.segs.map(s=>s.label).join(',')}`)
}
apm2Tuning.on = true; mixer2Tuning.on = true
