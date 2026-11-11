// P8-环节五 探针：MAX_SUB_CHUNK / 分组冷启动损失量化。
//
// 回答三个问题：
//   1) 线上主力分组到底是“一次连续 CM”还是“每 8 MiB 清零重来”？
//      —— 用 compressAdaptive 的分组清单 + 逐组复算载荷来验证（不靠读代码猜）。
//   2) 如果真的按 K 块冷启动，每块要白白多付多少字节？
//   3) 模型的“热身曲线”长什么样：连续编码时 bits/byte 随位置怎么收敛？
//      （这条曲线同时决定了采样窗口最小要多长才有判别力。）
//
// 用法：node scripts/diag/run.mjs probe-p8-cold [切片字节数=8388608] [文件...]
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { compressAdaptive, specLabel, ID } from '../../src/lib/codec'
import { encodeCM } from '../../src/lib/coder'
import type { Profile } from '../../src/lib/coder'

const argN = Number(process.argv[2] ?? 8 * 1024 * 1024)
const files = process.argv.slice(3).length ? process.argv.slice(3)
  : ['dickens', 'webster', 'nci', 'samba', 'osdb', 'mozilla']
await mkdir('/tmp/p8-cold', { recursive: true })
const MAX_SUB_CHUNK = 8 * 1024 * 1024

function toProfile(id: number): { profile: Profile; kernel: 'v13' | 'v15' } | null {
  switch (id) {
    case ID.TEXT_V3: case ID.TEXT: return { profile: 'text', kernel: 'v13' }
    case ID.BIN_V3: case ID.BIN: case ID.BIN_V2: return { profile: 'bin', kernel: 'v13' }
    case ID.TEXT_V2: return { profile: 'text', kernel: 'v13' }
    case ID.O0: return { profile: 'o0', kernel: 'v13' }
    default: return null
  }
}

const out: unknown[] = []
for (const f of files) {
  const raw = await readFile('/tmp/corpus/' + f)
  const data = argN > 0 ? raw.subarray(0, Math.min(argN, raw.length)) : raw
  const n = data.length
  const t0 = Date.now()
  const comp = await compressAdaptive(data, undefined, { serial: true })

  // ---- 1) 分组清单：线上到底建了几个 CM 实例 ----
  const groups = new Map<string, { label: string; n: number; raw: number; comp: number }>()
  for (const s of comp.segs) {
    const e = groups.get(s.label) ?? { label: s.label, n: 0, raw: 0, comp: 0 }
    e.n++; e.raw += s.rawLen; e.comp += s.compLen
    groups.set(s.label, e)
  }
  const inventory = [...groups.values()].sort((a, b) => b.raw - a.raw).map(g => ({
    label: g.label, segs: g.n, rawBytes: g.raw, payloadBytes: g.comp,
    overSubChunk: g.raw > MAX_SUB_CHUNK,
  }))

  // ---- 2) 主力分组：连续 vs K 块冷启动 ----
  const main = inventory[0]
  const mainParts = comp.segs.filter(s => s.label === main.label)
  let joinedLen = 0
  for (const p of mainParts) joinedLen += p.rawLen
  const joined = new Uint8Array(joinedLen)
  { let w = 0; for (const p of mainParts) { joined.set(data.subarray(p.start, p.end), w); w += p.rawLen } }
  const tp = toProfile(mainParts[0].spec.id)
  const cold: Record<string, unknown> = { rule: main.label, rawBytes: joinedLen }
  let warmCurve: { at: number; bitsPerByte: number }[] = []
  if (tp) {
    // 连续一次（线上做法）
    const cost = new Float32Array(joinedLen)
    const contig = encodeCM(joined, tp.profile, 1, 1, cost, 0, undefined, undefined, tp.kernel)
    cold.contiguousBytes = contig.length
    // 热身曲线：每 256 KiB 一桶
    const bucket = 256 * 1024
    for (let p = 0; p < joinedLen; p += bucket) {
      const end = Math.min(joinedLen, p + bucket)
      let bits = 0
      for (let i = p; i < end; i++) bits += cost[i]
      warmCurve.push({ at: p, bitsPerByte: +(bits / (end - p)).toFixed(4) })
    }
    // K 块各自冷启动
    for (const K of [2, 4, 8]) {
      const size = Math.ceil(joinedLen / K)
      if (size < 64 * 1024) continue
      let total = 0, chunks = 0
      for (let p = 0; p < joinedLen; p += size) {
        total += encodeCM(joined.subarray(p, Math.min(joinedLen, p + size)), tp.profile, 1, 1, undefined, 0, undefined, undefined, tp.kernel).length
        chunks++
      }
      cold[`K${chunks}`] = { bytes: total, delta: total - contig.length, perReset: +((total - contig.length) / Math.max(1, chunks - 1)).toFixed(1), chunkBytes: size }
    }
  }

  const rec = {
    file: f, n, ucz: comp.container.length, header: comp.overhead,
    analyzeSegs: comp.segs.length, groups: inventory.length,
    inventory, mainColdStart: cold, warmCurve,
    ms: Date.now() - t0,
  }
  out.push(rec)
  await writeFile(`/tmp/p8-cold/${f}.json`, JSON.stringify(rec))
  console.log(JSON.stringify({ file: f, n, groups: inventory.length, main: main.label, mainRaw: main.rawBytes,
    contiguous: (cold as any).contiguousBytes ?? null, K2: (cold as any).K2?.delta ?? null, K4: (cold as any).K4?.delta ?? null, K8: (cold as any).K8?.delta ?? null,
    warm0: warmCurve[0]?.bitsPerByte ?? null, warmEnd: warmCurve[warmCurve.length - 1]?.bitsPerByte ?? null }))
}
console.log(JSON.stringify({ kind: 'done', files: out.map(o => (o as any).file) }))
