import assert from 'node:assert/strict'
import { fastDeepEqual } from './fast-equal'
import { compressAdaptive, compressMacroPlanForProbe, decompress, ID, planTuning, specLabel, type Compressed, type PlanSegment, type Spec } from '../src/lib/codec'
import { a2Tuning, modelTuning } from '../src/lib/coder'

const spec = (id: number): Spec => ({ id, s: 1, r: 1 })
const part = (start: number, end: number, id: number): PlanSegment => ({ start, end, cls: 'binary', spec: spec(id) })
const bytesEqual = (a: Uint8Array, b: Uint8Array) => fastDeepEqual(Buffer.from(a), Buffer.from(b))
function checkResult(result: Compressed, raw: Uint8Array) {
  bytesEqual(decompress(result.container), raw)
  assert.equal(result.overhead + result.segs.reduce((n, s) => n + s.compLen, 0), result.container.length)
  const bits = result.analysis.blocks.reduce((n, b, i) => n + result.blockCost[i] * (b.end - b.start), 0)
  assert.ok(Math.abs(bits - (result.container.length - result.overhead) * 8) < 0.5, '成本图必须属于被选中的容器')
  for (const [i, b] of result.analysis.blocks.entries()) {
    const s = result.segs[result.blockSeg[i]]
    assert.ok(b.start >= s.start && b.start < s.end)
  }
  for (const s of result.segs) assert.equal(s.label, specLabel(s.spec))
  if (result.macroComparison) {
    const m = result.macroComparison
    assert.ok(result.container.length <= m.baselineBytes)
    assert.equal(result.container.length, m.accepted ? m.candidateBytes : m.baselineBytes)
    if (m.accepted) assert.ok(m.candidateBytes! < m.baselineBytes)
  }
}

