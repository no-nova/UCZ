// Bounded UI/scheduler tests. No corpus input or actual compression probes.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
const begun = performance.now()
const directory = resolve('.diag-state/ui-tests')
mkdirSync(directory, { recursive: true })
const path = resolve(directory, `ui-${process.pid}.cjs`)
try {
  await build({ entryPoints: ['tests/ui.test.ts'], bundle: true, platform: 'node', format: 'cjs',
    external: ['react', 'react/*', 'react-dom/*'], outfile: path, logLevel: 'silent' })
  const result = spawnSync(process.execPath, ['--test', path], {
    stdio: 'inherit', timeout: Math.max(1, 17500 - Math.ceil(performance.now() - begun)), killSignal: 'SIGKILL',
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally { rmSync(path, { force: true }) }
