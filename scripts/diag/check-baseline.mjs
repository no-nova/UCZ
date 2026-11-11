// 与 scripts/diag/baseline.json 比对 bench-one 结果，回退超过阈值则失败。
//
// 用法：node scripts/diag/check-baseline.mjs <结果JSON|结果目录> [阈值百分比，默认 0.5]
// 环境变量：MAX_OUTPUT_BYTES 覆盖解压上限（默认 256 MiB）。
//
// P7-0 铁律（任一不满足即 FAIL，并以非 0 状态码退出）：
//   1. row.verified === true            —— 无损校验失败 / 缺失的记录绝不算 PASS；
//   2. row.size === ref.size            —— 输入字节数必须与基线完全一致；
//   3. row.sha256 === ref.sha256        —— 输入指纹必须一致（有指纹时强制）；
//   4. row.ucz <= row.size              —— 压缩后不能比原文更大；
//   5. row.pct 不高于基线 pct + 阈值     —— 相对 v14 基线不得回退；
//   6. 目录覆盖全部 12 个标准文件时，必须恰好 12 项通过（防止漏跑仍报"全部通过"）。
// P10：bestUczPolicy.strict 时逐文件 <= bestUcz（1 B回退也失败），全量同时核对总字节。
// v14 阈值仅约束历史基线，绝不放宽 bestUcz；重复结果不能算作通过。
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const [input, limitArg] = process.argv.slice(2).filter(a => a !== "--all")
if (!input) { console.error('用法: check-baseline.mjs <结果JSON|结果目录> [阈值%]'); process.exit(2) }
const limit = Number(limitArg ?? 0.5)
if (!Number.isFinite(limit) || limit < 0) { console.error("无效的 v14 阈值"); process.exit(2) }
const outputCap = Number(process.env.MAX_OUTPUT_BYTES ?? 256 * 1024 * 1024)
const base = JSON.parse(await readFile(join(here, 'baseline.json'), 'utf8'))
const totalFiles = base.files.length
const strictBest = base.bestUczPolicy?.strict === true
if (strictBest && (!base.files.every(r => Number.isSafeInteger(r.bestUcz) && r.bestUcz > 0)
  || base.files.reduce((n, r) => n + r.bestUcz, 0) !== base.total.bestUcz)) throw new Error('bestUcz 硬门禁基线不完整或总和不一致')

let files
try {
  const st = await stat(input)
  files = st.isDirectory()
    ? (await readdir(input)).filter(f => f.endsWith('.json')).sort().map(f => join(input, f))
    : [input]
} catch { files = [input] }

const isDir = files.length > 1 || (await stat(input).then(s => s.isDirectory()).catch(() => false))
const signed = (n) => (n > 0 ? '+' : '') + n
let failed = 0, passed = 0, totalBytes = 0
const seen = new Set()

for (const path of files) {
  let row
  try { row = JSON.parse(await readFile(path, 'utf8')) } catch { console.log(`SKIP ${basename(path)}：不是合法 JSON`); continue }
  const name = row.file ?? basename(path)
  const ref = base.files.find(f => f.file === name)
  if (!ref) { console.log(`SKIP ${name}：基线中没有该文件`); continue }
  if (!Number.isFinite(row.pct) || !Number.isSafeInteger(row.ucz) || row.ucz <= 0 || !Number.isSafeInteger(row.size) || row.size <= 0) {
    failed++; console.log(`FAIL ${name}：结果缺少 pct / ucz / size`); continue
  }
  const duplicate = seen.has(name)
  seen.add(name)
  const problems = []
  if (duplicate) problems.push('同一标准文件重复记录')
  else totalBytes += row.ucz
  // 1) 无损校验
  if (row.verified !== true) problems.push('verified 不为 true（无损校验失败或未记录）')
  // 2) 输入字节数
  if (row.size !== ref.size) problems.push(`输入字节数 ${row.size} ≠ 基线 ${ref.size}`)
  // 3) 输入指纹
  if (ref.sha256 && row.sha256 !== ref.sha256) problems.push('输入 sha256 与基线不符（语料被替换/截断）')
  // 4) 压缩后不得比原文大
  if (row.ucz > row.size) problems.push(`压缩后 ${row.ucz} > 原文 ${row.size}`)
  // 5) 相对 v14 基线不得回退超阈值
  const delta14 = (row.pct / ref.pct - 1) * 100
  if (!(delta14 <= limit)) problems.push(`相对 v14 ${delta14.toFixed(2)}% > 阈值 +${limit}%`)

  const best = ref.bestUcz
  if (strictBest && row.ucz > best) problems.push(`超过 bestUcz 硬门禁 ${row.ucz - best} B（不允许1 B回退）`)
  const dBytes = row.ucz - ref.ucz
  const dBest = best ? row.ucz - best : null
  const ok = problems.length === 0
  if (ok) passed++; else failed++
  const bestTxt = dBest === null ? 'bestUcz 未记录' : `vs bestUcz ${signed(dBest)} B${dBest > 0 ? '（回退）' : ''}`
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${row.ucz} B / ${row.pct}%` +
    ` | vs v14 ${signed(dBytes)} B (${delta14 >= 0 ? '+' : ''}${delta14.toFixed(2)}%)` +
    ` | ${bestTxt} | ver=${row.ver ?? '?'} verified=${row.verified}` +
    (ok ? '' : `\n       → ${problems.join('；')}`))
}

// 6) 漏跑检测
//    * 结果目录里出现 >= 12 个 JSON 却只有 < 12 项能对上基线 → 说明有结果被静默跳过，必须失败；
//    * 显式要求全量（--all 或 EXPECT_ALL=1）时，< 12 项即失败；
//    * 其它情况（沙箱里只跑了几个文件）只提示覆盖度，不判失败。
const expectAll = process.argv.includes('--all') || process.env.EXPECT_ALL === '1'
if ((isDir || expectAll) && seen.size < totalFiles) {
  const missing = base.files.map(f => f.file).filter(n => !seen.has(n))
  if (expectAll || files.length >= totalFiles) {
    failed++
    console.log(`FAIL 只到 ${seen.size}/${totalFiles} 个标准文件（缺少：${missing.join(', ')}）`)
  } else {
    console.log(`NOTE 本次只覆盖 ${seen.size}/${totalFiles} 个标准文件（缺少：${missing.join(', ')}）；全量校验请加 --all`)
  }
}

if (strictBest && seen.size === totalFiles) {
  if (totalBytes > base.total.bestUcz) { failed++; console.log(`FAIL 总字节 ${totalBytes} > bestUcz ${base.total.bestUcz}`) }
  else console.log(`TOTAL ${totalBytes} B <= bestUcz ${base.total.bestUcz} B（逐文件硬门禁另行检查）`)
}

if (!seen.size) { console.log('没有可比对的结果'); process.exitCode = 2 }
else {
  const prefix = isDir ? `[${seen.size}/${totalFiles}] ` : ''
  console.log(failed
    ? `${prefix}${failed} 项未通过（通过 ${passed} 项）`
    : `${prefix}全部 ${passed} 项通过（verified + size + sha256 + 无回退）`)
  process.exitCode = failed ? 1 : 0
}
