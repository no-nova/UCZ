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

export const VERSION = '0.1.0-beta.1'

const USAGE = `ucz ${VERSION} - Universal Adaptive Compression

Usage:
  ucz compress <input> [output] [-1|--fast] [-2|--balanced] [-3|--max] [-f|--force]
  ucz decompress <input> [output] [-f|--force]
  ucz inspect <input> [--fast|--balanced|--max] [--no-compress] [--json]
  ucz ncd <file1> <file2> [...fileN] [--mode cm|container] [--json]
  ucz --version | -v
  ucz --help | -h

Levels:
  -1, --fast       fast planning (fewest probes, slightly larger output)
  -2, --balanced   default planner level
  -3, --max        exhaustive planning (reference output)
`

function level(argv: string[]): CompressionLevel {
  if (argv.includes('-1') || argv.includes('--fast')) return 'fast'
  if (argv.includes('-3') || argv.includes('--max')) return 'max'
  return 'balanced'
}

function writeOut(path: string, bytes: Uint8Array, force: boolean): void {
  if (existsSync(path) && !force) throw new Error(`refusing to overwrite ${path} (use -f)`)
  writeFileSync(path, bytes)
}

async function cmdCompress(argv: string[]): Promise<void> {
  const input = argv[0]
  if (!input) throw new Error('missing input file')
  const output = argv[1] && !argv[1].startsWith('-') ? argv[1] : `${input}.ucz`
  const lvl = level(argv)
  const raw = new Uint8Array(readFileSync(input))
  const t = performance.now()
  const enc = await compressAdaptive(raw, undefined, { level: lvl })
  const ms = performance.now() - t
  writeOut(output, enc.container, argv.includes('-f') || argv.includes('--force'))
  const bpb = (enc.container.length * 8) / raw.length
  const ratio = enc.container.length ? raw.length / enc.container.length : 0
  console.log(`${basename(input)}  level=${lvl}`)
  console.log(`  input  ${raw.length} B`)
  console.log(`  output ${enc.container.length} B  (${ratio.toFixed(3)}x, ${bpb.toFixed(3)} bpb)`)
  console.log(`  time   ${ms.toFixed(0)} ms -> ${output}`)
}

async function cmdDecompress(argv: string[]): Promise<void> {
  const input = argv[0]
  if (!input) throw new Error('missing input file')
  const output = argv[1] && !argv[1].startsWith('-') ? argv[1] : input.replace(/\.ucz$/, '') || `${input}.out`
  const container = new Uint8Array(readFileSync(input))
  const t = performance.now()
  const out = decompress(container)
  const ms = performance.now() - t
  writeOut(output, out, argv.includes('-f') || argv.includes('--force'))
  console.log(`  output ${out.length} B  time ${ms.toFixed(0)} ms -> ${output}`)
}

async function cmdInspect(argv: string[]): Promise<void> {
  const input = argv[0]
  if (!input) throw new Error('missing input file')
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
  if (files.length < 2) throw new Error('need at least two files')
  const mode = argv.includes('container') ? 'container' : 'cm'
  const json = argv.includes('--json')
  const items = files.map(f => ({ name: basename(f), data: new Uint8Array(readFileSync(f)) }))
  if (items.length === 2) {
    const r = await computeNCD(items[0].data, items[1].data, { mode })
    if (json) { console.log(JSON.stringify(r, null, 2)); return }
    console.log(`C(x)     ${r.cx}`)
    console.log(`C(y)     ${r.cy}`)
    console.log(`C(x||y)  ${r.cxy}`)
    console.log(`C(y||x)  ${r.cyx}`)
    console.log(`C(y|x)   ${r.conditionalYGivenX}`)
    console.log(`C(x|y)   ${r.conditionalXGivenY}`)
    console.log(`NCD      ${r.ncd.toFixed(4)}  (profile=${r.profile}, mode=${r.mode})`)
    return
  }
  const res = await computeNCDMatrix(items, { mode })
  console.log(json ? JSON.stringify(res, null, 2) : formatNCDMatrixReport(res))
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--version') || argv.includes('-v')) { console.log(`UCZ v${VERSION}`); return }
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return }
  const [cmd, ...rest] = argv
  if (cmd === 'compress') return cmdCompress(rest)
  if (cmd === 'decompress') return cmdDecompress(rest)
  if (cmd === 'inspect') return cmdInspect(rest)
  if (cmd === 'ncd') return cmdNcd(rest)
  console.error(`unknown subcommand: ${cmd}\n`)
  console.log(USAGE)
  process.exitCode = 2
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(err => { console.error(String(err?.message ?? err)); process.exitCode = 1 })
