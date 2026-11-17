/**
 * P32.0: edge-case and adversarial-input hardening.
 *
 * The contract under test is simple: every VALID input round-trips byte-exactly
 * at every planner level, and every INVALID container is rejected with a
 * descriptive `Error` instead of hanging or allocating gigabytes.
 */
import assert from 'node:assert/strict'
import { compressAdaptive, decompress, encodeGroupCandidateForProbe, encodeTerrainGroup, ID, planHeader } from '../src/lib/codec'
import { inspectContainer, inspectStream, isContainer } from '../src/lib/inspect'
import { computeNCD } from '../src/lib/ncd'
import { fastDeepEqual } from './fast-equal'

const LEVELS = ['fast', 'balanced', 'max'] as const

function xorshift(seed: number): () => number {
  let s = seed >>> 0
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s }
}

function rand(n: number, seed: number): Uint8Array {
  const r = xorshift(seed), out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = r() & 0xff
  return out
}

/** 必须抛出**可读**错误，并且不能长时间挂住。 */
function mustThrow(fn: () => unknown, label: string, pattern?: RegExp): void {
  const t = performance.now()
  let threw = false
  try { fn() } catch (err) {
    threw = true
    const msg = String((err as Error)?.message ?? err)
    assert.ok(msg.length > 0, `${label}: 错误信息不能为空`)
    if (pattern) assert.ok(pattern.test(msg), `${label}: 错误信息不匹配 ${pattern}，实际为 ${msg}`)
  }
  const ms = performance.now() - t
  assert.ok(threw, `${label}: 应当抛出错误`)
  assert.ok(ms < 5000, `${label}: 拒绝耗时 ${ms.toFixed(0)} ms 过长`)
}

export async function testEdgeTinyInputs(): Promise<void> {
  for (const n of [0, 1, 2, 3, 7, 15, 31, 63]) {
    const raw = rand(n, 0x1000 + n)
    for (const level of LEVELS) {
      const enc = await compressAdaptive(raw, undefined, { level })
      const back = decompress(enc.container)
      fastDeepEqual(back, raw, `${n} B @ ${level} 往返失败`)
      assert.ok(isContainer(enc.container), `${n} B @ ${level} 应产出合法容器`)
      const anatomy = inspectContainer(enc.container)
      assert.equal(anatomy.totalRawBytes, n)
      assert.equal(anatomy.totalCompressedBytes, enc.container.length)
    }
    const info = await inspectStream(raw, { compress: false })
    assert.equal(info.fingerprint.byteLength, n)
  }
  console.log('[edge] tiny inputs 0..63 B ok on fast/balanced/max')
}

export async function testEdgeConstantAndNoise(): Promise<void> {
  for (const fill of [0x00, 0xaa]) {
    const raw = new Uint8Array(65536).fill(fill)
    for (const level of LEVELS) {
      const enc = await compressAdaptive(raw, undefined, { level })
      fastDeepEqual(decompress(enc.container), raw, `64 KiB 常量 0x${fill.toString(16)} @ ${level} 往返失败`)
      assert.ok(enc.container.length < 4096, `64 KiB 常量应极度压缩，实际 ${enc.container.length} B`)
    }
  }
  const noise = rand(65536, 0xbeef)
  for (const level of LEVELS) {
    const enc = await compressAdaptive(noise, undefined, { level })
    fastDeepEqual(decompress(enc.container), noise, `64 KiB 随机 @ ${level} 往返失败`)
    assert.ok(enc.container.length <= 65632, `随机流开销 ${enc.container.length} B 超过 0.15% 上限`)
  }
  console.log('[edge] 64 KiB constant (0x00/0xAA) and xorshift noise ok')
}

