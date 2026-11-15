import { build } from 'esbuild'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// `--corpus <dir>`（或第一个位置参数就是目录）走语料库驱动：它按文件隔离子进程、
// 统计每个文件的峰值内存，并支持 --jobs/--threads/--out/--baseline。
// 单个文件仍然走原来的 bench.ts。过去这里把目录直接交给 readFileSync，于是
// `npm run bench -- --corpus <dir>` 抛 EISDIR。
const argv = process.argv.slice(2)
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

async function isDirectory(path) {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

let corpusMode = argv.includes('--corpus')
if (!corpusMode) {
  const positional = argv.filter((a, i) => !a.startsWith('-') && !(i > 0 && ['--jobs', '-P', '--threads', '--out'].includes(argv[i - 1])))
  corpusMode = positional.length > 0 && await isDirectory(positional[0])
}

if (corpusMode) {
  const args = argv.includes('--corpus') ? argv : ['--corpus', ...argv]
  const r = spawnSync(process.execPath, [join(here, 'diag/bench-corpus.mjs'), ...args], { cwd: root, stdio: 'inherit' })
  if (r.error) throw r.error
  process.exitCode = r.status ?? 1
} else {
  const dir = await mkdtemp(join(tmpdir(), 'ucz-bench-cli-'))
  try {
    const file = join(dir, 'bench.mjs')
    await build({ entryPoints: ['scripts/bench.ts'], bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'silent' })
    const result = spawnSync(process.execPath, [file, ...argv], { stdio: 'inherit' })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  } finally { await rm(dir, { recursive: true, force: true }) }
}
