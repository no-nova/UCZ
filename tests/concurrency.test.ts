import assert from 'node:assert/strict'
import { compressAdaptive, decompress } from '../src/lib/codec'
import { fastDeepEqual } from './fast-equal'

function mk(seed: number, n: number): Uint8Array {
  const o = new Uint8Array(n)
  let x = seed >>> 0
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    o[i] = 0x41 + (x & 7)
  }
  return o
}

/** The v24 checksum trailer must never imply the strict zero-prior model.
 *
 *  `version === 24` used to mean "checksum" on the encode side and "strict" on the
 *  decode side, so `{ checksum: true }` without `strictZeroPrior` produced containers
 *  that decoded with the wrong model — caught only by the CRC (or silently wrong in
 *  older formats). v25 now carries "default priors + checksum".
 */
export async function testChecksumWithoutStrictRoundtrip(): Promise<void> {
  const prose = new TextEncoder().encode('the quick brown fox jumps over the lazy dog\n'.repeat(1200))
  for (const [name, buf] of [['prose', prose], ['structured-bin', mk(7, 65536)]] as const) {
    const r = await compressAdaptive(buf, undefined, { checksum: true })
    assert.notEqual(r.container[3], 24, `${name}: default priors must not use the strict v24 tag`)
    // v25 = default + checksum, v27 = default + checksum + fresh distance buckets;
    // either is legal, both must carry the CRC trailer and roundtrip.
    assert.ok(r.container[3] === 25 || r.container[3] === 27, `${name}: checksummed default containers are v25/v27, got v${r.container[3]}`)
    fastDeepEqual(decompress(r.container), buf, `${name}: checksummed roundtrip`)
    const strict = await compressAdaptive(buf, undefined, { checksum: true, strictZeroPrior: true })
    assert.equal(strict.container[3], 24, `${name}: strict + checksum stays v24`)
    fastDeepEqual(decompress(strict.container), buf, `${name}: v24 roundtrip`)
  }
}

/** Overlapping calls must not observe each other's level/strict/checksum state. */
export async function testConcurrentEncodeIsolation(): Promise<void> {
  const a = mk(1, 120_000)
  const b = mk(2, 260_000)
  const [ra, rb] = await Promise.all([
    compressAdaptive(a, undefined, { level: 'fast', strictZeroPrior: true }),
    compressAdaptive(b, undefined, { level: 'max' }),
  ])
  assert.equal(ra.container[3], 23, 'strict call must be v23')
  assert.notEqual(rb.container[3], 23, 'non-strict call must not inherit the strict tag')
  fastDeepEqual(decompress(ra.container), a, 'concurrent strict roundtrip')
  fastDeepEqual(decompress(rb.container), b, 'concurrent default roundtrip')
  const again = await compressAdaptive(a, undefined, { level: 'fast', strictZeroPrior: true })
  fastDeepEqual(again.container, ra.container, 'result must not depend on queue order')
}

/** Consecutive encodes of different sizes must not read a stale SharedArrayBuffer. */
export async function testSequentialSizeChangeRoundtrip(): Promise<void> {
  const a = mk(11, 600_000)
  const b = mk(12, 700_000)
  const ra = await compressAdaptive(a)
  const rb = await compressAdaptive(b)
  fastDeepEqual(decompress(ra.container), a, '600 KiB roundtrip')
  fastDeepEqual(decompress(rb.container), b, '700 KiB roundtrip after a different-sized job')
  const repeat = await compressAdaptive(a)
  fastDeepEqual(repeat.container, ra.container, 'repeat encode is byte-identical')
}

export async function testConcurrencyAndChecksum(): Promise<void> {
  await testChecksumWithoutStrictRoundtrip()
  await testConcurrentEncodeIsolation()
  await testSequentialSizeChangeRoundtrip()
  console.log('[concurrency] checksum/strict decoupling, overlap isolation and buffer reuse ok')
}