export async function testEdgeCorruptedContainers(): Promise<void> {
  const raw = new TextEncoder().encode('edge case payload, not very long but long enough to have groups\n'.repeat(40))
  const good = (await compressAdaptive(raw, undefined, { level: 'fast' })).container

  mustThrow(() => decompress(new Uint8Array(0)), '0 B 容器', /UCZ|截断|空/)
  mustThrow(() => decompress(new Uint8Array([0x55, 0x43, 0x5a])), '3 B 截断容器')
  mustThrow(() => decompress(new Uint8Array([1, 2, 3, 4, 5])), 'magic 不匹配', /UCZ|magic|格式/)
  mustThrow(() => decompress(Uint8Array.of(0x55, 0x43, 0x5a, 99)), '版本越界')
  mustThrow(() => inspectContainer(new Uint8Array([1, 2, 3, 4])), '非法容器解剖', /UCZ|容器/)

  // 声称 0x7fffffff 字节的伪造长度：必须立刻拒绝，不能按长度分配。
  const huge = Uint8Array.from([0x55, 0x43, 0x5a, 20, 0x00, 0x30, 0xff, 0xff, 0xff, 0xff, 0x07])
  mustThrow(() => decompress(huge), '伪造 0x7fffffff 长度')

  // 头部合法但载荷被截断：同样要抛错，不能越界读。
  const cut = good.subarray(0, Math.max(6, good.length >> 1))
  mustThrow(() => decompress(cut), '载荷被截断')

  fastDeepEqual(decompress(good), raw, '完好容器必须仍然可解')
  console.log('[edge] corrupted/truncated containers rejected cleanly')
}

export async function testEdgeScientificApis(): Promise<void> {
  const empty = new Uint8Array(0)
  const info = await inspectStream(empty, { compress: false })
  assert.equal(info.fingerprint.byteLength, 0)
  assert.equal(info.fingerprint.inferredManifoldClass, 'empty')

  const enc = await compressAdaptive(empty, undefined, { level: 'fast' })
  fastDeepEqual(decompress(enc.container), empty, '0 B 往返失败')

  const ncd = await computeNCD(empty, new TextEncoder().encode('hello'), { mode: 'cm' })
  assert.ok(Number.isFinite(ncd.ncd) && ncd.ncd >= 0, `0 B 的 NCD 必须是有限非负数，得到 ${ncd.ncd}`)
  console.log('[edge] scientific APIs survive 0 B input')
}


/** v24: the optional CRC-32C trailer must roundtrip, must be version-tagged, and must
 *  reject an equal-length payload corruption that earlier formats cannot see. */
export async function testEdgeChecksumTrailer(): Promise<void> {
  const data = new Uint8Array(4096)
  for (let i = 0; i < data.length; i++) data[i] = (i * 37 + (i >> 2)) & 0xff
  const plain = await compressAdaptive(data, undefined, { level: 'fast' })
  const sealed = await compressAdaptive(data, undefined, { level: 'fast', checksum: true })
  assert.equal(sealed.container[3], 25, 'checksummed containers with default priors are v25')
  const sealedStrict = await compressAdaptive(data, undefined, { level: 'fast', checksum: true, strictZeroPrior: true })
  assert.equal(sealedStrict.container[3], 24, 'checksummed containers with strict priors are v24')
  fastDeepEqual(decompress(sealedStrict.container), data)
  assert.ok(sealed.container.length >= plain.container.length + 4)
  fastDeepEqual(decompress(sealed.container), data)
  // Container-level structure is untouched by the trailer flag.
  const empty = await compressAdaptive(new Uint8Array(0), undefined, { level: 'fast', checksum: true })
  assert.equal(decompress(empty.container).length, 0)

  const corrupt = sealed.container.slice()
  corrupt[corrupt.length - 8] ^= 0x01
  assert.throws(() => decompress(corrupt), /CRC-32C|截断|校验|长度/)

  // Same-length tamper of a payload-only change is detected; the *old* formats
  // stay decodable and simply carry no checksum (documented limitation).
  const legacy = await compressAdaptive(data, undefined, { level: 'fast' })
  assert.ok(legacy.container[3] < 24)
  const tamperedLegacy = legacy.container.slice()
  tamperedLegacy[tamperedLegacy.length - 1] ^= 0x01
  let legacyCaught = false
  try { decompress(tamperedLegacy) } catch { legacyCaught = true }
  assert.equal(legacyCaught, false, 'legacy containers have no content checksum')

  // Budget knobs: max-output is enforced inside the codec, and a tiny time budget
  // must still produce a valid container (flagged as truncated, not as optimal).
  let over = false
  try { await compressAdaptive(data, undefined, { level: 'fast', maxOutputBytes: 16 }) } catch { over = true }
  assert.equal(over, true, 'maxOutputBytes must reject an oversized container')
  const rushed = await compressAdaptive(data, undefined, { level: 'max', timeBudgetMs: 1 })
  fastDeepEqual(decompress(rushed.container), data)
  await Promise.resolve()
}


