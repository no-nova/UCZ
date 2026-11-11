// P3-1 / P4-3 交叉验证：双流（encodeCMDual）与主路径的等价性。
//
// 判据：
//   * 每条被 dualProfile 覆盖的规则：`encodeGroupDual(...).alt` 必须与
//     `encodeTerrainGroup(..., 'v15')` **逐字节相同**（否则择优会写进解码器
//     解不开的载荷）。
//   * `alt` 还必须与单跑 `encodeCM(..., 'v15')` 相同（不是"看起来差不多"）。
//   * `both.base` 与单跑 v13 的关系只需报告：P4-1 的 mht8 只在 v15 模型里生效，
//     一旦 8 字节长距匹配命中就会改变 msh 演化，base 流不再是纯 v13 流——
//     这正是 v13 载荷必须由真实那次 v13 编码提供的原因。
//   * v2 家族（TEXT_V2 / BIN_V2 / BCJ_V2 / GRAD_V2）能否纳入双流，同样逐字节判定。
//
// 用法：node scripts/diag/run.mjs probe-dualmap [语料文件...]
import { readFile } from 'node:fs/promises'
import { encodeTerrainGroup, ID, encodeGroupDualForProbe, type Spec } from '../../src/lib/codec'
import { encodeCMDual, type Profile } from '../../src/lib/coder'
import * as T from '../../src/lib/transforms'

const files = process.argv.slice(2)
const corpusRoot = process.env.P9_CORPUS ?? '.diag-data/corpus'
const corpora = files.length ? files : [`${corpusRoot}/dickens`, `${corpusRoot}/xml`]
const SLICE = 40000

/** 与 codec.ts 的 joinForSpec 相同：逐分片正向变换后首尾相接。 */
function join(ps: Uint8Array[], id: number, s: number, r: number, positions: number[]): Uint8Array {
  const n = ps.reduce((a, p) => a + p.length, 0)
  const out = new Uint8Array(n)
  let pos = 0
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]
    let t = p
    if (id === ID.WIDE_GRAD && s === 1) t = T.d16Fwd(p, 1, 1)
    else if (id === ID.BCJ || id === ID.BCJ_V2 || id === ID.BCJ_V3) t = T.bcjFwd(p, positions[i])
    if (id === ID.DELTA || id === ID.DELTA_V3) t = T.deltaFwd(p, s)
    else if (id === ID.GRAD || id === ID.GRAD_V2 || id === ID.GRAD_V3 || (id === ID.WIDE_GRAD && s !== 1)) t = T.medFwd(p, s, r)
    else if (id === ID.D16) t = T.d16Fwd(p, s, r)
    out.set(t, pos); pos += p.length
  }
  return out
}

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b))

/** dualProfile 覆盖的规则 → (profile, s, r)。 */
const covered: Array<[string, Spec, Profile, number, number]> = [
  ['wide_grad s=1', { id: ID.WIDE_GRAD, s: 1, r: 2048 }, 'res', 2, 1],
  ['wide_grad s=2', { id: ID.WIDE_GRAD, s: 2, r: 2048 }, 'res2d', 2, 2048],
  ['text_v3', { id: ID.TEXT_V3, s: 1, r: 1 }, 'text', 1, 1],
  ['bin_v3', { id: ID.BIN_V3, s: 1, r: 1 }, 'bin', 1, 1],
  ['bcj_v3', { id: ID.BCJ_V3, s: 1, r: 1 }, 'bin', 1, 1],
  ['delta_v3', { id: ID.DELTA_V3, s: 4, r: 1 }, 'res', 4, 1],
  ['grad_v3', { id: ID.GRAD_V3, s: 4, r: 64 }, 'res2d', 4, 64],
]

/** 未纳入双流的规则 → 若纳入会用的 (profile, s, r, geomStride)。 */
const v2Candidates: Array<[string, Spec, Profile, number, number, number]> = [
  ['text_v2', { id: ID.TEXT_V2, s: 1, r: 1 }, 'text', 1, 1, 0],
  ['bin_v2', { id: ID.BIN_V2, s: 1, r: 1 }, 'bin', 1, 1, 0],
  ['bcj_v2', { id: ID.BCJ_V2, s: 1, r: 1 }, 'bin', 1, 1, 0],
  ['grad_v2', { id: ID.GRAD_V2, s: 4, r: 64 }, 'res2d', 4, 64, 64],
]

