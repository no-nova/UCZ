// 一键语料库基准：目录输入、按文件隔离的子进程、峰值内存、可选基线核对。
//
// 用法：
//   node scripts/diag/bench-corpus.mjs --corpus <目录> [--jobs N] [--threads M]
//                                      [--out <目录>] [--baseline] [--no-bench]
//
// 为什么每个文件都要单独的进程：`maxRSS` 是进程级高水位标记，同进程里跑完
// 12 个文件只能得到"最大的那个文件"的内存，其余全被它盖住。只有隔离进程，
// 每个文件的峰值内存才是它自己的。
import { readdir, stat, mkdir, writeFile } from 'node:fs/promises'
import { join, basename, resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

/**
 * 手写解析而不是用库：参数很少，且必须对"位置参数是目录"这类用法给出
 * 明确错误信息，而不是抛 EISDIR。
 */
export function parseArgs(argv) {
  const opts = { corpus: null, jobs: 2, threads: 8, out: null, baseline: false, bench: true }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--corpus') opts.corpus = argv[++i]
    else if (a === '--jobs' || a === '-P' || a.startsWith('--jobs=') || a.startsWith('-P=')) {
      opts.jobs = Number(a.includes('=') ? a.split('=')[1] : argv[++i])
    } else if (a === '--threads' || a.startsWith('--threads=')) {
      opts.threads = Number(a.includes('=') ? a.split('=')[1] : argv[++i])
    } else if (a === '--out') opts.out = argv[++i]
    else if (a === '--baseline') opts.baseline = true
    else if (a === '--no-bench') opts.bench = false
    else if (a.startsWith('-')) throw Error(`未知参数 ${a}`)
    else positional.push(a)
  }
  // 直接以位置参数给出目录时也照单全收——这正是过去抛 EISDIR 的用法。
  if (!opts.corpus && positional.length) opts.corpus = positional.shift()
  if (positional.length) throw Error(`多余的位置参数：${positional.join(' ')}`)
  if (!opts.corpus) throw Error('用法: node scripts/diag/bench-corpus.mjs --corpus <目录|文件> [--jobs N] [--threads M] [--out 目录] [--baseline]')
  if (!Number.isFinite(opts.jobs) || opts.jobs < 1) throw Error('--jobs 必须是 >= 1 的整数')
  if (!Number.isFinite(opts.threads) || opts.threads < 1) throw Error('--threads 必须是 >= 1 的整数')
  return opts
}

/** 目录 → 直接子文件；单文件 → 就它自己。子目录不递归，避免无意吞掉整棵磁盘树。 */
export async function listInputs(corpus) {
  const info = await stat(corpus)
  if (info.isFile()) return [corpus]
  if (!info.isDirectory()) throw Error(`既不是文件也不是目录：${corpus}`)
  const entries = await readdir(corpus, { withFileTypes: true })
  const files = []
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue
    const full = join(corpus, e.name)
    const st = await stat(full)
    if (st.size > 0) files.push(full)
  }
  return files.sort()
}

const mib = (kib) => kib / 1024
const pad = (v, n) => String(v).padStart(n)