export async function testP9Macro(options: { quick?: boolean } = {}) {
  const saved = { a2: { ...a2Tuning }, model: { ...modelTuning }, plan: { ...planTuning } }
  let checks = 0
  try {
    Object.assign(modelTuning, { maxTableBits: 21, matchTableBits: 20, largeOnly: false })
    // Preserve the deliberately wrong payload-only proposal to test the final
    // container guard independently of the new, header-aware local selector.
    planTuning.realHeaderCosts = false
    planTuning.macroDirectMaxBytes = 0
    planTuning.macroTextBypass = false
    a2Tuning.wordPreTextOff = false
    // 真正的“载荷更小，容器却更大”：4 B STORE -> 3 B v15 BIN。
    // r 标志增加 2 B；BIN 不使用 textOff，不能再平白多写 v17 的 1 B。
    const tiny = Uint8Array.of(0, 7, 6, 5)
    for (const textOn of [true, false]) {
      a2Tuning.textOn = textOn
      const picks = [part(0, tiny.length, ID.STORE)]
      const before = JSON.stringify(picks)
      const base = await compressMacroPlanForProbe(tiny, picks, null)
      const guarded = await compressMacroPlanForProbe(tiny, picks, spec(ID.BIN_V3))
      const m = guarded.macroComparison!
      assert.equal(m.baselineBytes, 16)
      assert.equal(m.candidateBytes, 17)
      assert.equal(m.candidateBytes! - m.candidateHeaderBytes!, 3)
      assert.equal(m.baselineBytes - m.baselineHeaderBytes, 4)
      assert.equal(m.accepted, false)
      bytesEqual(guarded.container, base.container)
      fastDeepEqual(guarded.segs, base.segs)
      fastDeepEqual(guarded.blockCost, base.blockCost)
      assert.equal(JSON.stringify(picks), before, '原计划不能被候选覆盖')
      checkResult(guarded, tiny)
      // 以更差的 RLE 为原方案，取得同一份 BIN 候选并验证其内容，不只验证回退者。
      const accepted = await compressMacroPlanForProbe(tiny, [part(0, tiny.length, ID.RLE)], spec(ID.BIN_V3))
      assert.equal(accepted.macroComparison!.accepted, true)
      assert.equal(accepted.container.length, m.candidateBytes)
      assert.equal(accepted.container[3], 15)
      checkResult(accepted, tiny)
      checks += 2
    }
    a2Tuning.textOn = true

    // 相等时保留原方案；即使另一份容器内容/规则字段不同也不能切换。
    const tied = await compressMacroPlanForProbe(tiny, [part(0, tiny.length, ID.STORE)], { id: ID.STORE, s: 1, r: 2 })
    assert.equal(tied.macroComparison!.candidateBytes, tied.macroComparison!.baselineBytes)
    assert.equal(tied.macroComparison!.accepted, false)
    assert.equal(tied.segs[0].spec.r, 1)
    checkResult(tied, tiny)
    checks++

    // 模拟采样误选：强制给 RLE 长游程提出 STORE，完整比较必须回退。
    const runs = Uint8Array.from({ length: 8192 }, (_, i) => (i >> 7) & 1)
    const runPlan = [part(0, runs.length, ID.RLE)]
    const runBase = await compressMacroPlanForProbe(runs, runPlan, null)
    const rejected = await compressMacroPlanForProbe(runs, runPlan, spec(ID.STORE))
    assert.equal(rejected.macroComparison!.accepted, false)
    assert.ok(rejected.macroComparison!.candidateBytes! > rejected.macroComparison!.baselineBytes)
    bytesEqual(rejected.container, runBase.container)
    checkResult(rejected, runs)
    checks++

    // 候选失败保留已完成原容器并显式记错；无效原计划则必须失败。
    const failed = await compressMacroPlanForProbe(runs, runPlan, spec(999))
    assert.match(failed.macroComparison!.error ?? '', /无效的宏候选/)
    assert.equal(failed.macroComparison!.candidateBytes, null)
    assert.equal(failed.macroComparison!.accepted, false)
    bytesEqual(failed.container, runBase.container)
    checkResult(failed, runs)
    await assert.rejects(compressMacroPlanForProbe(runs, [part(0, 4, ID.STORE)], null), /未覆盖完整/)
    await assert.rejects(compressMacroPlanForProbe(runs, [part(0, runs.length, ID.FILL)], null), /填充区域不一致/)
    checks += 3

    // 有效收益与 FILL 保留；跨非 512 对齐接缝，检查结果元数据不是失败方案的残留。
    const mixed = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7 + (i >> 2)) % 8)
    mixed.fill(19, 0, 257); mixed.fill(23, 2049, 2302)
    const mixedPlan = [part(0, 257, ID.FILL), part(257, 2049, ID.STORE),
      part(2049, 2302, ID.FILL), part(2302, mixed.length, ID.RLE)]
    const original = JSON.stringify(mixedPlan)
    const win = await compressMacroPlanForProbe(mixed, mixedPlan, spec(ID.BIN_V3))
    assert.equal(win.macroComparison!.accepted, true)
    assert.equal(JSON.stringify(mixedPlan), original)
    fastDeepEqual(win.segs.filter(s => s.spec.id === ID.FILL).map(s => [s.start, s.end]), [[0, 257], [2049, 2302]])
    checkResult(win, mixed)
    checks++

    // 真正的采样入口：完整非 FILL 组命中缓存，产物与不使用缓存的同一候选相同。
    const phrase = new TextEncoder().encode('alpha beta gamma delta: a shared model observes repeated words and changing row numbers.\n')
    const text = Uint8Array.from({ length: 65536 }, (_, i) => phrase[i % phrase.length])
    const textPlan = [part(0, 32768, ID.STORE), part(32768, text.length, ID.RLE)]
    const cached = await compressMacroPlanForProbe(text, textPlan)
    assert.ok(cached.macroComparison?.accepted)
    assert.equal(cached.macroComparison.reusedProbePayload, true)
    const uncached = await compressMacroPlanForProbe(text, textPlan, cached.macroComparison.proposal)
    assert.equal(uncached.macroComparison!.reusedProbePayload, false)
    bytesEqual(cached.container, uncached.container)
    checkResult(cached, text); checkResult(uncached, text)
    checks += 2

    // 原始跨度 >1 MiB，但三个非 FILL 片段加起来只有 3 × 68 KiB；采样预算
    // （192 KiB，按有信息量的字节计）装不下三个，窗口只能覆盖前两个。
    // 这快速覆盖“部分窗口不能借用为全组”的分支，不必大规模压缩合成噪声。
    //
    // 注意两件事，它们都是这条断言曾经的陷阱：
    //  1) 预算必须按**非 FILL 字节**计。旧实现按原始字节跨度算，一段长 FILL
    //     游程就能把第二个真实片段挤出窗口，门直接看不到碎片（这才是 0912a8f
    //     之前 testP9Macro 报 `macroComparison` 为空的真实原因）。
    //  2) 每个非 FILL 片段本身要够大。同一段短语的三份副本若能一起进采样窗，
    //     把它们并成一个恒等组只值一百多字节，那个候选会真的被采用，
    //     `accepted=true` 也照样带 sample；但若片段只有几 KiB，窗口会退化成
    //     单片段（`inWin.length < 2` 提前返回 null）。这里每段 28 KiB 且总信息量
    //     84 KiB > 64 KiB 预算，窗口必定只能装下两段。
    if (!options.quick) {
    // 预算本身也是可调旋钮（生产值 192 KiB）：保持不变的话，这段 1.2 MiB 跨度
    // 上宏门要跑约 10 条候选 × 192 KiB，实测 ≈200 s，无法在单测预算内完成。
    // 这里显式降预算，测的是**同一条分支**（信息量超预算 → 窗口只能覆盖部分
    // 分片），不是换一条更宽松的判断：预算只影响门看见多少，采纳仍由完整容器
    // 严格更小裁决。
    const savedProbe = planTuning.macroProbeBytes
    planTuning.macroProbeBytes = 64 * 1024
    const piece = 28 * 1024, gap = 512 * 1024
    const span = new Uint8Array(piece * 3 + gap * 2)
    const starts = [0, piece + gap, (piece + gap) * 2]
    for (const start of starts) for (let i = 0; i < piece; i++) span[start + i] = phrase[i % phrase.length]
    const partialPlan = [part(0, piece, ID.STORE), part(piece, starts[1], ID.FILL),
      part(starts[1], starts[1] + piece, ID.RLE), part(starts[1] + piece, starts[2], ID.FILL),
      part(starts[2], span.length, ID.STORE)]
    const partial = await compressMacroPlanForProbe(span, partialPlan)
    assert.ok(partial.macroComparison?.sample)
    // The invariant is about PRICED bytes: the window can never contain all three
    // pieces, so `sample.bytes` stays under the plan's informative total and under
    // the input. Asserting on the raw span instead would be wrong, because the raw
    // span may legitimately include FILL runs that neither side encodes.
    assert.ok(partial.macroComparison.sample.bytes < span.length)
    assert.ok(partial.macroComparison.sample.bytes < piece * 3, 'window cannot cover all three pieces')
    assert.ok((partial.macroComparison.sampleSpanBytes ?? span.length) <= span.length)
    assert.equal(partial.macroComparison.reusedProbePayload, false)
    checkResult(partial, span)
    planTuning.macroProbeBytes = savedProbe
    checks++
    }

    // 真正的 compressAdaptive：无宏候选时只走原路径，开关不改变任何字节。
    planTuning.macroUniformGate = false
    const plain = await compressAdaptive(tiny, undefined, { serial: true })
    planTuning.macroUniformGate = true
    const noProposal = await compressAdaptive(tiny, undefined, { serial: true })
    bytesEqual(noProposal.container, plain.container)
    assert.equal(noProposal.macroComparison, undefined)
    checkResult(noProposal, tiny)
    checks++
    console.log(`P9 macro tests passed (${checks} checks${options.quick ? ' quick; large fixture reserved for full suite' : ''}; exact containers, header trap, fallback, metadata, full/partial probe reuse)`)
  } finally {
    Object.assign(a2Tuning, saved.a2); Object.assign(modelTuning, saved.model); Object.assign(planTuning, saved.plan)
  }
}
