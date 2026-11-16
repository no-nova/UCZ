// Runs the exported `test*` functions of a single TS test module.
// `tests/run.mjs` bundles the whole suite; this exists so CI can invoke one module
// (p12 historical fixtures, edge-case hardening) without loading everything.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const target = process.argv[2]
if (!target) {
  console.error('usage: node tests/run-module.mjs <tests/foo.test.ts>')
  process.exit(2)
}
const modPath = resolve(here, '..', target)
const outDir = resolve(here, '..', '.diag-state', 'module-runner')
mkdirSync(outDir, { recursive: true })
const entry = resolve(outDir, `entry-${process.pid}.ts`)
const outFile = resolve(outDir, `bundle-${process.pid}.cjs`)
writeFileSync(entry, `import * as m from ${JSON.stringify(modPath)}\n` +
  `const names = Object.keys(m).filter(k => k.startsWith('test') && typeof (m as any)[k] === 'function')\n` +
  `if (!names.length) { console.error('no test* exports in ${target}'); process.exit(3) }\n` +
  `;(async () => { for (const n of names) { process.stdout.write('[module] ' + n + ' ... '); await (m as any)[n](); console.log('ok') } console.log('[module] ${target} ' + names.length + ' function(s) passed') })()\n`)
const started = Date.now()
await esbuild.build({ entryPoints: [entry], outfile: outFile, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent' })
const r = spawnSync(process.execPath, [outFile], { stdio: 'inherit' })
const budget = 30 * 60 * 1000
if (Date.now() - started > budget) console.error('[module] exceeded the wall-clock budget')
process.exit(r.status ?? 1)
