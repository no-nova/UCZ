import { readFile } from 'node:fs/promises'
import { compressAdaptive } from '../../src/lib/codec'
const f = process.argv[2] ?? '/tmp/corpus/xml'
;(globalThis as any).__WP_STATS = []
const data = new Uint8Array(await readFile(f))
const t0 = performance.now()
const r = await compressAdaptive(data)
console.log(JSON.stringify({ file: f.split('/').pop(), bytes: r.container.length, ms: Math.round(performance.now() - t0), stats: (globalThis as any).__WP_STATS }))
