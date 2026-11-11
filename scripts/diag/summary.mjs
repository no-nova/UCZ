#!/usr/bin/env node
// Read-only bench-one summary. Default reference is the locked bestUcz ceiling,
// NOT the historical v14 ucz/timing fields. --v14 explicitly selects that view.
// --all requires twelve unique, verified, input-matching, same-source results.
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const base = JSON.parse(await readFile(join(here, 'baseline.json'), 'utf8'))
const ref = new Map(base.files.map(f => [f.file, f]))
const args = process.argv.slice(2), legacy = args.includes('--v14'), all = args.includes('--all')
const inputs = args.filter(a => a !== '--v14' && a !== '--all')
if (!inputs.length || inputs.some(a => a.startsWith('--'))) {
  console.error('用法: summary.mjs <结果目录|结果JSON…> [--all] [--v14]')
  process.exit(2)
}
if (!base.files.every(f => Number.isSafeInteger(f.bestUcz) && f.bestUcz > 0)
  || base.files.reduce((n,f) => n+f.bestUcz,0) !== base.total.bestUcz) throw Error('锁定 bestUcz 基线不完整')

const paths = []
for (const p of inputs) {
  try {
    if ((await stat(p)).isDirectory()) {
      for (const f of (await readdir(p)).sort()) if (f.endsWith('.json')) paths.push(join(p,f))
    } else paths.push(p) // Existing individual JSON files must not disappear.
  } catch { paths.push(p) }
}
let issues = 0
const fail = message => { issues++; console.log(`FAIL ${message}`) }
const byFile = new Map()
for (const p of paths) {
  let d
  try { d = JSON.parse(await readFile(p,'utf8')) }
  catch { fail(`${basename(p)}：不是合法 JSON，不计入小计`); continue }
  if (!d || typeof d.file !== 'string' || !ref.has(d.file)) {
    console.log(`SKIP ${basename(p)}：没有可识别的标准 file 字段`); continue
  }
  const items = byFile.get(d.file) ?? []
  items.push(d); byFile.set(d.file,items)
}
const rows = []
for (const b of base.files) {
  const items = byFile.get(b.file)
  if (!items) continue
  if (items.length !== 1) { fail(`${b.file}：重复记录，不计入小计`); continue }
  const d = items[0], problems = []
  if (!Number.isSafeInteger(d.ucz) || d.ucz <= 0 || !Number.isFinite(d.pct)) problems.push('ucz/pct 无效')
  if (d.verified !== true) problems.push('verified 不为 true')
  if (d.size !== b.size) problems.push('输入 size 不符')
  if (d.sha256 !== b.sha256) problems.push('输入 SHA 不符')
  if (d.sourceUnchanged === false) problems.push('运行中源码改变')
  if (problems.length) { fail(`${b.file}：${problems.join('；')}，不计入小计`); continue }
  rows.push(d)
}

const reference = legacy ? '历史 v14 ucz（不是锁定 bestUcz）' : `锁定 ${base.bestUczPolicy.label ?? "bestUcz"} bestUcz，完整十二项 ${base.total.bestUcz} B`
console.log(`比较基准：${reference}`)
console.log('文件      实测 UCZ B    对照 B       差值 B     变化      编码秒/解码秒（仅本次）')
const signed = n => `${n > 0 ? '+' : ''}${n}`
const seconds = n => Number.isFinite(n) && n >= 0 ? (n/1000).toFixed(1) : '?'
let size = 0, sumNew = 0, sumRef = 0, regressions = 0
for (const d of rows) {
  const b = ref.get(d.file), bytes = legacy ? b.ucz : b.bestUcz
  const delta = d.ucz-bytes
  size += b.size; sumNew += d.ucz; sumRef += bytes
  const regressed = d.ucz > b.bestUcz
  if (regressed) regressions++
  console.log(`${d.file.padEnd(9)} ${String(d.ucz).padStart(10)} ${String(bytes).padStart(10)} ${signed(delta).padStart(10)}  ${signed(+(delta/bytes*100).toFixed(3))}%  ${seconds(d.encMs)}/${seconds(d.decMs)}`
    + (regressed ? `  FAIL 超过锁定 bestUcz ${d.ucz-b.bestUcz} B` : ''))
}
const missing = base.files.map(f => f.file).filter(f => !rows.some(d => d.file === f))
console.log(`—— 有效且唯一的结果 ${rows.length}/${base.files.length} ——`)
if (missing.length) console.log(`未完成：缺少或无效 ${missing.join(', ')}；不是完整十二文件结果`)
if (sumRef) console.log(`${missing.length ? '有效子集小计' : '十二项字节小计'} ${sumNew}/${sumRef} B，${signed(+((sumNew-sumRef)/sumRef*100).toFixed(3))}%；对应输入 ${size} B`)

const sourceIds = new Set(rows.map(d => d.source?.sha256).filter(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)))
const allSourcesKnown = rows.every(d => typeof d.source?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(d.source.sha256))
const sameSource = allSourcesKnown && sourceIds.size === 1
if (rows.length && !sameSource) console.log('注意：源码 SHA 混合或缺失，不能当作同一版本的完整验收。')
console.log('表格不更新 baseline.json；正式验收仍须 check-baseline.mjs <结果目录> --all，逐文件不允许 1 B 回退。')
if (!rows.length) process.exitCode = 2
else process.exitCode = issues || regressions || (all && (missing.length || !sameSource)) ? 1 : 0