/** 旧规则（完全不在 V15_PROFILES / 双流范围内），仅作对照。 */
const legacy: Array<[string, Spec]> = [
  ['text', { id: ID.TEXT, s: 1, r: 1 }],
  ['bcj', { id: ID.BCJ, s: 1, r: 1 }],
  ['delta', { id: ID.DELTA, s: 4, r: 1 }],
  ['grad', { id: ID.GRAD, s: 4, r: 64 }],
  ['d16', { id: ID.D16, s: 2, r: 64 }],
]

let failures = 0, tested = 0
for (const file of corpora) {
  let raw: Uint8Array
  try { raw = await readFile(file) } catch { console.error(`FAIL 读不到必测语料：${file}`); failures++; continue }
  if (!raw.length) { console.error(`FAIL 语料为空：${file}`); failures++; continue }
  tested++
  const data = raw.subarray(0, Math.min(SLICE, raw.length))
  // 多分片：双流只覆盖"拼接后统一编码"的路径，单分片走 encodeSpec，语义不同。
  const parts = [data.subarray(0, Math.floor(data.length * 0.4)), data.subarray(Math.floor(data.length * 0.4))]
  const positions = [0, Math.floor(data.length * 0.4)]
  const single = [data]
  console.log(`\n=== ${file.split('/').pop()} (${data.length} B, 2 分片) ===`)

  console.log('-- 双流覆盖规则 --')
  for (const [name, spec, prof, s, r] of covered) {
    const serial13 = encodeTerrainGroup(parts, spec)
    const serial15 = encodeTerrainGroup(parts, spec, undefined, undefined, undefined, positions, 'v15')
    const alt = encodeGroupDualForProbe(parts, spec, positions)
    if (!alt) { console.log(`  ${name.padEnd(14)} 不在双流覆盖范围`); failures++; continue }
    const okAlt = eq(alt, serial15)
    // base 只需要报告：mht8 命中后它与纯 v13 必然分叉。
    const joined = join(parts, spec.id, spec.s, spec.r, positions)
    const both = encodeCMDual(joined, prof, s, r, 'v15', 0)
    const baseSame = eq(both.base, serial13)
    console.log(`  ${name.padEnd(14)} alt=${okAlt ? 'OK' : 'MISMATCH'} base==v13:${baseSame ? 'YES' : 'no(mht8)'}  v13=${serial13.length} v15=${serial15.length} dual=${alt.length}`)
    if (!okAlt) failures++
  }

  console.log('-- v2 家族是否可纳入双流 --')
  for (const [name, spec, prof, s, r, geom] of v2Candidates) {
    const serial15 = encodeTerrainGroup(parts, spec, undefined, undefined, undefined, positions, 'v15')
    const joined = join(parts, spec.id, spec.s, spec.r, positions)
    const both = encodeCMDual(joined, prof, s, r, 'v15', geom)
    const okMulti = eq(both.alt, serial15)
    // 单分片：主路径走 encodeSpec（v2 拓扑，见 encodeTerrainGroup 顶部特例），
    // 双流算的是 v15 拓扑，二者不同构 → 绝不能覆盖。
    const s15single = encodeTerrainGroup(single, spec, undefined, undefined, undefined, [0], 'v15')
    const dualSingle = encodeCMDual(join(single, spec.id, spec.s, spec.r, [0]), prof, s, r, 'v15', geom).alt
    const okSingle = eq(dualSingle, s15single)
    console.log(`  ${name.padEnd(14)} 多分片等价=${okMulti ? 'OK' : 'MISMATCH'}  单分片等价=${okSingle ? 'OK' : 'MISMATCH(encodeSpec 走 v2 拓扑)'}  v15=${serial15.length}`)
    if (!okMulti || !okSingle) console.log(`  ${''.padEnd(14)} → 不纳入双流：单/多分片不同构，且两者都只需一遍编码，无提速收益`)
  }

  console.log('-- 旧规则（不在 V15_PROFILES）--')
  for (const [name, spec] of legacy) {
    const alt = encodeGroupDualForProbe(parts, spec, positions)
    console.log(`  ${name.padEnd(14)} ${alt ? '意外覆盖' : '不覆盖（v15 走单跑回退）'}`)
  }
}

// 探针本身的退出码：任何 alt 不等价都视为失败（等价性是容器可解的必要条件）。
if (!tested) failures++
console.log(failures ? `\n失败 ${failures} 项` : '\n双流等价性全部通过')
process.exitCode = failures ? 1 : 0