/** 跑一个文件（隔离进程），返回它的 bench-one JSON。 */
function runOne(file, opts) {
  const args = ['scripts/diag/run.mjs', 'bench-one', file]
  if (!opts.bench) args.push('--no-bench')
  const r = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, UCZ_THREADS: String(opts.threads) },
  })
  const text = r.stdout ?? ''
  const start = text.indexOf('{')
  if (start < 0) throw Error(`${basename(file)} 没有输出 JSON（exit ${r.status}）\n${text.slice(-2000)}\n${(r.stderr ?? '').slice(-2000)}`)
  // bench-one 会先打印若干行进度，JSON 是其中唯一以 { 开头的平衡块。
  let depth = 0, end = -1, inStr = false, esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') { inStr = true; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  if (end < 0) throw Error(`${basename(file)} 的 JSON 不完整`)
  return JSON.parse(text.slice(start, end))
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const files = await listInputs(opts.corpus)
  if (!files.length) throw Error(`目录里没有可用文件：${opts.corpus}`)
  if (opts.out) await mkdir(opts.out, { recursive: true })

  console.log(`语料库 ${opts.corpus}：${files.length} 个文件 · 并行 ${opts.jobs} · 每文件线程 ${opts.threads}\n`)
  const rows = [], failed = []
  let next = 0
  const startedAt = Date.now()
  const worker = async (slot) => {
    for (;;) {
      const i = next++
      if (i >= files.length) return
      const file = files[i]
      const t0 = Date.now()
      console.log(`[${pad(i + 1, String(files.length).length)}/${files.length}] 开始 ${basename(file)}`)
      try {
        const row = runOne(file, opts)
        row._wallMs = Date.now() - t0
        rows.push(row)
        if (opts.out) await writeFile(join(opts.out, `${basename(file)}.json`), JSON.stringify(row, null, 2))
        const flag = row.verified ? '' : `  ✗ 校验失败`
        console.log(`[${pad(i + 1, String(files.length).length)}/${files.length}] 完成 ${basename(file).padEnd(10)} ${pad(row.size, 10)} → ${pad(row.ucz, 10)} B  v${row.ver}  ${(row.encMs / 1000).toFixed(1)}s  峰值 ${row.peakMaxRSSMiB} MiB${flag}`)
        if (!row.verified) failed.push(row)
      } catch (e) {
        failed.push({ file: basename(file), error: String(e.message ?? e) })
        console.log(`[${i + 1}/${files.length}] 失败 ${basename(file)}: ${e.message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.jobs, files.length) }, (_, k) => worker(k)))

  rows.sort((a, b) => a.file.localeCompare(b.file))
  const total = rows.reduce((s, r) => s + r.size, 0)
  const totalUcz = rows.reduce((s, r) => s + r.ucz, 0)
  console.log('\n文件            原始 B        压缩 B   比例 %  版本  Segs   编码 s  解码 s  峰值 MiB   状态')
  console.log('-'.repeat(96))
  for (const r of rows) {
    console.log(`${r.file.padEnd(12)} ${pad(r.size, 11)} ${pad(r.ucz, 12)} ${pad(((r.ucz / r.size) * 100).toFixed(2), 7)} ${pad('v' + r.ver, 5)} ${pad(r.segs, 5)} ${pad((r.encMs / 1000).toFixed(2), 8)} ${pad((r.decMs / 1000).toFixed(2), 7)} ${pad(r.peakMaxRSSMiB, 9)}   ${r.verified ? 'PASS' : 'FAIL'}`)
  }
  console.log('-'.repeat(96))
  console.log(`合计 ${rows.length} 个文件：${pad(total, 11)} B → ${pad(totalUcz, 12)} B · ${((totalUcz / total) * 100).toFixed(2)} % · 用时 ${((Date.now() - startedAt) / 1000).toFixed(0)} s`)

  if (opts.out) {
    const summary = {
      corpus: opts.corpus, jobs: opts.jobs, threads: opts.threads,
      files: rows.length, totalBytes: total, totalUcz,
      pct: +(totalUcz / Math.max(1, total) * 100).toFixed(3),
      peakMaxRSSMiB: Math.max(...rows.map(r => r.peakMaxRSSMiB ?? 0)),
      rows,
    }
    await writeFile(join(opts.out, 'summary.json'), JSON.stringify(summary, null, 2))
    const csv = ['file,size,ucz,pct,ver,modelFlags,segs,encMs,decMs,encKBps,decKBps,encMaxRSSMiB,peakMaxRSSMiB,verified',
      ...rows.map(r => [r.file, r.size, r.ucz, ((r.ucz / r.size) * 100).toFixed(3), r.ver, r.modelFlags, r.segs,
        r.encMs, r.decMs, r.encKBps, r.decKBps, r.encMaxRSSMiB, r.peakMaxRSSMiB, r.verified].join(','))].join('\n')
    await writeFile(join(opts.out, 'summary.csv'), csv + '\n')
    console.log(`收据已写入 ${opts.out}`)
  }

  if (opts.baseline) {
    console.log('\n=== 基线核对 ===')
    if (!opts.out) { console.log('--baseline 需要 --out 目录（check-baseline 读取结果目录）'); process.exitCode = 1 }
    else {
      const r = spawnSync(process.execPath, ['scripts/diag/check-baseline.mjs', opts.out], { cwd: root, stdio: 'inherit' })
      if ((r.status ?? 1) !== 0) process.exitCode = 1
      const s = spawnSync(process.execPath, ['scripts/diag/summary.mjs', opts.out], { cwd: root, stdio: 'inherit' })
      if ((s.status ?? 1) !== 0) process.exitCode = 1
    }
  }

  if (failed.length) {
    console.error(`\n${failed.length} 个文件失败：`)
    for (const f of failed) console.error(`  ${f.file}: ${f.error ?? '无损校验未通过'}`)
    process.exitCode = 1
  }
}

// 只在被直接执行时运行，便于单元测试 import 上面的纯函数。
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(e => { console.error(e); process.exitCode = 1 })
}
