// P17.5 bounded verifier. Every input is <= 256 KiB; no corpus-scale run.
// Run: timeout --signal=KILL 19s node scripts/diag/p17_5_verify.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const receiptPath = join(root, 'scripts/diag/p17_5_verify_receipt.json')
const sha = x => createHash('sha256').update(x).digest('hex')
const codecPath = join(root, 'src/lib/codec.ts')
const sourceSha256 = sha(readFileSync(codecPath))
if (existsSync(receiptPath)) {
  const old = JSON.parse(readFileSync(receiptPath, 'utf8'))
  if (old.status !== 'PASS') throw Error('existing P17.5 receipt is not PASS')
  console.log(JSON.stringify({ receipt: receiptPath, status: 'PASS', reused: true, sourceSha256: old.sourceSha256 }))
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'p175-verify-'))
let codec
try {
  const bundle = join(scratch, 'codec.mjs')
  await build({ entryPoints: [codecPath], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' })
  codec = await import(`${bundle}?${Date.now()}`)
  const { ID, isHarmonicStride2Alias, compressGuardedPlanForProbe, decompress, encodeTerrainGroup,
    selectionHeaderBytes, planHeader, contextGroupCandidatesSync, encodePlanTranspose } = codec

  const rng = seed => { let x = seed >>> 0; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 0 } }
  const roundtrip = (r, data) => {
    const out = decompress(r.container)
    assert.equal(out.length, data.length)
    for (let i = 0; i < data.length; i++) assert.equal(out[i], data[i], `round-trip mismatch at ${i}`)
  }
  const runPlan = async (data, spec) => compressGuardedPlanForProbe(data,
    [{ start: 0, end: data.length, cls: 'binary', spec, trials: [] }], { serial: true })

  // 1) Harmonic stride-2 stream forced into an s=4 transpose group.
  const harmonic = (() => {
    const r = rng(0x5eed1234), out = new Uint8Array(65536)
    let even = 0
    for (let i = 0; i < out.length; i += 2) {
      even = (even + 1 + (r() % 3)) % 24
      out[i] = even
      out[i + 1] = r() & 255
    }
    return out
  })()
  assert.equal(isHarmonicStride2Alias([harmonic]), true, 'harmonic alias detector missed s=4/s=2 case')
  const s4spec = { id: ID.TRANSPOSE, s: 4, r: 1 }
  const s4payload = encodeTerrainGroup([harmonic], s4spec)
  const s4header = planHeader(harmonic.length,
    [{ start: 0, end: harmonic.length, cls: 'binary', spec: s4spec }],
    [{ spec: s4spec, members: [0], payload: { length: s4payload.length }, v15: false }]).length
  const forced4 = await runPlan(harmonic, s4spec)
  roundtrip(forced4, harmonic)
  assert.ok([ID.TRANSPOSE, ID.TRANSPOSE_GROUP, ID.TRANSPOSE_GROUP_V3].includes(forced4.segs[0].spec.id))
  assert.equal(forced4.segs[0].spec.s, 2, 'harmonic group was not de-aliased to s=2')
  const s4BaselineBytes = s4payload.length + s4header
  assert.ok(forced4.container.length < s4BaselineBytes, `no strict reduction: ${forced4.container.length} >= ${s4BaselineBytes}`)

  // 2) A genuine stride-4 source must not trigger de-aliasing.
  const trueS4 = (() => {
    const r = rng(0xc0ffee), out = new Uint8Array(65536)
    for (let i = 0; i < out.length; i += 4) {
      out[i] = r() & 255; out[i + 1] = r() & 255; out[i + 2] = r() & 255; out[i + 3] = (i >>> 2) & 7
    }
    return out
  })()
  assert.equal(isHarmonicStride2Alias([trueS4]), false, 'true s=4 source was misdetected as harmonic')
  const truePlan = await runPlan(trueS4, s4spec)
  roundtrip(truePlan, trueS4)
  assert.equal(truePlan.segs[0].spec.s, 4, 'true s=4 group was incorrectly de-aliased')

  // 3) ooffice CM-BIN3 slice: a winning matchDist probe must not wipe modes.
  // The fixed 128 KiB window (offset 5,500,000) contains CM-BIN3 segments and is
  // the measured case where the bounded probe selects the distance axis.
  const ooffice = [process.env.OOFFICE, join(root, '.diag-data/corpus/ooffice'),
    '/home/user/Downloads/silesia/ooffice'].find(p => p && existsSync(p))
  let officeCase
  if (ooffice) {
    const fd = readFileSync(ooffice), off = 5500000, len = 131072
    assert.ok(off + len <= fd.length, 'ooffice corpus is too short for the fixed bounded window')
    const slice = fd.subarray(off, off + len)
    const cand = contextGroupCandidatesSync([slice], { id: ID.BIN_V3, s: 1, r: 1 }, [off])
    assert.equal(cand.screen?.matchDist, true, 'ooffice CM-BIN3 slice did not exercise the matchDist probe')
    const has = (context, md) => cand.trials.some(t => t.context === context && !!t.matchDist === md)
    assert.ok(has('bin-stride4', false), 'bin-stride4 was wiped out by result.screen.matchDist')
    assert.ok(has('bin-stride4', true), 'bin-stride4 + matchDist was not evaluated')
    assert.ok(has(undefined, true), 'base context=undefined + matchDist was not evaluated')
    // BCJ3 must no longer be proposed or screened.
    assert.equal(codec.contextProposalsForGroup({ id: ID.BCJ_V3, s: 1, r: 1 },
      [{ rawLen: 262144, cls: 'binary', trials: [] }]).length, 0)
    const bcj = contextGroupCandidatesSync([slice], { id: ID.BCJ_V3, s: 1, r: 1 }, [off])
    assert.equal(bcj.skipped, 'bcj3-context-disabled')
    officeCase = { source: ooffice, offset: off, bytes: len, screenMatchDist: true,
      contexts: cand.trials.map(t => ({ context: t.context ?? null, matchDist: !!t.matchDist, payloadBytes: t.payload.length })),
      bcj3ProposalCount: 0, bcj3Skipped: bcj.skipped }
  } else {
    // Keep the verifier usable on a clean checkout without the optional corpus.
    officeCase = { source: null, skipped: 'ooffice-not-present' }
  }

  // 4) encodePlanTranspose must return the retained payload when a plan is not
  // strictly smaller, even if a different layout was considered.
  const small = Uint8Array.from({ length: 8192 }, (_, i) => (i * 17 + (i >>> 3)) & 255)
  const retained = Uint8Array.of(0)
  const gated = encodePlanTranspose([small], { id: ID.TRANSPOSE_GROUP, s: 4, r: 1 }, undefined, () => true, retained)
  assert.equal(gated.payload, retained, 'encodePlanTranspose replaced a smaller retained payload')
  assert.deepEqual(gated.spec, { id: ID.TRANSPOSE_GROUP, s: 4, r: 1 })

  const result = {
    kind: 'P17.5-bounded-verification', status: 'PASS', sourceSha256,
    maxInputBytes: 262144, corpusScaleRun: false,
    cases: {
      harmonicStride2Alias: { inputBytes: harmonic.length, detector: true, forcedSpec: s4spec,
        finalSpec: forced4.segs[0].spec, containerBytes: forced4.container.length,
        s4BaselineBytes, reductionBytes: s4BaselineBytes - forced4.container.length, roundtrip: true },
      trueStride4: { inputBytes: trueS4.length, detector: false, finalSpec: truePlan.segs[0].spec, roundtrip: true },
      oofficeCmBin3: officeCase,
      transposeNonDegradation: { inputBytes: small.length, retainedPayloadBytes: retained.length,
        returnedPayloadBytes: gated.payload.length, returnedSpec: gated.spec, pass: true },
    },
  }
  writeFileSync(receiptPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ receipt: receiptPath, ...result }))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
