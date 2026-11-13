import assert from 'node:assert/strict'
import { fastDeepEqual } from './fast-equal'
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import fixtures from './p7-v15-fixtures.json'
import wordPreFixtures from './legacy-wordpre-fixtures.json'
import { payloadModelFlags } from '../src/lib/payload-model'
import { compressAdaptive, decompress, encodeTerrainGroup, ID, planTuning, workerTuningMatchesDefaults, parallelReport, type Spec } from '../src/lib/codec'
import { a2Tuning, modelTuning, cmV20Tuning, encodingModelFlags, cmTableBits, setModelBitsOverride, setAttribHook, attribHook } from '../src/lib/coder'
import { encodeGroupForJob } from '../src/lib/codec-jobs'
import { PARALLEL_WORKER_CODE } from '../src/lib/parallel-worker-code'

function setFlags(flags: number) {
  modelTuning.maxTableBits = flags & 1 ? 22 : 21
  a2Tuning.textOn = !(flags & 2)
  modelTuning.matchTableBits = flags & 4 ? 21 : 20
  a2Tuning.resOn = !(flags & 8)
  a2Tuning.wordPreTextOff = !!(flags & 16)
  modelTuning.largeOnly = !!(flags & 32)
}
function wrap(raw: Uint8Array, spec: Spec, payload: Uint8Array, version: number, flags = 0, v15 = true) {
  const h = [85, 67, 90, version]
  if (version === 17) h.push(flags)
  const put = (v: number) => { do { const b = v & 127; v = Math.floor(v / 128); h.push(b | (v ? 128 : 0)) } while (v) }
  for (const v of [raw.length, 1, 1, spec.id, spec.s, spec.r | (v15 ? 0x8000 : 0), payload.length, raw.length]) put(v)
  return Uint8Array.from([...h, ...payload])
}
const eq = (a: Uint8Array, b: Uint8Array) => fastDeepEqual(Buffer.from(a), Buffer.from(b))

