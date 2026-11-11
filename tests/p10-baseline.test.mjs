// Metadata-only checker tests. These fabricated rows are NOT corpus measurements.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const base = JSON.parse(await readFile(new URL('../scripts/diag/baseline.json', import.meta.url)))
const script = new URL('../scripts/diag/check-baseline.mjs', import.meta.url).pathname
const values = [333917,2213859,1886060,1772130,2250839,3548450,3132317,1061617,1214334,3330577,6257187,12946031]
assert.deepEqual(base.files.map(r => r.bestUcz), values)
assert.equal(values.reduce((n, v) => n + v, 0), 39947318)
const rows = () => base.files.map(r => ({ file: r.file, size: r.size, sha256: r.sha256,
  ucz: r.bestUcz, pct: +(r.bestUcz / r.size * 100).toFixed(2), verified: true, ver: 20 }))
async function run(edit = () => {}, args = ['--all']) {
  const dir = await mkdtemp(join(tmpdir(), 'p10-checker-'))
  try {
    const data = rows(); edit(data)
    for (let i = 0; i < data.length; i++) await writeFile(join(dir, `${i}.json`), JSON.stringify(data[i]))
    return spawnSync(process.execPath, [script, dir, ...args], { encoding: 'utf8', timeout: 10000 })
  } finally { await rm(dir, { recursive: true, force: true }) }
}
test('exact 12-file floor passes and sums to 39947318', async () => {
  const r = await run(); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /TOTAL 39947318 B/)
})
test('one byte regression fails even with permissive v14 tolerance', async () => {
  const r = await run(xs => xs[0].ucz++, ['99', '--all']); assert.equal(r.status, 1); assert.match(r.stdout, /超过 bestUcz 硬门禁 1 B/)
})
test('a gain elsewhere cannot hide one file regressing', async () => {
  const r = await run(xs => { xs[0].ucz++; xs[1].ucz-- }); assert.equal(r.status, 1); assert.match(r.stdout, /TOTAL 39947318 B/)
})
test('reported ratio cannot hide byte regression', async () => {
  const r = await run(xs => { xs[0].ucz++; xs[0].pct = 0 }); assert.equal(r.status, 1)
})
test('verified, size and SHA checks remain mandatory', async () => {
  for (const edit of [xs => xs[0].verified = false, xs => xs[0].size--, xs => xs[0].sha256 = 'wrong']) {
    const r = await run(edit); assert.equal(r.status, 1)
  }
})
test('missing or duplicate standard rows fail full acceptance', async () => {
  const missing = await run(xs => xs.pop()); assert.equal(missing.status, 1)
  const duplicate = await run(xs => xs.push(xs[0])); assert.equal(duplicate.status, 1); assert.match(duplicate.stdout, /重复记录/)
})
test('invalid byte counts do not pass a hard floor', async () => {
  for (const value of [-1, 0, 1.5, null]) { const r = await run(xs => xs[0].ucz = value); assert.equal(r.status, 1) }
})
test('invalid tolerance fails instead of masking checks', async () => {
  const r = await run(() => {}, ['not-a-number', '--all']); assert.equal(r.status, 2)
})
