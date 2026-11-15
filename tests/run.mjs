import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const dir = await mkdtemp(join(tmpdir(), 'ucz-test-'))
try {
  const file = join(dir, 'test.cjs')
  await build({entryPoints:['tests/codec.test.ts'], bundle:true, platform:'node', format:'cjs', outfile:file, logLevel:'silent'})
  const result = spawnSync(process.execPath, [file], {stdio:'inherit'})
  if (result.error) throw result.error
  // P31.0：CLI 冒烟测试单独跑（它需要 esbuild 的 JS API，不能被上面打进单文件）。
  const cli = spawnSync(process.execPath, ['tests/cli.test.mjs'], {stdio:'inherit'})
  if (cli.error) throw cli.error
  process.exitCode = (result.status ?? 1) || (cli.status ?? 1)
} finally { await rm(dir, {recursive:true, force:true}) }
