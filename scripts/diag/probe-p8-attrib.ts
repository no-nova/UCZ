// P8-环节五 探针：内部交叉熵归因分析器（Internal Cross-Entropy Attribution Profiler）。
//
// 在 v13/v15 编码器上挂 `setAttribHook`（只读，不改比特流），对每个字节统计：
//   桶1  长匹配命中      mlen >= 4
//   桶2  高阶干净命中    无匹配，但 4 阶上下文槽 count >= 2
//   桶2b 高阶仅见一次    无匹配，count == 1
//   桶3  高阶未命中/冷   无匹配，count == 0
// 同时用一份 shadow tag 数组实测各上下文哈希表的**真实碰撞率**，
// 并用 `setModelBitsOverride` 把表放大到几乎不碰撞，量出碰撞的字节代价。
//
// 上下文槽位含义（v13 内核）：text → idx[4]=O4、idx[5]=O6；
// bin → idx[4]=O4、idx[5]=hh(b1,b3) 稀疏；res/res2d → 二维邻域。
// 归因以 idx[4] 的计数作为“高阶是否见过”的判据，这一映射在结果里如实标注。
//
// 用法：node scripts/diag/run.mjs probe-p8-attrib [字节数=4194304] [文件...]
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { analyze } from '../../src/lib/analyze'
import { chooseSpecSync, ID, specLabel } from '../../src/lib/codec'
import { encodeCM, setAttribHook, setModelBitsOverride } from '../../src/lib/coder'
import type { AttribModelView, Profile } from '../../src/lib/coder'

const argN = Number(process.argv[2] ?? 4 * 1024 * 1024)
const files = process.argv.slice(3).length ? process.argv.slice(3)
  : ['mozilla', 'webster', 'dickens', 'samba', 'osdb', 'ooffice', 'mr', 'sao']
await mkdir('/tmp/p8-attrib', { recursive: true })

// 规则 → (profile, s, r)：与 encodeTerrainGroupImpl 的映射一致。
function toProfile(id: number, s: number, r: number): { profile: Profile; s: number; r: number } {
  switch (id) {
    case ID.TEXT_V3: case ID.TEXT: return { profile: 'text', s: 1, r: 1 }
    case ID.BIN_V3: case ID.BIN: return { profile: 'bin', s: 1, r: 1 }
    case ID.O0: return { profile: 'o0', s: 1, r: 1 }
    case ID.DELTA_V3: return { profile: 'res', s, r: 1 }
    case ID.GRAD_V3: return { profile: 'res2d', s, r }
    default: return { profile: 'bin', s: 1, r: 1 }
  }
}