/** Decoder budget + pre-allocation validation: a tiny malformed container must be
 *  rejected before anything is allocated, and `maxOutput` must bound the decode. */
export async function testEdgeDecodeBudgets(): Promise<void> {
  const varint = (v: number): number[] => {
    const o: number[] = []
    while (v >= 0x80) { o.push((v & 0x7f) | 0x80); v >>>= 7 }
    o.push(v)
    return o
  }
  const ok = (await compressAdaptive(new TextEncoder().encode('budget check\n'.repeat(64)), undefined, { level: 'fast' })).container
  mustThrow(() => decompress(ok, undefined, 1), '解压上限必须生效', /超过上限/)
  fastDeepEqual(decompress(ok, undefined, ok.length * 8 + 4096), decompress(ok))

  // v1 header claiming 64 MiB with a zero-length STORE payload: the descriptor
  // table is validated first, so this throws in well under a millisecond.
  const bogus = Uint8Array.from([0x55, 0x43, 0x5a, 1, ...varint(67108864), ...varint(1), 0, ...varint(67108864), ...varint(0)])
  const t = performance.now()
  mustThrow(() => decompress(bogus), '畸形容器必须被拒绝', /corrupt v1 store payload|长度/)
  const ms = performance.now() - t
  assert.ok(ms < 50, `pre-allocation validation took ${ms.toFixed(1)} ms (expected < 50 ms)`)

  // A header promising more records than the body can hold is rejected up front.
  const tooMany = Uint8Array.from([0x55, 0x43, 0x5a, 1, ...varint(1024), ...varint(1000), 0, 1, 1])
  mustThrow(() => decompress(tooMany), '记录数越界必须被拒绝', /截断|长度/)
}

export async function testEdgeCases(): Promise<void> {
  await testEdgeTinyInputs()
  await testEdgeConstantAndNoise()
  await testEdgeCorruptedContainers()
  await testEdgeScientificApis()
  await testEdgeBcjV3ShortRoundtrip()
  await testEdgeWordPreBodyLenDos()
  await testEdgeInspectContainerBounds()
  await testEdgeChecksumTrailer()
  await testEdgeDecodeBudgets()
}

/**
 * P36.2 / F1：`< 32 KiB` 的 x86 类流在升级到 `s = 2` 之前会出现 `BCJ_V3 s=1`，
 * 而 v20 内核的编码器（`encodeGroupV15`）过去不带 `{ bcj: true }`，解码器却带上，
 * 于是 14 个上下文对 25 个上下文、逐字节发散。
 */
