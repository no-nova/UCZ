// 交叉版本验证：从真正的 P7 Git 对象编译参考编解码器，不切分支、不改线上源码。
// 用法：node scripts/diag/probe-p9-compat.mjs [输出路径]
// 验证“同进程 round-trip”遗漏的旧容器兼容问题；无 Silesia 语料依赖。
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { atomicJson, sourceFingerprint, sha256, gitHead } from './p9-checkpoint.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const prefix = 'universal-adaptive-compression-system'
const ref = 'cb99b15ed095bdec31985844e90333c68f6c348e'
const output = resolve(root, process.argv[2] ?? 'scripts/diag/p9-results/checks/compat-before.json')
const scratch = await mkdtemp(join(tmpdir(), 'p9-cross-version-'))
const source = await sourceFingerprint(root)
try {
  const archive = execFileSync('git', ['archive', ref, '--', `${prefix}/src/lib`], {
    cwd: resolve(root, '..'), timeout: 30000, maxBuffer: 8 * 1024 * 1024,
  })
  execFileSync('tar', ['-x', '-C', scratch], { input: archive, timeout: 30000 })
  async function load(base, label) {
    const file = join(scratch, `${label}.mjs`)
    await build({ stdin: { contents: `export * from './src/lib/codec.ts'; export * from './src/lib/coder.ts'`,
      resolveDir: base }, bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'silent' })
    return import(pathToFileURL(file).href)
  }
  const old = await load(join(scratch, prefix), 'p7')
  const current = await load(root, 'current')
  const defaults = { a2: { ...current.a2Tuning }, model: { ...current.modelTuning } }
  const raw = Uint8Array.from({ length: 6000 }, (_, i) => (i * 37 + (i >> 3)) & 255)
  const put = (out, v) => { do { const b = v & 127; v = Math.floor(v / 128); out.push(b | (v ? 128 : 0)) } while (v) }
  function container(id, payload, flags = 0) {
    const h = flags ? [0x55, 0x43, 0x5a, 17, flags] : [0x55, 0x43, 0x5a, 15]
    for (const v of [raw.length, 1, 1, id, 1, 0x8001, payload.length, raw.length]) put(h, v)
    return Uint8Array.from([...h, ...payload])
  }
  const encode = (module, id) => container(id, module.encodeTerrainGroup([raw], { id, s: 1, r: 1 }, undefined, undefined, undefined, [0], 'v15'), module.encodingModelFlags?.() ?? 0)
  function check(module, packed) {
    try {
      const back = module.decompress(packed)
      return { verified: Buffer.from(back).equals(Buffer.from(raw)), outputBytes: back.length,
        firstMismatch: back.findIndex((b, i) => b !== raw[i]) }
    } catch (e) { return { verified: false, error: String(e) } }
  }
  const cases = []
  for (const [profile, id] of [['text', old.ID.TEXT_V3], ['bin', old.ID.BIN_V3]]) {
    const original = encode(old, id)
    const referenceVerified = check(old, original)
    if (!referenceVerified.verified) throw new Error('P7 reference fixture does not round-trip')
    const variants = []
    for (const textOn of [true, false]) {
      current.a2Tuning.textOn = textOn
      const packed = encode(current, id)
      variants.push({ textOn, version: packed[3], modelFlags: packed[3] === 19 ? packed[4] | (packed[5] << 8) : packed[3] >= 17 ? packed[4] : null, encodedBytes: packed.length, sameAsP7: Buffer.from(packed).equals(Buffer.from(original)),
        currentReadsP7: check(current, original), p7ReadsCurrent: check(old, packed),
        sameSettingsRoundTrip: check(current, packed) })
    }
    cases.push({ profile, id, p7Bytes: original.length, p7ContainerSha256: sha256(original),
      p7ContainerBase64: Buffer.from(original).toString('base64'), referenceVerified, variants })
  }
  current.a2Tuning.textOn = defaults.a2.textOn
  const record = { kind: 'cross-version-diagnostic', commit: gitHead(root), source,
    probeSha256: sha256(await readFile(fileURLToPath(import.meta.url))), reference: ref,
    createdAt: new Date().toISOString(), defaults,
    input: { bytes: raw.length, sha256: sha256(raw), formula: '(i * 37 + (i >> 3)) & 255' }, cases }
  if ((await sourceFingerprint(root)).sha256 !== source.sha256) throw new Error('Source changed during diagnostic')
  await atomicJson(output, record)
  for (const c of cases) for (const v of c.variants) console.log(JSON.stringify({ profile: c.profile, textOn: v.textOn,
    p7Bytes: c.p7Bytes, currentBytes: v.encodedBytes, version: v.version, identical: v.sameAsP7,
    currentReadsP7: v.currentReadsP7.verified, p7ReadsCurrent: v.p7ReadsCurrent.verified,
    selfRoundTrip: v.sameSettingsRoundTrip.verified }))
  console.log(`Evidence saved: ${output}`)
} finally { await rm(scratch, { recursive: true, force: true }) }
