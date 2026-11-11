// Validate the saved implementation evidence without encoding any corpus bytes.
// --current additionally binds the nine P12.2 checkpoint receipts to src/lib.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
const sha = value => createHash('sha256').update(value).digest('hex')
const load = path => JSON.parse(readFileSync(path, 'utf8'))
const root = 'scripts/diag/p12-impl-results'
const phases = { p120: 8, p121: 22, p122: 9, 'p122-final': 15, 'p122-checkpoint': 9 }
const records = [], counts = {}
for (const [phase, count] of Object.entries(phases)) {
  const paths = readdirSync(join(root, phase)).filter(f => f.endsWith('.json')).sort()
  assert.equal(paths.length, count, `${phase} receipt count`)
  counts[phase] = paths.length
  for (const file of paths) {
    const rec = load(join(root, phase, file)), r = rec.result
    assert.equal(rec.status, 'PASS', file)
    assert.equal(rec.phase, phase)
    assert.ok(rec.durationMs > 0 && rec.durationMs < 19000, file)
    assert.equal(rec.sourceSha256, sha(JSON.stringify(rec.sourceFiles)), file)
    for (const hash of [rec.sourceSha256, rec.probeSha256, rec.runnerSha256, rec.bundleSha256, ...Object.values(rec.sourceFiles)])
      assert.match(hash, /^[0-9a-f]{64}$/)
    assert.deepEqual(JSON.parse(rec.stdout.trim().split('\n').at(-1)), r)
    assert.equal(r.roundtrip, true)
    assert.ok(r.input.bytes > 0 && r.input.bytes <= 512 * 1024)
    assert.ok(r.headerBytes > 0 && r.bytes >= r.headerBytes)
    assert.match(r.containerSha256, /^[0-9a-f]{64}$/)
    assert.ok(r.candidates.every(c => c.bytes >= r.bytes))
    records.push(rec)
  }
}
const baseline = load('scripts/diag/baselines/p111-a3b6c3d.json')
const locked = { xml:349873, dickens:2248669, ooffice:1973904, mr:2039355, osdb:2318027,
  'x-ray':3662990, sao:3747789, reymont:1092321, nci:1309875, samba:3407921, webster:6405652, mozilla:13257771 }
assert.deepEqual(Object.fromEntries(baseline.files.map(r => [r.file,r.bestUcz])), locked)
assert.equal(baseline.total.bestUcz, 41814147)
assert.equal(baseline.bestUczPolicy.strict, true)
const currentFiles = Object.fromEntries(readdirSync('src/lib').sort().filter(f => f.endsWith('.ts'))
  .map(f => [f, sha(readFileSync(join('src/lib',f)))]))
const rows = []
for (const rec of records.filter(r => r.phase === 'p122-checkpoint')) {
  assert.equal(rec.result.input.bytes, 262144)
  assert.equal(rec.result.version, 20)
  if (process.argv.includes('--current')) assert.deepEqual(rec.sourceFiles,currentFiles,'checkpoint source differs from current src/lib')
  const binary = rec.case.startsWith('bin-')
  assert.equal(rec.result.flags,binary ? 0x3000 : 0x1000)
  const prior = records.find(r => r.phase === 'p122-final' && r.slice === rec.slice && r.workingSource)
  assert.ok(prior)
  assert.deepEqual(rec.result.input,prior.result.input)
  assert.equal(rec.result.bytes,prior.result.bytes)
  assert.equal(rec.result.containerSha256,prior.result.containerSha256,'default/source replay changed bytes')
  const control = records.find(r => r.slice === rec.slice && r.case === (binary ? 'bin-v15' : 'text-v15') && !r.workingSource)
  assert.ok(control && control.commit === 'c97b6d360805cafbf9e14ee0e7869e67c01671b7')
  assert.deepEqual(control.result.input,rec.result.input)
  const from = control.result.bytes, to = rec.result.bytes
  assert.ok(to < from,'each measured window must win independently')
  let recovery = null
  if (binary) {
    const off = records.find(r => r.phase === 'p122' && r.slice === rec.slice && r.case === 'bin-v20')
    const on = records.find(r => r.phase === 'p122' && r.slice === rec.slice && r.case === 'bin-v20-gap')
    assert.equal(off.result.flags,0x1000); assert.equal(on.result.flags,0x3000)
    assert.equal(rec.result.containerSha256,on.result.containerSha256)
    assert.ok(on.result.bytes < off.result.bytes)
    recovery = { off:off.result.bytes, on:on.result.bytes, delta:on.result.bytes-off.result.bytes }
  }
  rows.push({ slice:rec.slice, profile:binary?'bin':'text', controlBytes:from, checkpointBytes:to,
    deltaBytes:to-from, deltaPct:+((to-from)/from*100).toFixed(3), recovery })
}
console.log(JSON.stringify({ receiptRecordsChecked:records.length, counts,
  maxReceiptMs:Math.max(...records.map(r=>r.durationMs)),
  p122MaxReceiptMs:Math.max(...records.filter(r=>r.phase.startsWith('p122')).map(r=>r.durationMs)),
  currentSourceChecked:process.argv.includes('--current'), currentLibSha256:sha(JSON.stringify(currentFiles)),
  historicalP111ReferenceBytes:41814147,currentLockedBaselineBytes:load("scripts/diag/baseline.json").total.bestUcz, fullCorpusEncodedHere:false, rows },null,2))
