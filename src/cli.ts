#!/usr/bin/env node
/**
 * P31.0：UCZ 官方命令行。
 *
 * 四个子命令都是对库 API 的薄封装：`compress` / `decompress` 走 `codec`，
 * `inspect` 走 `src/lib/inspect.ts`，`ncd` 走 `src/lib/ncd.ts`。
 * 命令行**不参与**算法决策，所以它不会改变任何一个 golden 文件的字节。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import { compressAdaptive, decompress } from './lib/codec'
import type { CompressionLevel } from './lib/codec'
import { formatInspectionReport, inspectContainer, inspectStream, isContainer } from './lib/inspect'
import { computeNCD, computeNCDMatrix, formatNCDMatrixReport } from './lib/ncd'

const USAGE = `ucz — 通用自适应压缩 (Universal Adaptive Compression)

用法:
  ucz compress <input> [output] [-1|--fast] [-2|--balanced] [-3|--max] [-f|--force]
  ucz decompress <input> [output] [-f|--force]
  ucz inspect <input> [--fast|--balanced|--max] [--no-compress] [--json]
  ucz ncd <file1> <file2> [...fileN] [--mode cm|container] [--json]
  ucz --help
`

function level(argv: string[]): CompressionLevel {
  if (argv.includes('-1') || argv.includes('--fast')) return 'fast'
  if (argv.includes('-3') || argv.includes('--max')) return 'max'
  return 'balanced'
}

function writeOut(path: string, bytes: Uint8Array, force: boolean): void {
  if (existsSync(path) && !force) throw new Error(`文件已存在：${path}（加 -f 覆盖）`)
  writeFileSync(path, bytes)
}

async function cmdCompress(argv: string[]): Promise<void> {
  const input = argv[0]
  if (!input) throw new Error('缺少输入文件')
  const output = argv[1] && !argv[1].startsWith('-') ? argv[1] : `${input}.ucz`
  const lvl = level(argv)
  const raw = new Uint8Array(readFileSync(input))
  const t = performance.now()
  const enc = await compressAdaptive(raw, undefined, { level: lvl })
  const ms = performance.now() - t
  writeOut(output, enc.container, argv.includes('-f') || argv.includes('--force'))
  const bpb = (enc.container.length * 8) / raw.length
  console.log(`${basename(input)} 档位=${lvl}`)
  console.log(`  输入 ${raw.length} B → 输出 ${enc.container.length} B  (${(raw.length / enc.container.length).toFixed(3)}×, ${bpb.toFixed(3)} bpb)`)
  console.log(`  耗时 ${ms.toFixed(0)} ms → ${output}`)
}

async function cmdDecompress(argv: string[]): Promise<void> {
  const input = argv[0]
  if (!input) throw new Error('缺少输入文件')
  const output = argv[1] && !argv[1].startsWith('-') ? argv[1] : input.replace(/\.ucz$/, '') || `${input}.out`
  const container = new Uint8Array(readFileSync(input))
  const t = performance.now()
  const out = decompress(container)
  const ms = performance.now() - t
  writeOut(output, out, argv.includes('-f') || argv.includes('--force'))
  console.log(`  输出 ${out.length} B，耗时 ${ms.toFixed(0)} ms → ${output}`)
}

async function cmdInspect(argv: string[]): Promise<void> {
  const input = argv[0]
  if (!input) throw new Error('缺少输入文件')
  const bytes = new Uint8Array(readFileSync(input))
  const json = argv.includes('--json')
  if (isContainer(bytes)) {
    const anatomy = inspectContainer(bytes)
    if (json) { console.log(JSON.stringify(anatomy, null, 2)); return }
    const info = await inspectStream(decompress(bytes), { compress: false })
    info.container = anatomy
    info.compressedBytes = bytes.length
    console.log(formatInspectionReport(info))
    return
  }
  const info = await inspectStream(bytes, {
    compress: !argv.includes('--no-compress'),
    level: level(argv),
  })
  console.log(json ? JSON.stringify(info, null, 2) : formatInspectionReport(info))
}

async function cmdNcd(argv: string[]): Promise<void> {
  const files = argv.filter(a => !a.startsWith('-') && argv[argv.indexOf(a) - 1] !== '--mode')
  if (files.length < 2) throw new Error('需要至少两个文件')
  const mode = argv.includes('container') ? 'container' : 'cm'
  const json = argv.includes('--json')
  const items = files.map(f => ({ name: basename(f), data: new Uint8Array(readFileSync(f)) }))
  if (items.length === 2) {
    const r = await computeNCD(items[0].data, items[1].data, { mode })
    if (json) { console.log(JSON.stringify(r, null, 2)); return }
    console.log(`C(x)=${r.cx}  C(y)=${r.cy}  C(x||y)=${r.cxy}  C(y||x)=${r.cyx}`)
    console.log(`C(y|x)=${r.conditionalYGivenX}  C(x|y)=${r.conditionalXGivenY}`)
    console.log(`NCD=${r.ncd.toFixed(4)}  profile=${r.profile}  mode=${r.mode}`)
    return
  }
  const res = await computeNCDMatrix(items, { mode })
  console.log(json ? JSON.stringify(res, null, 2) : formatNCDMatrixReport(res))
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return }
  const [cmd, ...rest] = argv
  if (cmd === 'compress') return cmdCompress(rest)
  if (cmd === 'decompress') return cmdDecompress(rest)
  if (cmd === 'inspect') return cmdInspect(rest)
  if (cmd === 'ncd') return cmdNcd(rest)
  console.error(`未知子命令：${cmd}\n`)
  console.log(USAGE)
  process.exitCode = 2
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(err => { console.error(String(err?.message ?? err)); process.exitCode = 1 })
