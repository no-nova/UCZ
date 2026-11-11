// 生成/校验“逐字节黄金基准”：对固定输入集合跑指定编码路径，输出全部字节哈希。
// 用法：node scripts/diag/run.mjs probe-golden <write|verify> <输出文件>
// 用途：P1 内核提速必须保证输出比特流 100% 不变，本探针给出快速回归门。
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { encodeCM } from '../../src/lib/coder'
import { encodeTerrainGroup, encodeSpec, ID } from '../../src/lib/codec'

const mode = process.argv[2] ?? 'verify'
const outFile = process.argv[3] ?? '/tmp/golden.json'
const corpus = '/tmp/corpus'
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 16)

// 语料按 1 MiB 截断即可覆盖全部 CM 变体与匹配模型路径；再补几段合成数据打边界。
const files = ['dickens', 'xml', 'osdb', 'nci', 'mozilla']
const cases: { name: string; run: () => Uint8Array }[] = []
for (const f of files) {
  const data = (await readFile(`${corpus}/${f}`)).subarray(0, 1 << 20)
  cases.push({ name: `${f}:text`, run: () => encodeCM(data, 'text', 1, 1) })
  cases.push({ name: `${f}:textV2`, run: () => encodeCM(data, 'text', 1, 1, undefined, 0, undefined, undefined, true, 0) })
  cases.push({ name: `${f}:textV3`, run: () => encodeCM(data, 'text', 1, 1, undefined, 0, undefined, undefined, 'v13', 0) })
  cases.push({ name: `${f}:bin`, run: () => encodeCM(data, 'bin', 1, 1) })
  cases.push({ name: `${f}:binV3`, run: () => encodeCM(data, 'bin', 1, 1, undefined, 0, undefined, undefined, 'v13', 0) })
  cases.push({ name: `${f}:res2dV3`, run: () => encodeCM(data, 'res2d', 3, 24, undefined, 0, undefined, undefined, 'v13', 24) })
  cases.push({ name: `${f}:res`, run: () => encodeCM(data, 'res', 3, 1, undefined, 0, undefined, undefined, 'v13', 0) })
  cases.push({ name: `${f}:o0`, run: () => encodeCM(data, 'o0', 1, 1) })
  cases.push({ name: `${f}:o1`, run: () => encodeCM(data, 'o1', 1, 1) })
  // 多种变换规则走 encodeSpec，覆盖非 CM 路径不受影响
  for (const id of [ID.TRANSPOSE_GROUP, ID.TRANSPOSE_2D, ID.GRAD_V3, ID.DELTA_V3, ID.BCJ_V3, ID.D16, ID.ANCHOR_FOLD])
    cases.push({ name: `${f}:spec${id}`, run: () => encodeSpec(data.subarray(0, 256 * 1024), { id, s: id === ID.GRAD_V3 ? 2 : 4, r: id === ID.GRAD_V3 ? 24 : 8 }) })
}
const results: Record<string, { bytes: number; sha: string }> = {}
for (const c of cases) { const out = c.run(); results[c.name] = { bytes: out.length, sha: sha(out) } }

if (mode === 'write') {
  await writeFile(outFile, JSON.stringify(results, null, 1))
  console.log(`已写入 ${Object.keys(results).length} 项黄金值 → ${outFile}`)
} else {
  const ref = JSON.parse(await readFile(outFile, 'utf8'))
  let bad = 0
  for (const k of Object.keys(ref)) {
    const a = ref[k], b = results[k]
    if (!b) { console.log(`缺失 ${k}`); bad++; continue }
    if (a.bytes !== b.bytes || a.sha !== b.sha) { console.log(`不一致 ${k}: 期望 ${a.bytes}/${a.sha}，实际 ${b.bytes}/${b.sha}`); bad++ }
  }
  console.log(bad ? `${bad}/${Object.keys(ref).length} 项不一致` : `全部 ${Object.keys(ref).length} 项逐字节一致`)
  process.exitCode = bad ? 1 : 0
}
