// P8-环节二 探针：分块/合并机制审计 + 32 个 Codec ID 的命中率普查。
//
// 只读探针：不改线上默认路径。唯一依赖的线上改动是 analyze.ts 里新增的
// `analyzeTuning`（默认值 = 原行为），用来把“3 点多数滤波 + 短游程吸收”关掉做 A/B。
//
// 用法：
//   node scripts/diag/run.mjs probe-p8-seg [切片字节数] [文件...]
//   node scripts/diag/run.mjs probe-p8-seg 0            # 0 = 整份文件
// 输出：stdout 两行 JSON（rows / summary），stderr 打进度。
import { readFile } from 'node:fs/promises'
import { analyze, analyzeTuning, BLOCK } from '../../src/lib/analyze'
import { candidatesFor, chooseSpecSync, ID, sampleWindow } from '../../src/lib/codec'

const argN = Number(process.argv[2] ?? 4 * 1024 * 1024)
const files = process.argv.slice(3).length ? process.argv.slice(3)
  : ['xml', 'dickens', 'ooffice', 'mr', 'osdb', 'x-ray', 'sao', 'reymont', 'nci', 'samba', 'webster', 'mozilla']

// 恒等规则：对字节流不做任何空间重排/预测，直接裸进 CM（BCJ 会改写 E8/E9 的 rel32，不算恒等）。
const IDENTITY = new Set<number>([ID.STORE, ID.FILL, ID.RLE, ID.O0, ID.TEXT, ID.BIN, ID.TEXT_V2, ID.BIN_V2, ID.TEXT_V3, ID.BIN_V3])
const ID_NAME: Record<number, string> = {}
for (const [k, v] of Object.entries(ID)) ID_NAME[v] = k

const sumPool = new Map<string, number>()
const sumWin = new Map<string, number>()
const sumBytes = new Map<string, number>()
const rows: unknown[] = []
let totalN = 0