function x86Like(n: number, seed: number): Uint8Array {
  const r = xorshift(seed), out = new Uint8Array(n)
  const ops = [0x48, 0x8b, 0x89, 0x0f, 0x85, 0x55, 0x53, 0x57, 0x31, 0xc0, 0xc3, 0x4c, 0x8d, 0xff, 0x90]
  let i = 0
  while (i < n) {
    const op = ops[r() % ops.length]
    out[i++] = op
    if ((op === 0xe8 || op === 0xe9) && i + 4 <= n) {
      // 真实的 32 位相对位移，指向流内某个"函数"起点，这样 BCJ 才会改写它。
      const target = (r() % Math.max(1, n - 8)) + 4
      const rel = (target - (i + 4)) | 0
      out[i++] = rel & 0xff; out[i++] = (rel >>> 8) & 0xff
      out[i++] = (rel >>> 16) & 0xff; out[i++] = (rel >>> 24) & 0xff
      continue
    }
    const operands = 1 + (r() % 4)
    for (let k = 0; k < operands && i < n; k++) out[i++] = (r() >>> 13) & 0xff
    if (i + 5 <= n && r() % 7 === 0) {
      const target = (r() % Math.max(1, n - 8)) + 4
      const rel = (target - (i + 5)) | 0
      out[i++] = 0xe8; out[i++] = rel & 0xff; out[i++] = (rel >>> 8) & 0xff
      out[i++] = (rel >>> 16) & 0xff; out[i++] = (rel >>> 24) & 0xff
    }
  }
  return out
}

function concatBytes(a: ArrayLike<number>, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a as ArrayLike<number> as number[], 0); out.set(b, a.length)
  return out
}

export async function testEdgeBcjV3ShortRoundtrip(): Promise<void> {
  // 1) 定向验证：直接按 `BCJ_V3 s=1` 编码三种内核，容器必须逐字节还原。
  for (const [n, seed] of [[28000, 195], [31999, 139], [12000, 298]] as const) {
    const data = x86Like(n, seed)
    const spec = { id: ID.BCJ_V3, s: 1, r: 1 }
    for (const kernel of ['v15', 'v20'] as const) {
      // 候选编码路径（refineGroupCodecs / `encodeGroupV15`）与地形编码路径必须
      // 产出完全相同的比特流；修复前 v20 内核下 25,266 B vs 25,381 B。
      const cand = encodeGroupCandidateForProbe([data], spec, [0], kernel)
      const terr = encodeTerrainGroup([data], spec, undefined, undefined, undefined, [0], kernel)
      assert.ok(cand && cand.length === terr.length, `BCJ_V3 s=1 n=${n} kernel=${kernel} 候选/地形长度不一致 ${cand?.length} vs ${terr.length}`)
      fastDeepEqual(cand!, terr, `BCJ_V3 s=1 n=${n} kernel=${kernel} 候选/地形比特流不一致`)
    }
    for (const kernel of ['v13', 'v15', 'v20'] as const) {
      const payload = encodeTerrainGroup([data], spec, undefined, undefined, undefined, [0], kernel)
      const header = planHeader(data.length, [{ start: 0, end: data.length, cls: 'binary', spec }],
        [{ spec, members: [0], payload, v15: kernel !== 'v13', wordPre: false }])
      const container = concatBytes(header, payload)
      fastDeepEqual(decompress(container), data, `BCJ_V3 s=1 n=${n} seed=${seed} kernel=${kernel} 往返失败`)
    }
    // 2) 端到端：规划器在这三种流上选出的容器也必须可逆（三种档位）。
    for (const level of LEVELS) {
      const enc = await compressAdaptive(data, undefined, { level })
      fastDeepEqual(decompress(enc.container), data, `x86-like n=${n} seed=${seed} @ ${level} 往返失败`)
    }
  }
}

/**
 * P36.2 / D1：19 字节的 `wordPre` 头 + `bodyLen = 512 MiB` 曾让算术解码器空转
 * 12 分钟。现在必须被"该分组原始长度的上界"立刻拒绝。
 */
