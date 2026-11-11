// 统一的 TS 探针运行器：用 esbuild 打包到临时目录后以子进程执行，
// 这样可以直接运行 src/lib 下的 TypeScript 源码而不影响 tsc / 构建产物。
// 用法：node scripts/diag/run.mjs <脚本名> [参数...]
//   例：node scripts/diag/run.mjs bench-one /path/to/file --no-bench
//   例：node scripts/diag/run.mjs probe-analyze /path/to/a /path/to/b
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const [name, ...rest] = process.argv.slice(2)
if (!name) {
  console.error('用法: node scripts/diag/run.mjs <脚本名> [参数...]')
  process.exit(2)
}
const entry = join(here, `${name}.ts`)
// P9 的证据必须绑定打包时的源码，而不是运行结束时猜测当前 HEAD。
const projectRoot = join(here, '../..')
const fingerprint = name === 'probe-p9-ab' || name === 'bench-one' || name === 'probe-p10-smoke' || name === 'probe-p11-smoke' || name === 'probe-p111-smoke'
  ? (await import('./p9-checkpoint.mjs')).sourceFingerprint : null
const source = fingerprint ? await fingerprint(projectRoot) : null
if (source && process.env.P9_SOURCE_SHA && process.env.P9_SOURCE_SHA !== source.sha256) {
  throw new Error('P9 源码在驱动启动后变化；拒绝继续')
}
const dir = await mkdtemp(join(tmpdir(), 'terrazip-diag-'))
try {
  const out = join(dir, 'probe.mjs')
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' })
  if (source && (await fingerprint(projectRoot)).sha256 !== source.sha256) throw new Error('P9 打包期间源码变化')
  const r = spawnSync(process.execPath, [out, ...rest], {
    stdio: 'inherit',
    env: source ? { ...process.env, P9_PROJECT_ROOT: projectRoot, P9_SOURCE_SHA: source.sha256 } : process.env,
  })
  if (r.error) throw r.error
  process.exitCode = r.status ?? 1
} finally {
  await rm(dir, { recursive: true, force: true })
}