const out: unknown[] = []
for (const f of files) {
  const raw = await readFile('/tmp/corpus/' + f)
  const data = argN > 0 ? raw.subarray(0, Math.min(argN, raw.length)) : raw
  const n = data.length

  // 用线上同一条试探链决定这份切片的主力规则，再按它的 profile 归因。
  const an = analyze(data)
  const big = an.segs.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start))[0]
  const { spec } = chooseSpecSync(data.subarray(big.start, big.end), big.cls, big.bestS, 40000, big.start)
  const tp = toProfile(spec.id, spec.s, spec.r)

  const bitsUsed = Math.min(21, Math.max(10, Math.ceil(Math.log2(Math.max(n, 1) * 8)) + 1))
  const slots = 1 << bitsUsed
  // shadow tag：每上下文一份，记录该槽位最后一次是谁的上下文
  let tags: Uint32Array[] | null = null
  const perCtx: { collide: number; seen: number }[] = []
  let ctxSeen = 0, ctxCollide = 0, nctx = 0
  const bMatch = { bytes: 0, bits: 0 }, bHit = { bytes: 0, bits: 0 }, bOnce = { bytes: 0, bits: 0 }, bCold = { bytes: 0, bits: 0 }
  let totalBits = 0

  setAttribHook((m: AttribModelView, _pos: number, bits: number) => {
    if (!tags) {
      nctx = m.nctx
      tags = Array.from({ length: nctx }, () => new Uint32Array(1 << (32 - m.shift)))
      for (let i = 0; i < nctx; i++) perCtx.push({ collide: 0, seen: 0 })
    }
    totalBits += bits
    const cnt4 = m.nctx > 4 ? (m.tables[4][m.idx[4]] & 255) : 0
    if (m.mlen >= 4) { bMatch.bytes++; bMatch.bits += bits }
    else if (cnt4 >= 2) { bHit.bytes++; bHit.bits += bits }
    else if (cnt4 === 1) { bOnce.bytes++; bOnce.bits += bits }
    else { bCold.bytes++; bCold.bits += bits }
    for (let i = 0; i < m.nctx; i++) {
      const slot = m.idx[i]
      const want = m.hashes[i] >>> 0
      const have = tags[i][slot]
      const nonEmpty = (m.tables[i][slot] & 255) > 0
      if (nonEmpty) {
        ctxSeen++; perCtx[i].seen++
        if (have !== want) { ctxCollide++; perCtx[i].collide++ }
      }
      if (have !== want) tags[i][slot] = want
    }
  })
  // 必须传 costOut：encodeCMImpl 只在 costOut/blockCost 存在时才累加每字节比特数。
  const costBuf = new Float32Array(n)
  const t0 = Date.now()
  const payload = encodeCM(data, tp.profile, tp.s, tp.r, costBuf, 0, undefined, undefined, 'v13')
  const ms = Date.now() - t0
  setAttribHook(null)
  tags = null

  // 消除碰撞：把哈希表放大（内存允许时）。P8_BITS 可覆盖档位，默认 22,23。
  const bigger: Record<string, number> = {}
  const bitsList = (process.env.P8_BITS ?? '22,23').split(',').map(Number).filter(x => x >= 10 && x <= 26)
  for (const b of bitsList) {
    if ((1 << b) * nctx * 4 > Number(process.env.P8_TAG_BUDGET ?? 1.6 * 1024 * 1024 * 1024)) continue
    setModelBitsOverride(b)
    bigger[`bits${b}`] = encodeCM(data, tp.profile, tp.s, tp.r, undefined, 0, undefined, undefined, 'v13').length
    setModelBitsOverride(0)
  }
  setModelBitsOverride(0)

  const pack = (x: { bytes: number; bits: number }) => ({
    bytes: x.bytes, bytesPct: +(x.bytes / n * 100).toFixed(2),
    bitsPct: +(x.bits / totalBits * 100).toFixed(2),
    bitsPerByte: +(x.bits / Math.max(1, x.bytes)).toFixed(3),
  })
  const rec = {
    file: f, n, rule: specLabel(spec), profile: tp.profile, slots, nctx, ms,
    payloadBytes: payload.length, bitsPerByte: +(totalBits / n).toFixed(4),
    buckets: { match4: pack(bMatch), order4Hit: pack(bHit), order4Once: pack(bOnce), order4Cold: pack(bCold) },
    collision: {
      ctxSeen, ctxCollide, collidePct: +(ctxSeen ? ctxCollide / ctxSeen * 100 : 0).toFixed(3),
      perCtxPct: perCtx.map(c => +(c.collide / Math.max(1, c.seen) * 100).toFixed(2)),
    },
    baseBytes: payload.length, bigger,
    saveByBigger: Object.fromEntries(Object.entries(bigger).map(([k, v]) =>
      [k, { bytes: v, delta: payload.length - v, pct: +((payload.length - v) / payload.length * 100).toFixed(2) }])),
  }
  out.push(rec)
  await writeFile(`/tmp/p8-attrib/${f}.json`, JSON.stringify(rec))
  console.log(JSON.stringify({ file: f, n, rule: rec.rule, bitsPerByte: rec.bitsPerByte, buckets: rec.buckets, collidePct: rec.collision.collidePct, saveByBigger: rec.saveByBigger, ms }))
}
console.log(JSON.stringify({ kind: 'done', files: out.map(o => (o as any).file) }))