export async function testEdgeWordPreBodyLenDos(): Promise<void> {
  const data = new TextEncoder().encode('word pre body length bound\n')
  const spec = { id: ID.TEXT_V3, s: 1, r: 1 }
  const huge = new Uint8Array(8)
  new DataView(huge.buffer).setUint32(0, 512 * 1024 * 1024, true)
  // `v15: false` 会让该规则走别的容器布局（ver 13）而被更早的字典校验拦下，
  // 所以这里用 v15 组，确保真正走到 `decodeTerrainGroupWordPre` 的长度校验。
  const header = planHeader(data.length, [{ start: 0, end: data.length, cls: 'text', spec }],
    [{ spec, members: [0], payload: huge, v15: true, wordPre: true }])
  const container = concatBytes(header, huge)
  assert.ok(container.length < 64, `PoC 容器应很小，实际 ${container.length} B`)
  const t = performance.now()
  mustThrow(() => decompress(container, undefined, 1024), 'wordPre bodyLen DoS', /词元流长度|上限/)
  const ms = performance.now() - t
  assert.ok(ms < 50, `DoS 拒绝应在 50 ms 内完成，实际 ${ms.toFixed(1)} ms`)
}

/**
 * P36.2 / D4–D8：`inspectContainer` 必须和 `decompress` 用同一套边界。
 */
export async function testEdgeInspectContainerBounds(): Promise<void> {
  // 合法的 v1 容器：两个扁平段（STORE + FILL）。
  const v1 = Uint8Array.from([
    0x55, 0x43, 0x5a, 1, 6, 2, // magic, ver=1, n=6, cnt=2
    ID.STORE, 2, 2, 0x41, 0x42, // STORE rawLen=2 pl=2
    ID.FILL, 4, 1, 0x5a, // FILL rawLen=4 pl=1
  ])
  const anatomy = inspectContainer(v1)
  assert.equal(anatomy.segments.length, 2, 'v1 解剖应看到 2 段')
  assert.equal(anatomy.totalRawBytes, 6, 'v1 总长度')
  fastDeepEqual(decompress(v1), Uint8Array.from([0x41, 0x42, 0x5a, 0x5a, 0x5a, 0x5a]), 'v1 容器应可解')

  // D8: v1 FILL 的空载荷不能再被当成"全 0"。
  const emptyFill = Uint8Array.from([0x55, 0x43, 0x5a, 1, 4, 1, ID.FILL, 4, 0])
  mustThrow(() => decompress(emptyFill), 'v1 FILL 空载荷', /FILL/)

  // D4: 版本上界与 `decompress` 对齐（25：v23 严格、v24 严格+CRC、v25 默认+CRC）。
  const good = (await compressAdaptive(new TextEncoder().encode('bounds check payload\n'.repeat(30)), undefined, { level: 'fast' })).container
  const v26 = Uint8Array.from(good); v26[3] = 99
  // `isContainer` 与 `inspectContainer` 共用 1..25 的上界，26 在门禁处被拒。
  mustThrow(() => inspectContainer(v26), 'inspect 拒绝未知版本', /Not a UCZ container|version|版本/)

  // D7: 未知识别符。
  const badId = Uint8Array.from(good)
  // 组表紧跟 (magic, version, flags[ver>=19], n, cnt, groups) 之后；直接定位第一个组 id。
  let p = 4 + (badId[3] >= 19 ? 2 : badId[3] >= 17 ? 1 : 0)
  const skipVar = () => { while (badId[p++] & 0x80) { /* continue */ } }
  skipVar(); skipVar(); skipVar()
  badId[p] = 200
  mustThrow(() => inspectContainer(badId), 'inspect 拒绝未知 transform id', /Unknown transform/)

  // D7: 段长之和与声明总长不符。
  const mismatched = Uint8Array.from(v1); mismatched[4] = 7
  mustThrow(() => inspectContainer(mismatched), 'inspect 拒绝长度不符', /sum|长度/)

  // D7: 载荷越界（header 声称的 pl 超出容器剩余字节）。
  const overrun = Uint8Array.from([0x55, 0x43, 0x5a, 1, 2, 1, ID.STORE, 2, 99, 0x41])
  mustThrow(() => inspectContainer(overrun), 'inspect 拒绝载荷越界', /payload|exceed/)
}