for (const f of files) {
  const raw = await readFile('/tmp/corpus/' + f)
  const data = argN > 0 ? raw.subarray(0, Math.min(argN, raw.length)) : raw
  const t0 = Date.now()
  const n = data.length
  totalN += n

  // ---- 1) 平滑 A/B：同一段数据，跑“未平滑”和“线上平滑”两遍 ----
  analyzeTuning.majorityFilter = false
  analyzeTuning.minRunBlocks = 0
  const anRaw = analyze(data)
  analyzeTuning.majorityFilter = true
  analyzeTuning.minRunBlocks = 2
  const an = analyze(data)

  const labRaw = anRaw.blocks.map(b => b.cls)
  const labSm = an.blocks.map(b => b.cls)
  let changed = 0
  for (let i = 0; i < labRaw.length; i++) if (labRaw[i] !== labSm[i]) changed++
  const runs = (a: string[]) => { let r = 1; for (let i = 1; i < a.length; i++) if (a[i] !== a[i - 1]) r++; return r }

  const segs = an.segs
  const lens = segs.map(s => s.end - s.start).sort((a, b) => a - b)
  const terrain: Record<string, number> = {}
  const terrainRaw: Record<string, number> = {}
  for (const s of segs) terrain[s.cls] = (terrain[s.cls] ?? 0) + (s.end - s.start)
  for (const s of anRaw.segs) terrainRaw[s.cls] = (terrainRaw[s.cls] ?? 0) + (s.end - s.start)

  // ---- 2) 候选池普查 + 线上试探链的胜出者 ----
  const sampleLimit = n > 5 * 1024 * 1024
    ? Math.min(16000, Math.max(4096, Math.floor(8 * 1024 * 1024 / Math.max(1, segs.length))))
    : 40000
  const pool = new Map<string, number>()
  const win = new Map<string, number>()
  const bytes = new Map<string, number>()
  const poolByCls: Record<string, { segs: number; cands: number }> = {}
  let candTotal = 0, identityBytes = 0
  for (const s of segs) {
    const seg = data.subarray(s.start, s.end)
    const center = sampleWindow(seg, sampleLimit, s.bestS)
    const cands = candidatesFor(seg, s.cls, s.bestS, center.sample)
    candTotal += cands.length
    const pc = poolByCls[s.cls] ?? { segs: 0, cands: 0 }
    pc.segs++; pc.cands += cands.length; poolByCls[s.cls] = pc
    for (const sp of cands) {
      const k = ID_NAME[sp.id]
      pool.set(k, (pool.get(k) ?? 0) + 1)
      sumPool.set(k, (sumPool.get(k) ?? 0) + 1)
    }
    // chooseSpecSync = 线上同一条试探链（40KB 三窗口采样 + 大区域 512KB 复核）
    const { spec } = chooseSpecSync(seg, s.cls, s.bestS, sampleLimit, s.start)
    const k = ID_NAME[spec.id]
    win.set(k, (win.get(k) ?? 0) + 1); sumWin.set(k, (sumWin.get(k) ?? 0) + 1)
    bytes.set(k, (bytes.get(k) ?? 0) + (s.end - s.start)); sumBytes.set(k, (sumBytes.get(k) ?? 0) + (s.end - s.start))
    if (IDENTITY.has(spec.id)) identityBytes += s.end - s.start
  }

  rows.push({
    file: f, n, blocks: an.blocks.length,
    segsRaw: anRaw.segs.length, segsSmoothed: segs.length,
    blocksRelabeled: changed, blocksRelabeledPct: +(changed / an.blocks.length * 100).toFixed(2),
    runsRaw: runs(labRaw), runsSmoothed: runs(labSm),
    segMed: lens[Math.floor(lens.length / 2)] ?? 0,
    segP90: lens[Math.floor(lens.length * 0.9)] ?? 0,
    segMax: lens[lens.length - 1] ?? 0,
    segUnder1k: lens.filter(l => l < 1024).length,
    segUnder4k: lens.filter(l => l < 4096).length,
    terrainPct: Object.fromEntries(Object.entries(terrain).map(([k, v]) => [k, +(v / n * 100).toFixed(1)])),
    terrainRawPct: Object.fromEntries(Object.entries(terrainRaw).map(([k, v]) => [k, +(v / n * 100).toFixed(1)])),
    poolByCls, candTotal, candPerSeg: +(candTotal / segs.length).toFixed(1), distinctIds: pool.size,
    chosenBytesPct: Object.fromEntries([...bytes.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / n * 100).toFixed(1)])),
    chosenWinners: Object.fromEntries([...win.entries()].sort((a, b) => b[1] - a[1])),
    identityBytes, identityPct: +(identityBytes / n * 100).toFixed(2),
    pool: Object.fromEntries([...pool.entries()].sort((a, b) => b[1] - a[1])),
    ms: Date.now() - t0,
  })
  console.error(`.. ${f} segs ${anRaw.segs.length}→${segs.length} relabel=${(changed / an.blocks.length * 100).toFixed(1)}% identity=${(identityBytes / n * 100).toFixed(1)}% ${Date.now() - t0}ms`)
}

const allIds = [...new Set([...sumPool.keys(), ...sumWin.keys(), ...sumBytes.keys()])]
const totalWin = [...sumWin.values()].reduce((a, b) => a + b, 0)
console.log(JSON.stringify({ kind: 'rows', blockBytes: BLOCK, rows }))
console.log(JSON.stringify({
  kind: 'summary', totalN, totalWin,
  ids: allIds.map(k => ({
    id: k,
    inPool: sumPool.get(k) ?? 0,
    wins: sumWin.get(k) ?? 0,
    winPct: +((sumWin.get(k) ?? 0) / Math.max(1, totalWin) * 100).toFixed(2),
    bytesPct: +((sumBytes.get(k) ?? 0) / totalN * 100).toFixed(2),
  })).sort((a, b) => b.inPool - a.inPool),
  identityPctPerFile: Object.fromEntries((rows as any[]).map(r => [r.file, r.identityPct])),
}))
