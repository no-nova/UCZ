// Bounded implementation probes. Does NOT alter archived P12 audit receipts.
// node scripts/diag/p12-impl/run.mjs <phase> <slice> <case> [git-source-ref]
// Each invocation runs one <=512 KiB case and saves immutable provenance.
import { build } from 'esbuild'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
const begun = performance.now(), root = process.cwd()
const [phase, slice, which, ref = 'working'] = process.argv.slice(2)
if (![phase, slice, which].every(x => x && /^[\w.-]+$/.test(x))) throw Error('phase / slice / case required')
const sha = b => createHash('sha256').update(b).digest('hex')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const dir = resolve('.diag-state/p12-impl'); mkdirSync(dir, { recursive: true })
let lib = resolve('src/lib'), commit = head
if (ref !== 'working') {
  commit = execFileSync('git', ['rev-parse', ref], { encoding: 'utf8' }).trim()
  lib = join(dir, commit, 'src/lib'); mkdirSync(lib, { recursive: true })
  const prefix = 'universal-adaptive-compression-system/src/lib/'
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', commit, '--', 'src/lib'], { encoding: 'utf8' }).trim().split('\n')
  for (const rel of paths) {
    const blob = execFileSync('git', ['show', `${commit}:${prefix}${rel.replace(/^src\/lib\//, '')}`], { maxBuffer: 4 * 1024 * 1024 })
    const path = join(lib, rel.replace(/^src\/lib\//, '')); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, blob)
  }
}
const sourceFiles = Object.fromEntries(readdirSync(lib).sort().filter(f => f.endsWith('.ts')).map(f => [f, sha(readFileSync(join(lib, f)))]))
const sourceSha256 = sha(JSON.stringify(sourceFiles))
const entry = resolve('scripts/diag/p12-impl/probe.ts'), bundle = join(dir, `${phase}-${slice}-${which}-${sourceSha256}.cjs`)
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent',
  plugins: [{ name: 'implementation-source', setup(b) { b.onResolve({ filter: /^@lib\// }, a => ({ path: join(lib, a.path.slice(5) + '.ts') })) } }] })
const receiptPath = resolve(`scripts/diag/p12-impl-results/${phase}/${slice}-${which}-${ref === 'working' ? 'current' : commit.slice(0, 8)}.json`)
if (existsSync(receiptPath)) throw Error(`Refusing to overwrite receipt: ${receiptPath}`)
const budget = Math.max(1, 17500 - Math.ceil(performance.now() - begun))
const run = spawnSync(process.execPath, [bundle, slice, which], { encoding: 'utf8', timeout: budget, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 })
const record = { phase, slice, case: which, commit, workingSource: ref === 'working', sourceSha256, sourceFiles,
  probeSha256: sha(readFileSync(entry)), runnerSha256: sha(readFileSync('scripts/diag/p12-impl/run.mjs')), bundleSha256: sha(readFileSync(bundle)),
  command: process.argv.slice(1), node: process.version, durationMs: Math.round(performance.now() - begun),
  status: run.status === 0 && !run.error ? 'PASS' : 'FAIL', stdout: run.stdout, stderr: run.stderr, error: run.error?.message }
if (record.status === 'PASS') record.result = JSON.parse(run.stdout.trim().split('\n').at(-1))
mkdirSync(dirname(receiptPath), { recursive: true }); writeFileSync(receiptPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ receiptPath, status: record.status, durationMs: record.durationMs, ...record.result, error: record.error }))
if (record.status !== 'PASS') { console.error(run.stderr); process.exitCode = 1 }
