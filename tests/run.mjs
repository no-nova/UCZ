import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const dir = await mkdtemp(join(tmpdir(), 'terrazip-test-'))
try {
  const file = join(dir, 'test.cjs')
  await build({entryPoints:['tests/codec.test.ts'], bundle:true, platform:'node', format:'cjs', outfile:file, logLevel:'silent'})
  const result = spawnSync(process.execPath, [file], {stdio:'inherit'})
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally { await rm(dir, {recursive:true, force:true}) }
