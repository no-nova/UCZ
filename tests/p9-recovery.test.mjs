import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { mkdtemp, mkdir, cp, symlink, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  SCHEMA, SOURCE_PATHS, RESULT_DIR, canonical, sha256, jobKey, atomicJson, readJson,
  sealResult, loadResult, sourceFingerprint, acquireLock,
} from '../scripts/diag/p9-checkpoint.mjs'

const project = fileURLToPath(new URL('../', import.meta.url))
let scratch, fixture, timeoutFixture
async function makeProject(path) {
  await mkdir(path, { recursive: true })
  for (const rel of new Set([...SOURCE_PATHS, 'scripts/diag/baseline.json'])) {
    await mkdir(dirname(join(path, rel)), { recursive: true })
    await cp(join(project, rel), join(path, rel), { recursive: true })
  }
  await symlink(join(project, 'node_modules'), join(path, 'node_modules'), 'dir')
  await mkdir(join(path, '.diag-data/corpus'), { recursive: true })
  for (const name of ['smoke-a', 'smoke-b', 'smoke-c', 'smoke-failure']) {
    await writeFile(join(path, '.diag-data/corpus', name), Buffer.from('UCZ recovery test: deterministic small fixture.\n'.repeat(100)))
  }
}
function run(args = [], env = {}, root = fixture) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('P9_')))
  const res = spawnSync(process.execPath, ['scripts/diag/run-p9.mjs', '--local-only', '--bytes', '4096', ...args], {
    cwd: root, env: { ...clean, ...env }, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024,
  })
  if (res.error) throw res.error
  const events = res.stdout.trim().split('\n').filter(Boolean).map(s => JSON.parse(s))
  return { ...res, events, done: events.find(e => e.kind === 'done') }
}
function success(res) { assert.equal(res.status, 0, `${res.stderr}\n${res.stdout}`) }
function identity() {
  return { schema: SCHEMA, sourceSha256: sha256('source'), knobs: { textOn: false },
    input: { sha256: sha256('data'), n: 4, offset: 0 } }
}
function record(id) {
  return sealResult({ schema: SCHEMA, status: 'complete', key: jobKey(id), identity: id,
    n: 4, ucz: 12, verified: true, containerSha256: sha256('container') })
}

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'p9-recovery-test-'))
  fixture = join(scratch, 'project'); timeoutFixture = join(scratch, 'timeout-project')
  await makeProject(fixture)
  await makeProject(timeoutFixture)
})
after(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }) })

test('identity binds bytes, slice, knobs and source; object property order is irrelevant', () => {
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }))
  const id = identity(), key = jobKey(id)
  for (const other of [
    { ...id, sourceSha256: sha256('new-source') },
    { ...id, knobs: { textOn: true } },
    { ...id, input: { ...id.input, offset: 1 } },
    { ...id, input: { ...id.input, sha256: sha256('new-data') } },
  ]) assert.notEqual(jobKey(other), key)
})

test('only a sealed verified complete record is reusable; corruption fails closed', async () => {
  const path = join(scratch, 'record.json'), id = identity(), rec = record(id)
  await atomicJson(path, rec)
  assert.deepEqual(await loadResult(path, id), rec)
  await atomicJson(path, { ...rec, ucz: rec.ucz + 1 })
  await assert.rejects(loadResult(path, id), /无效检查点/)
  await atomicJson(path, sealResult({ ...rec, verified: false }))
  await assert.rejects(loadResult(path, id), /无效检查点/)
  await writeFile(path, '{"half":')
  await assert.rejects(loadResult(path, id), SyntaxError)
})

test('stranded temporary writes never count as a completed result', async () => {
  const path = join(scratch, 'unfinished.json')
  await writeFile(`${path}.interrupted.tmp`, '{"half":')
  assert.equal(await loadResult(path, identity()), null)
  await atomicJson(path, record(identity()))
  assert.ok(await loadResult(path, identity()))
})

test('mutex refuses duplicate live jobs and recovers a lock from an old sandbox', async () => {
  const path = join(scratch, 'run.lock')
  const release = await acquireLock(path)
  await assert.rejects(acquireLock(path), /已有测量进程/)
  await release()
  await atomicJson(path, { pid: process.pid, host: 'old-sandbox', boot: 'old-boot', start: '0' })
  const recovered = await acquireLock(path)
  await recovered()
  assert.equal(await readJson(path), null)
})

test('report/evidence changes do not invalidate the source fingerprint; source changes do', async () => {
  const before = await sourceFingerprint(fixture)
  await writeFile(join(fixture, 'P9_STATUS.md'), 'Evidence-only edit, not codec source')
  assert.equal((await sourceFingerprint(fixture)).sha256, before.sha256)
  const path = join(fixture, 'src/lib/coder.ts'), original = await readFile(path)
  await writeFile(path, Buffer.concat([original, Buffer.from('\n// fingerprint test\n')]))
  assert.notEqual((await sourceFingerprint(fixture)).sha256, before.sha256)
  await writeFile(path, original)
})

