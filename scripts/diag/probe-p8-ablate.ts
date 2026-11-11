// P8-环节五 探针：模型部件消融阶梯（Model Ablation Ladder）。
//
// 正面回答“不靠世界纪录，怎么判断一个文件的压缩潜力还剩多少”：
// 把编码器拆成可开关的部件，在**同一份数据**上逐级加回来，
// 每一级的字节差就是该部件的边际贡献。最后一级之后剩下的残差，
// 就是“当前模型族吃不动的部分”——它不是筛选没做好，而是模型族的天花板。
//
//   rung0 O0            只有零阶
//   rung1 O1            加一阶
//   rung2 v13 9 上下文   加高阶 + 匹配模型 + 线性混合
//   rung3 v15           加 APM(a1) + 细粒度辅混洗(mixer2) + 8 字节长距匹配(mht8) + 断续匹配
//   rung3-mht8          v15 去掉 mht8
//   rung3-mixer2        v15 去掉辅混洗
//   rung3-a2            v15 去掉二级校准
//   rung3-a1            v15 去掉一级校准（APM 权重 0）
//   rung3-gap           v15 去掉断续匹配恢复
//
// 用法：node scripts/diag/run.mjs probe-p8-ablate [字节数=2097152] [文件...]
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { analyze } from '../../src/lib/analyze'
import { chooseSpecSync, ID } from '../../src/lib/codec'
import { encodeCM, setNoMht8, match3Tuning, mixer2Tuning, apmTuning, apm2Tuning, encodeMatchExperiment } from '../../src/lib/coder'
import type { Profile } from '../../src/lib/coder'

const argN = Number(process.argv[2] ?? 2 * 1024 * 1024)
const files = process.argv.slice(3).length ? process.argv.slice(3)
  : ['dickens', 'webster', 'osdb', 'mozilla', 'samba', 'ooffice', 'sao', 'mr', 'xml', 'nci']
await mkdir('/tmp/p8-ablate', { recursive: true })

const snapshot = () => ({
  noMht8: (globalThis as any).__x, m2: mixer2Tuning.on, a1: apmTuning.weight, a2: apm2Tuning.on, gap: match3Tuning.gapResume,
})
void snapshot

const out: unknown[] = []
for (const f of files) {
  const raw = await readFile('/tmp/corpus/' + f)
  const data = argN > 0 ? raw.subarray(0, Math.min(argN, raw.length)) : raw
  const n = data.length
  // 用线上试探链定出主力 profile
  const an = analyze(data)
  const big = an.segs.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start))[0]
  const { spec } = chooseSpecSync(data.subarray(big.start, big.end), big.cls, big.bestS, 40000, big.start)
  const profile: Profile = (spec.id === ID.TEXT_V3 || spec.id === ID.TEXT || spec.id === ID.TEXT_V2) ? 'text'
    : (spec.id === ID.O0) ? 'o0' : 'bin'

  const run = (label: string, fn: () => number) => {
    const t = Date.now()
    const bytes = fn()
    return { label, bytes, bitsPerByte: +(bytes * 8 / n).toFixed(4), ms: Date.now() - t }
  }
  const restore = () => { setNoMht8(false); mixer2Tuning.on = true; apmTuning.weight = 1; apm2Tuning.on = true; match3Tuning.gapResume = true }

  const rungs: unknown[] = []
  restore()
  rungs.push(run('rung0-o0', () => encodeCM(data, 'o0', 1, 1).length))
  rungs.push(run('rung1-o1', () => encodeCM(data, 'o1', 1, 1).length))
  rungs.push(run('rung2-v13', () => encodeCM(data, profile, 1, 1, undefined, 0, undefined, undefined, 'v13').length))
  const v15 = run('rung3-v15', () => encodeCM(data, profile, 1, 1, undefined, 0, undefined, undefined, 'v15').length)
  rungs.push(v15)
  restore(); setNoMht8(true)
  rungs.push(run('v15-no-mht8', () => encodeCM(data, profile, 1, 1, undefined, 0, undefined, undefined, 'v15').length))
  restore(); mixer2Tuning.on = false
  rungs.push(run('v15-no-mixer2', () => encodeCM(data, profile, 1, 1, undefined, 0, undefined, undefined, 'v15').length))
  restore(); apm2Tuning.on = false
  rungs.push(run('v15-no-a2', () => encodeCM(data, profile, 1, 1, undefined, 0, undefined, undefined, 'v15').length))
  restore(); apmTuning.weight = 0
  rungs.push(run('v15-no-a1', () => encodeCM(data, profile, 1, 1, undefined, 0, undefined, undefined, 'v15').length))
  restore(); match3Tuning.gapResume = false
  rungs.push(run('v15-no-gap', () => encodeCM(data, profile, 1, 1, undefined, 0, undefined, undefined, 'v15').length))
  restore()

  // 匹配模型自身的命中率（只读统计）
  let match: unknown = null
  try {
    const st = encodeMatchExperiment(data, profile === 'o0' ? 'bin' : profile, 'single')
    match = {
      payload: st.payload.length, candidatesChecked: st.stats.candidatesChecked, matchesStarted: st.stats.matchesStarted,
      predictedBits: st.stats.predictedBits, correctBits: st.stats.correctBits,
      hitPct: +(st.stats.correctBits / Math.max(1, st.stats.predictedBits) * 100).toFixed(2),
      distanceStarts: st.stats.distanceStarts,
    }
  } catch { match = null }

  const by = Object.fromEntries((rungs as { label: string; bytes: number }[]).map(r => [r.label, r.bytes]))
  const rec = {
    file: f, n, rule: spec.id, profile, rungs, match,
    deltas: {
      o0_to_o1: by['rung0-o0'] - by['rung1-o1'],
      o1_to_v13: by['rung1-o1'] - by['rung2-v13'],
      v13_to_v15: by['rung2-v13'] - by['rung3-v15'],
      mht8: by['v15-no-mht8'] - by['rung3-v15'],
      mixer2: by['v15-no-mixer2'] - by['rung3-v15'],
      a2: by['v15-no-a2'] - by['rung3-v15'],
      a1: by['v15-no-a1'] - by['rung3-v15'],
      gap: by['v15-no-gap'] - by['rung3-v15'],
    },
  }
  out.push(rec)
  await writeFile(`/tmp/p8-ablate/${f}.json`, JSON.stringify(rec))
  console.log(JSON.stringify({ file: f, n, profile, bytes: by, deltas: rec.deltas }))
}
restoreAll()
function restoreAll() { setNoMht8(false); mixer2Tuning.on = true; apmTuning.weight = 1; apm2Tuning.on = true; match3Tuning.gapResume = true }
console.log(JSON.stringify({ kind: 'done', files: out.map(o => (o as any).file) }))
