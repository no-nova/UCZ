import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const scratch = await mkdtemp(join(tmpdir(), 'p9-macro-test-'))
try {
  const file = join(scratch, 'test.mjs')
  await build({ stdin: { contents: "import { testP9Macro } from './tests/p9-macro.test.ts'; await testP9Macro({quick: process.env.P9_QUICK_TEST === '1'})", resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'silent' })
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit', timeout: 120000 })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally { await rm(scratch, { recursive: true, force: true }) }
