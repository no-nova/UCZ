// P6-4：同一进程内比较 encodeTerrainGroup(id30,'v15') 与流水线里的转置编码。
import { readFile } from 'node:fs/promises'
import { encodeTerrainGroup, compressAdaptive } from '../../src/lib/codec'
import { apm2Tuning, mixer2Tuning, mixer2Suppress } from '../../src/lib/coder'
const data = await readFile('/tmp/corpus/sao')
const spec = { id: 30, s: 28, r: 1 } as const
const t = (label: string, f: () => number) => { const a = Date.now(); const n = f(); console.log(label, n, (Date.now() - a) + 'ms') }
t('terrain v13        ', () => encodeTerrainGroup([data], spec, undefined, undefined, undefined, [0], 'v13').length)
t('terrain v15        ', () => encodeTerrainGroup([data], spec, undefined, undefined, undefined, [0], 'v15').length)
mixer2Tuning.on = false
t('terrain v15 nomix  ', () => encodeTerrainGroup([data], spec, undefined, undefined, undefined, [0], 'v15').length)
mixer2Tuning.on = true
mixer2Suppress.depth = 1
t('terrain v15 suppress', () => encodeTerrainGroup([data], spec, undefined, undefined, undefined, [0], 'v15').length)
mixer2Suppress.depth = 0
apm2Tuning.on = false
t('terrain v15 noa2   ', () => encodeTerrainGroup([data], spec, undefined, undefined, undefined, [0], 'v15').length)
apm2Tuning.on = true
const comp = await compressAdaptive(data, undefined, { serial: true })
console.log('pipeline           ', comp.container.length, comp.container[3])