export async function testP9Format() {
  const keepA2 = { ...a2Tuning }, keepModel = { ...modelTuning }
  const raw = Uint8Array.from({ length: fixtures.input.bytes }, (_, i) => (i * 37 + (i >> 3)) & 255)
  const text = { id: ID.TEXT_V3, s: 1, r: 1 }
  const bin = { id: ID.BIN_V3, s: 1, r: 1 }
  const res = { id: ID.DELTA_V3, s: 2, r: 1 }
  const specs = [text, bin, res]
  let checks = 0
  try {
    // 真正由 P7 源码产生的冻结样本；“新代码 encode 然后 decode”不能替代这一项。
    for (const fixture of fixtures.cases) {
      const packed = Buffer.from(fixture.p7ContainerBase64, 'base64')
      assert.equal(createHash('sha256').update(packed).digest('hex'), fixture.p7ContainerSha256)
      setFlags(15) // 所有编码设置都与旧容器相反，旧解码仍必须按 P7。
      eq(decompress(packed), raw)
      setFlags(0)
      const sp = { id: fixture.id, s: 1, r: 1 }
      eq(wrap(raw, sp, encodeTerrainGroup([raw], sp, undefined, undefined, undefined, [0], 'v15'), 15), packed)
      checks++
    }
    // Frozen BEFORE this change: both legacy WORD-PRE/a2-on and original v17
    // global textOff must still decode, not just newly generated self-roundtrips.
    for (const fixture of wordPreFixtures.fixtures) {
      const packed = Buffer.from(fixture.base64, 'base64')
      assert.equal(createHash('sha256').update(packed).digest('hex'), fixture.sha256)
      setFlags(63)
      eq(decompress(packed), new TextEncoder().encode(wordPreFixtures.text))
      checks++
    }
    // 16 组配置 × 三类 profile：解码时把运行时设置反转，证明只读文件标志。
    for (let flags = 0; flags < 16; flags++) for (const spec of specs) {
      setFlags(flags)
      const v18Policy = (flags & 1 ? 2 : 0) | (flags & 2 ? 1 : 0)
        | (flags & 4 ? 8 : 0) | (flags & 8 ? 32 : 0) | 128
      assert.equal(encodingModelFlags(), v18Policy | (cmV20Tuning.enabled?0x1000:0) | (cmV20Tuning.binRecovery?0x2000:0))
      const payload = encodeTerrainGroup([raw], spec, undefined, undefined, undefined, [0], 'v15')
      const packed = wrap(raw, spec, payload, 17, flags)
      setFlags(flags ^ 15)
      const settings = JSON.stringify({ a2Tuning, modelTuning })
      eq(decompress(packed), raw)
      assert.equal(JSON.stringify({ a2Tuning, modelTuning }), settings)
      checks++
    }
    // 足够大的输入才真正触及 21/22 位、20/21 位匹配表差异。
    const large = new Uint8Array(262145)
    let seed = 0x12345678
    for (let i = 0; i < large.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; large[i] = seed & 255 }
    let basePayload: Uint8Array | null = null
    for (const flags of [0, 1, 4, 5]) {
      setFlags(flags)
      const payload = encodeTerrainGroup([large], bin, undefined, undefined, undefined, [0], 'v15')
      if (flags === 0) basePayload = payload
      if (flags === 1) assert.notDeepEqual(payload, basePayload, '大输入必须真正覆盖不同表宽')
      const packed = wrap(large, bin, payload, 17, flags)
      setFlags(flags ^ 15)
      eq(decompress(packed), large)
      checks++
    }
    // New size-scoped policy: two streams IN THE SAME CONTAINER, straddling
    // the threshold. A small stream must not inherit the large stream's tables.
    setFlags(53) // 22 / mht8=21 / WORD-PRE-off / size-scoped; raw text remains on.
    assert.equal(cmTableBits(512 * 1024 - 1), 21)
    assert.equal(cmTableBits(512 * 1024), 22)
    const big = new Uint8Array(512 * 1024)
    for (let i = 0; i < big.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; big[i] = seed & 255 }
    const smallSpec = { id: ID.BIN, s: 1, r: 1 }
    const smallPayload = encodeTerrainGroup([large], smallSpec, undefined, undefined, undefined, [0], 'v15')
    const keepHook = attribHook
    let dimensions: number[] = []
    setAttribHook((m, i) => {
      if (i === 0) {
        const v = m as typeof m & { mht: Int32Array; mht8: Int32Array }
        dimensions = [m.tables[0].length, v.mht.length, v.mht8.length]
        setAttribHook(keepHook)
      }
    })
    let bigPayload: Uint8Array
    try { bigPayload = encodeTerrainGroup([big], bin, undefined, undefined, undefined, [large.length], 'v15') }
    finally { setAttribHook(keepHook) }
    fastDeepEqual(dimensions, [2 ** 22, 2 ** 20, 2 ** 21], 'P10/P11.1 keep mht4 at 20 bits')
    assert.equal(payloadModelFlags(smallPayload), 0)
    assert.equal(payloadModelFlags(bigPayload), 10) // v18 table22 | mht8=21; mht4 remains20
    const h = [85, 67, 90, 18, 10]
    const put = (v: number) => { do { const b = v & 127; v = Math.floor(v / 128); h.push(b | (v ? 128 : 0)) } while (v) }
    for (const v of [large.length + big.length, 2, 2]) put(v)
    for (const [id, payload] of [[smallSpec.id, smallPayload], [bin.id, bigPayload]] as const)
      for (const v of [id, 1, 0x8001, payload.length]) put(v)
    put(large.length); put(big.length); h.push(1) // first segment belongs to first group
    const both = new Uint8Array(large.length + big.length); both.set(large); both.set(big, large.length)
    const mixed = new Uint8Array(h.length + smallPayload.length + bigPayload.length)
    mixed.set(h); mixed.set(smallPayload, h.length); mixed.set(bigPayload, h.length + smallPayload.length)
    setFlags(2) // deliberately different runtime settings
    eq(decompress(mixed), both)
    checks++

    // 不占 r=8192 的旧位。v14 和 v17 都要能保存这个行宽。
    for (const version of [14, 17]) {
      setFlags(version === 14 ? 0 : 3)
      const sp = { id: ID.WIDE_GRAD, s: 2, r: 8192 }
      const payload = encodeTerrainGroup([raw], sp, undefined, undefined, undefined, [0], version === 17 ? 'v15' : false)
      const packed = wrap(raw, sp, payload, version, version === 17 ? 3 : 0, version === 17)
      setFlags(12)
      eq(decompress(packed), raw)
      checks++
    }
    // v16 只保留旧试验的固定默认组合（22 / 20 / textOff / resOn）。
    setFlags(3)
    const v16 = wrap(raw, text, encodeTerrainGroup([raw], text, undefined, undefined, undefined, [0], 'v15'), 16)
    setFlags(12)
    eq(decompress(v16), raw)
    checks++

    setFlags(3)
    const payload = encodeTerrainGroup([raw], text, undefined, undefined, undefined, [0], 'v15')
    const packed = wrap(raw, text, payload, 17, 3)
    // 异常恢复、未知位、截断、输出上限；P8 的 raw-model 实验也不能污染旧容器。
    for (const flags of [64, 128, 192, 255]) {
      const bad = packed.slice(); bad[4] = flags
      assert.throws(() => decompress(bad), /v17 模型配置/)
    }
    assert.throws(() => decompress(Uint8Array.of(85, 67, 90, 17)), /截断/)
    assert.throws(() => decompress(packed, undefined, raw.length - 1), /超过上限/)
    setFlags(1)
    assert.equal(cmTableBits(262145), 22)
    const malformed = wrap(raw, text, payload, 17, 0).subarray(0, 8)
    assert.throws(() => decompress(malformed))
    assert.equal(cmTableBits(262145), 22, '失败解码必须恢复模型域')
    const old = Buffer.from(fixtures.cases[0].p7ContainerBase64, 'base64')
    setModelBitsOverride(10)
    try { eq(decompress(old), raw) } finally { setModelBitsOverride(0) }
    let nested = false
    eq(decompress(packed, () => { if (!nested) { nested = true; eq(decompress(old), raw) } }), raw)
    assert.ok(nested)
    checks += 8

    // 真入口必须把配置序列化；未知配置必须在模型分配前报错。
    setFlags(3)
    const adaptive = await compressAdaptive(raw, undefined, { serial: true })
    assert.equal(adaptive.container[3] === 18 ? adaptive.container[4] & 6 : 0, 0, 'unused 22-bit policy must not be emitted')
    setFlags(12)
    eq(decompress(adaptive.container), raw)
    modelTuning.maxTableBits = 25
    await assert.rejects(compressAdaptive(raw), /不支持的容器模型配置/)
    checks += 2

    // worker 未接收动态旋钮时必须明确退回串行，不能写“22 位头 / 21 位载荷”。
    Object.assign(a2Tuning, keepA2); Object.assign(modelTuning, keepModel)
    assert.ok(workerTuningMatchesDefaults())
    const keepDrop = planTuning.dropZeroHitIds
    planTuning.dropZeroHitIds = !keepDrop
    try { assert.equal(workerTuningMatchesDefaults(), false) } finally { planTuning.dropZeroHitIds = keepDrop }
    modelTuning.maxTableBits = 21
    assert.equal(workerTuningMatchesDefaults(), false)
    const automatic = await compressAdaptive(raw)
    const serial = await compressAdaptive(raw, undefined, { serial: true })
    eq(automatic.container, serial.container)
    assert.match(parallelReport.reason ?? '', /诊断旋钮/)
    checks++

    // 真正执行嵌入式 worker，不能只测两个主线程函数。
    Object.assign(a2Tuning, keepA2); Object.assign(modelTuning, keepModel)
    const sab = new SharedArrayBuffer(raw.length); new Uint8Array(sab).set(raw)
    const worker = new Worker(PARALLEL_WORKER_CODE, { eval: true, workerData: { sab } })
    try {
      const ends = [raw.length]
      const result = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker test timeout')), 10000)
        worker.once('error', e => { clearTimeout(timer); reject(e) })
        worker.once('message', r => { clearTimeout(timer); r.error ? reject(new Error(r.error)) : resolve(r) })
        worker.postMessage({ kind: 'encodeGroup', parts: [[0, raw.length]], spec: text, positions: [0], ends })
      })
      fastDeepEqual(result, encodeGroupForJob([raw], text, [0], ends))
      checks++
    } finally { await worker.terminate() }
    console.log(`P9 format tests passed (${checks} checks; frozen P7, v17 flags, scope, worker)`)
  } finally {
    Object.assign(a2Tuning, keepA2); Object.assign(modelTuning, keepModel)
  }
}
