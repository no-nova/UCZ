/**
 * P32.0: edge-case and adversarial-input hardening.
 *
 * The contract under test is simple: every VALID input round-trips byte-exactly
 * at every planner level, and every INVALID container is rejected with a
 * descriptive `Error` instead of hanging or allocating gigabytes.
 */
import assert from 'node:assert/strict'
import { compressAdaptive, decompress } from '../src/lib/codec'
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

export async function testEdgeCases(): Promise<void> {
  await testEdgeTinyInputs()
  await testEdgeConstantAndNoise()
  await testEdgeCorruptedContainers()
  await testEdgeScientificApis()
}
