// P9-3.1 归因探针：TRANSPOSE_GROUP_V3(30) 到底进没进池、赢没赢过。
//
// 为什么需要它：报告 2 §3.4 声称 mozilla 1 MiB 切片上"整片单一 TG_V3(s=4)"比
// 完整流水线小 20,644 B（6.7 %），据此要求把 30 放进候选池。但端到端 A/B
// （probe-p9-ab，mozilla 2 MiB）开 candidateTgV3 后容器字节**一个都没变**。
// 这两个结论不可能同时成立，必须查清是哪一步断了：
//   (a) 候选根本没进池（被某个 gate 拦掉）；
//   (b) 进了池但在**采样**里从没赢过（于是 chooseSpecImpl 永远不选它）；
//   (c) 采样里赢了，但分组/复核阶段又被换掉。
//
// 做法：同一份数据分别在 candidateTgV3=false / true 下跑线上同一条试探链
// （candidatesFor + chooseSpecSync），统计 30 的进池次数、胜出次数、
// 以及"整段真实编码"口径下 30 是否其实更优（即采样是否误杀了它）。
//
// 用法：node scripts/diag/run.mjs probe-p9-tg3 [字节数] [文件...]
import { readFile } from 'node:fs/promises'
import { analyze } from '../../src/lib/analyze'
import { candidatesFor, chooseSpecSync, encodeSpec, ID, sampleWindow, specLabel } from '../../src/lib/codec'
import { planTuning } from '../../src/lib/codec'

const argN = Number(process.argv[2] ?? 1048576)
const files = process.argv.slice(3).length ? process.argv.slice(3) : ['mozilla', 'samba', 'sao', 'osdb']
const TG = ID.TRANSPOSE_GROUP_V3

for (const f of files) {
  const raw = await readFile('/tmp/corpus/' + f)
  const data = argN > 0 ? raw.subarray(0, Math.min(argN, raw.length)) : raw
  const an = analyze(data)
  const sampleLimit = data.length > 5 * 1024 * 1024
    ? Math.min(16000, Math.max(4096, Math.floor(8 * 1024 * 1024 / Math.max(1, an.segs.length))))
    : 40000

  const stat = { inPool: 0, wins: 0, bestStride: new Map<number, number>() }
  let tgWouldWinBytes = 0, tgWouldWinSegs = 0, tgBetterTotal = 0
  const winners: Record<string, number> = {}

  for (const on of [false, true]) {
    planTuning.candidateTgV3 = on
    if (on) { stat.inPool = 0; stat.wins = 0; stat.bestStride.clear() }
    for (const s of an.segs) {
      const seg = data.subarray(s.start, s.end)
      const center = sampleWindow(seg, sampleLimit, s.bestS)
      const cands = candidatesFor(seg, s.cls, s.bestS, center.sample)
      if (on) {
        for (const sp of cands) if (sp.id === TG) {
          stat.inPool++
          stat.bestStride.set(sp.s, (stat.bestStride.get(sp.s) ?? 0) + 1)
        }
      }
      const { spec } = chooseSpecSync(seg, s.cls, s.bestS, sampleLimit, s.start)
      if (on) {
        const k = specLabel(spec)
        winners[k] = (winners[k] ?? 0) + 1
        if (spec.id === TG) stat.wins++
      } else if (spec.id !== TG) {
        // 关掉旋钮时的赢家 vs 整段真实编码下的 TG_V3：判断采样是否误杀
        const base = encodeSpec(seg, spec, undefined, 0, s.start).length
        let bestTg = -1, bestS = 0
        for (const st of [4, 8, s.bestS > 1 ? s.bestS : 0]) {
          if (!st || st < 2 || st > 64) continue
          try {
            const v = encodeSpec(seg, { id: TG, s: st, r: 1 }, undefined, 0, s.start).length
            if (bestTg < 0 || v < bestTg) { bestTg = v; bestS = st }
          } catch { /* 该步长不适用 */ }
        }
        if (bestTg >= 0 && bestTg < base) {
          tgWouldWinSegs++; tgWouldWinBytes += s.end - s.start; tgBetterTotal += base - bestTg
        }
      }
    }
  }
  planTuning.candidateTgV3 = false

  console.log(JSON.stringify({
    file: f, n: data.length, segs: an.segs.length, sampleLimit,
    tgInPool: stat.inPool, tgWins: stat.wins,
    tgStrides: Object.fromEntries(stat.bestStride),
    winnersWithTgEnabled: winners,
    // 关掉旋钮时，整段真实编码口径下 TG_V3 其实更优的段
    tgWouldWinSegs, tgWouldWinBytes, tgBetterTotalBytes: tgBetterTotal,
  }))
}
console.log(JSON.stringify({ kind: 'done', files }))