test('default budget is ONE; a second invocation resumes; relabeling does not repeat encoding', () => {
  const first = run(['smoke-a', 'smoke-b'])
  success(first)
  assert.equal(first.done.measured, 1)
  assert.equal(first.done.pending, 1)
  assert.equal(first.events.filter(e => e.kind === 'result').length, 1)
  const second = run(['smoke-a', 'smoke-b'], { P9_LABEL: 'new-label' })
  success(second)
  assert.equal(second.done.measured, 1)
  assert.equal(second.done.cached, 1)
  const third = run(['smoke-a', 'smoke-b'])
  success(third)
  assert.equal(third.done.measured, 0)
  assert.equal(third.done.cached, 2)
  assert.equal(third.events.some(e => e.kind === 'start'), false)
})

test('status is read-only and an interrupted running marker does not masquerade as success', async () => {
  const status = run(['--status', 'smoke-c'])
  success(status)
  const pending = status.events.find(e => e.kind === 'status' && e.file === 'smoke-c')
  assert.equal(pending.status, 'pending')
  assert.equal(await readJson(pending.statePath), null)
  await atomicJson(pending.statePath, { status: 'running', attempt: 1, key: pending.key })
  const resumed = run(['smoke-c'])
  success(resumed)
  assert.equal(resumed.done.measured, 1)
  assert.equal((await readJson(pending.statePath)).attempt, 2)
})

test('failed tasks require explicit retry; failure cannot be hidden by a final success message', async () => {
  const status = run(['--status', 'smoke-failure'])
  const pending = status.events.find(e => e.kind === 'status' && e.file === 'smoke-failure')
  await atomicJson(pending.statePath, { status: 'failed', attempt: 1, key: pending.key })
  const blocked = run(['smoke-failure'])
  assert.equal(blocked.status, 2)
  assert.equal(blocked.done.measured, 0)
  assert.equal(blocked.done.blocked, 1)
  assert.equal(blocked.events.some(e => e.kind === 'start'), false)
  const retried = run(['--retry-failed', 'smoke-failure'])
  success(retried)
  assert.equal(retried.done.measured, 1)
})

test('changed knobs or input bytes create a new job rather than reuse the wrong result', async () => {
  const changedKnob = run(['smoke-a'], { P9_SET: 'planTuning.neutralPenalties=true' })
  success(changedKnob)
  assert.equal(changedKnob.done.measured, 1)
  const dataPath = join(fixture, '.diag-data/corpus/smoke-a')
  const data = await readFile(dataPath); data[0] ^= 1; await writeFile(dataPath, data)
  const changedInput = run(['smoke-a'])
  success(changedInput)
  assert.equal(changedInput.done.measured, 1)
})

test('missing inputs, malformed knobs and a wrong named corpus fail fast', async () => {
  assert.equal(run(['absent-file']).status, 2)
  assert.equal(run(['smoke-a'], { P9_SET: 'a2Tuning.textOn=wrong-type' }).status, 1)
  assert.equal(run(['smoke-a'], { P9_SET: 'planTuning.unknown=true' }).status, 1)
  await writeFile(join(fixture, '.diag-data/corpus/osdb'), Buffer.alloc(4096))
  const wrong = run(['osdb'])
  assert.equal(wrong.status, 1)
  assert.match(wrong.stderr, /Silesia 指纹不符/)
})

test('timeout kills the entire process group and leaves a non-success checkpoint', async () => {
  // 故障注入：不是压缩基准。模拟同步卡住的 worker 和其孙进程，避免长测。
  await writeFile(join(timeoutFixture, 'scripts/diag/run.mjs'), `
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicJson, pathsFor } from './p9-checkpoint.mjs'
const root = process.cwd(), key = 'a'.repeat(64), paths = pathsFor(root, key)
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
await writeFile(join(root, 'grandchild.pid'), String(grandchild.pid))
await atomicJson(paths.state, { key, status: 'running', file: 'timeout-fixture' })
console.log(JSON.stringify({ kind: 'start', key, file: 'timeout-fixture', resultPath: paths.result, statePath: paths.state }))
setInterval(() => {}, 1000)
`)
  const timedOut = run(['--timeout', '0.8'], {}, timeoutFixture)
  assert.equal(timedOut.status, 124, timedOut.stderr)
  const state = await readJson(join(timeoutFixture, RESULT_DIR, 'jobs', `${'a'.repeat(64)}.json`))
  assert.equal(state.status, 'timed-out')
  assert.equal(await readJson(join(timeoutFixture, RESULT_DIR, `${'a'.repeat(64)}.json`)), null)
  const pid = (await readFile(join(timeoutFixture, 'grandchild.pid'), 'utf8')).trim()
  // Linux 的已终止孤儿可能短暂处于 zombie；不能继续在后台消耗 CPU。
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e })
  if (stat) assert.equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0], 'Z')
})
