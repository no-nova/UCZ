// 4 B 夹具：旧的载荷择优选出 3 B/+2 B r 头；新的头成本择优保留 4 B。
// 同时验证 BIN 不因无关 textOff 多写 v17；两种宏候选都不能越过完整容器门。
// 不属于 Silesia 性能实验。node scripts/diag/run.mjs probe-p9-macro-guard [输出JSON]
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { compressMacroPlanForProbe, decompress, ID, planTuning } from '../../src/lib/codec'
import { a2Tuning, modelTuning } from '../../src/lib/coder'
import { projectRoot, sourceFingerprint, gitHead, atomicJson, sha256 } from './p9-checkpoint.mjs'

const root = projectRoot(), source = await sourceFingerprint(root)
const output = resolve(root, process.argv[2] ?? 'scripts/diag/p9-results/checks/macro-header-cost-defaults.json')
const raw = Uint8Array.of(0, 7, 6, 5)
const spec = (id: number) => ({ id, s: 1, r: 1 })
const plan = (id: number) => [{ start: 0, end: raw.length, cls: 'binary' as const, spec: spec(id) }]
const keep = { a2: { ...a2Tuning }, model: { ...modelTuning }, plan: { ...planTuning } }
const cases = []
try {
  Object.assign(modelTuning, { maxTableBits: 21, matchTableBits: 20, largeOnly: false })
  for (const realHeaderCosts of [false, true]) for (const textOn of [true, false]) {
    planTuning.realHeaderCosts = realHeaderCosts
    a2Tuning.textOn = textOn
    const baseline = await compressMacroPlanForProbe(raw, plan(ID.STORE), null)
    const guarded = await compressMacroPlanForProbe(raw, plan(ID.STORE), spec(ID.BIN_V3))
    const candidate = await compressMacroPlanForProbe(raw, plan(ID.RLE), spec(ID.BIN_V3))
    assert.equal(candidate.macroComparison!.accepted, true)
    assert.deepEqual(Buffer.from(decompress(candidate.container)), Buffer.from(raw))
    assert.deepEqual(Buffer.from(decompress(guarded.container)), Buffer.from(raw))
    assert.deepEqual(Buffer.from(guarded.container), Buffer.from(baseline.container))
    assert.equal(guarded.macroComparison!.accepted, false)
    assert.equal(guarded.macroComparison!.candidateBytes, candidate.container.length)
    cases.push({ realHeaderCosts, textOn, ...guarded.macroComparison, baselinePayloadBytes: baseline.container.length - baseline.overhead,
      candidatePayloadBytes: candidate.container.length - candidate.overhead,
      selectedSha256: sha256(guarded.container), candidateSha256: sha256(candidate.container),
      baselineVerified: true, candidateVerified: true, keptBaseline: true })
  }
  assert.equal((await sourceFingerprint(root)).sha256, source.sha256)
  await atomicJson(output, { kind: 'macro-container-safety', input: { bytes: Array.from(raw), sha256: sha256(raw) },
    commit: gitHead(root), source, cases })
  for (const c of cases) console.log(JSON.stringify(c))
  console.log(`Evidence saved: ${output}`)
} finally {
  Object.assign(a2Tuning, keep.a2); Object.assign(modelTuning, keep.model); Object.assign(planTuning, keep.plan)
}
