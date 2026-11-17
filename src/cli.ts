#!/usr/bin/env node
/**
 * UCZ command line interface.
 *
 * All four subcommands are thin wrappers over the library API: `compress` /
 * `decompress` go through `codec`, `inspect` through `src/lib/inspect.ts` and
 * `ncd` through `src/lib/ncd.ts`. The CLI never participates in an algorithmic
 * decision, so it cannot change a single golden byte.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compressAdaptive, decompress } from './lib/codec'
import type { CompressionLevel } from './lib/codec'
import { formatInspectionReport, inspectContainer, inspectStream, isContainer } from './lib/inspect'
import { computeNCD, computeNCDMatrix, formatNCDMatrixReport } from './lib/ncd'
import type { NcdMode } from './lib/ncd'

export { VERSION } from './version'
import { VERSION } from './version'

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

/** Errors raised deep inside the container reader are authored in Chinese. */
const ERROR_EN: Array<[string, string]> = [
  ['不是有效的 UCZ 容器（不支持的格式版本）', 'not a valid UCZ container (unsupported format version)'],
  ['不支持的 UCZ 格式版本', 'unsupported UCZ format version'],
  ['容器被截断', 'container is truncated'],
  ['长度校验失败', 'region lengths do not add up to the declared size'],
  ['无效的长度', 'invalid length'],
  ['无效的区域长度', 'invalid region length'],
  ['无效的规则字典', 'invalid rule dictionary'],
  ['位图被截断', 'group membership bitmap is truncated'],
  ['空规则', 'empty rule'],
  ['未知组标志位', 'unknown group flag bits'],
  ['无效的转置步长', 'invalid transpose stride'],
  ['无效子通道参数', 'invalid sub-channel parameters'],
  ['无效 v20 worker 配置', 'invalid v20 worker configuration'],
]

function english(message: string): string {
  for (const [zh, en] of ERROR_EN) if (message.includes(zh)) return en
  return message
}

interface ParsedArgs {
  flags: Set<string>
  positionals: string[]
  values: Map<string, string>
  mode?: string
}

const VALUE_FLAGS = new Set(['--mode', '--threads', '--memory-limit', '--time-budget', '--max-output'])

/**
 * Parse flags in any position: `ucz compress -1 in.txt`, `ucz inspect --json a`,
 * `ucz ncd --mode=container a b` all work. Anything that is not a recognised
 * flag is a positional argument, so file names that merely look like words are
 * safe.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>()
  const positionals: string[] = []
  const values = new Map<string, string>()
  let mode: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { positionals.push(...argv.slice(i + 1)); break }
    if (a === '--mode') {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('-')) throw new Error('--mode needs a value: cm or container')
      mode = v
      i++
      continue
    }
    if (a.startsWith('--mode=')) { mode = a.slice('--mode='.length); continue }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('-')) throw new Error(`${a} needs a value`)
      values.set(a, v)
      i++
      continue
    }
    if ([...VALUE_FLAGS].some(f => a.startsWith(`${f}=`))) {
      const f = [...VALUE_FLAGS].find(x => a.startsWith(`${x}=`))!
      values.set(f, a.slice(f.length + 1))
      continue
    }
    if (a.startsWith('-') && a !== '-') {
      if (a === '-1' || a === '-2' || a === '-3' || a === '-f' || a === '-v' || a === '-h'
        || a === '--fast' || a === '--balanced' || a === '--max' || a === '--force'
        || a === '--json' || a === '--no-compress' || a === '--version' || a === '--help'
        || a === '--checksum' || a === '--strict-zero-prior') {
        flags.add(a)
        continue
      }
      throw new Error(`unknown flag: ${a}`)
    }
    positionals.push(a)
  }
  if (mode !== undefined && mode !== 'cm' && mode !== 'container') {
    throw new Error(`invalid --mode '${mode}' (expected cm or container)`)
  }
  if (mode !== undefined && values.has('--mode')) mode = values.get('--mode')
  if (values.has('--mode') && values.get('--mode') !== 'cm' && values.get('--mode') !== 'container') {
    throw new Error(`invalid --mode '${values.get('--mode')}' (expected cm or container)`)
  }
  return { flags, positionals, values, mode }
}

function intValue(args: ParsedArgs, flag: string): number | undefined {
  const raw = args.values.get(flag)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) throw new Error(`${flag} needs a non-negative integer (got '${raw}')`)
  return n
}

/**
 * Budget knobs. They never change the format: they only bound how much search
 * the planner is allowed to do, plus which inputs we refuse outright. When the
 * time budget cuts the search short the result is "best within budget", not
 * "best of all candidates" — the CLI says so on stdout.
 */
function applyBudgets(args: ParsedArgs): { timeBudgetMs?: number; maxOutputBytes?: number } {
  const threads = intValue(args, '--threads')
  const memMiB = intValue(args, '--memory-limit')
  const timeSec = intValue(args, '--time-budget')
  const maxOut = intValue(args, '--max-output')
  if (memMiB !== undefined && memMiB < 800) throw new Error('--memory-limit must be at least 800 MiB (a single 24-bit model is ~640 MiB)')
  let budgetThreads = threads
  if (memMiB !== undefined) {
    const byMemory = Math.max(1, Math.floor(memMiB / 640)) // ~640 MiB per 24-bit model
    budgetThreads = budgetThreads === undefined ? byMemory : Math.min(budgetThreads, byMemory)
  }
  if (budgetThreads !== undefined) process.env.UCZ_THREADS = String(Math.max(1, budgetThreads))
  // The worker-count cap alone cannot stop a run that is already allocating; this env
  // var is the runtime half, enforced in `runJob` before a job touches memory.
  if (memMiB !== undefined) process.env.UCZ_RSS_LIMIT_MIB = String(memMiB)
  return { timeBudgetMs: timeSec === undefined ? undefined : Math.round(timeSec * 1000), maxOutputBytes: maxOut }
}

function levelOf(flags: Set<string>): CompressionLevel {
  if (flags.has('-1') || flags.has('--fast')) return 'fast'
  if (flags.has('-3') || flags.has('--max')) return 'max'
  return 'balanced'
}

function forceOf(flags: Set<string>): boolean {
  return flags.has('-f') || flags.has('--force')
}

function guardOverwrite(path: string, force: boolean): void {
  if (existsSync(path) && !force) throw new Error(`refusing to overwrite ${path} (use -f)`)
}

function writeOut(path: string, bytes: Uint8Array): void {
  writeFileSync(path, bytes)
}

async function cmdCompress(args: ParsedArgs): Promise<void> {
  const [input, explicitOut] = args.positionals
  if (!input) throw new Error('missing input file')
  const output = explicitOut ?? `${input}.ucz`
  const lvl = levelOf(args.flags)
  // Fail before spending minutes on a compression we would refuse to write.
  guardOverwrite(output, forceOf(args.flags))
  const budgets = applyBudgets(args)
  const raw = new Uint8Array(readFileSync(input))
  const t = performance.now()
  const enc = await compressAdaptive(raw, undefined, {
    level: lvl,
    checksum: args.flags.has('--checksum'),
    strictZeroPrior: args.flags.has('--strict-zero-prior'),
    ...budgets,
  })
  const ms = performance.now() - t
  if (budgets.maxOutputBytes !== undefined && enc.container.length > budgets.maxOutputBytes) {
    throw new Error(`output ${enc.container.length} B exceeds --max-output ${budgets.maxOutputBytes} B`)
  }
  writeOut(output, enc.container)
  const ratio = raw.length === 0 ? 1 : raw.length / enc.container.length
  const bpb = raw.length === 0 ? 0 : (enc.container.length * 8) / raw.length
  console.log(`${basename(input)}  level=${lvl}`)
  console.log(`  input  ${raw.length} B`)
  console.log(`  output ${enc.container.length} B  (${ratio.toFixed(3)}x, ${bpb.toFixed(3)} bpb)`)
  console.log(`  time   ${ms.toFixed(0)} ms -> ${output}`)
}

async function cmdDecompress(args: ParsedArgs): Promise<void> {
  const [input, explicitOut] = args.positionals
  if (!input) throw new Error('missing input file')
  // Never default to the input path: a non-.ucz input gets its own .out name.
  const output = explicitOut ?? (input.endsWith('.ucz') ? input.slice(0, -4) : `${input}.out`)
  if (output === input) throw new Error('refusing to decompress in place (pass an explicit output path)')
  guardOverwrite(output, forceOf(args.flags))
  const container = new Uint8Array(readFileSync(input))
  // `--max-output` bounds the *decompressed* size too — a container may legitimately
  // be small and expand a lot, so the decode path needs the same ceiling.
  const cap = applyBudgets(args).maxOutputBytes
  const t = performance.now()
  const out = cap === undefined ? decompress(container) : decompress(container, undefined, cap)
  const ms = performance.now() - t
  writeOut(output, out)
  console.log(`  output ${out.length} B  time ${ms.toFixed(0)} ms -> ${output}`)
}

async function cmdInspect(args: ParsedArgs): Promise<void> {
  const [input] = args.positionals
  if (!input) throw new Error('missing input file')
  const bytes = new Uint8Array(readFileSync(input))
  const json = args.flags.has('--json')
  const field = args.flags.has('--no-compress')
  if (isContainer(bytes)) {
    const anatomy = inspectContainer(bytes)
    if (field) {
      // `--json` always answers with the same top-level shape; with
      // `--no-compress` only the container part is available.
      const minimal = { container: anatomy, compressedBytes: bytes.length, elapsedMs: 0 }
      console.log(json ? JSON.stringify(minimal, null, 2) : formatInspectionReport({ ...emptyInspection(), ...minimal } as never))
      return
    }
    const info = await inspectStream(decompress(bytes), { compress: false })
    info.container = anatomy
    info.compressedBytes = bytes.length
    console.log(json ? JSON.stringify(info, null, 2) : formatInspectionReport(info))
    return
  }
  const info = await inspectStream(bytes, { compress: !field, level: levelOf(args.flags) })
  console.log(json ? JSON.stringify(info, null, 2) : formatInspectionReport(info))
}

function emptyInspection() {
  return { fingerprint: null, residual: null }
}

async function cmdNcd(args: ParsedArgs): Promise<void> {
  const files = args.positionals
  if (files.length < 2) throw new Error('need at least two files')
  const mode: NcdMode = args.mode === 'container' ? 'container' : 'cm'
  const json = args.flags.has('--json')
  const items = files.map(f => ({ name: basename(f), data: new Uint8Array(readFileSync(f)) }))
  const bytes = (v: number) => `${v.toFixed(0)} B`
  if (items.length === 2) {
    const r = await computeNCD(items[0].data, items[1].data, { mode })
    if (json) { console.log(JSON.stringify(r, null, 2)); return }
    console.log(`C(x)     ${bytes(r.cx)}`)
    console.log(`C(y)     ${bytes(r.cy)}`)
    console.log(`C(y|x)   ${bytes(r.conditionalYGivenX)}   (cost of y given x, both directions encoded)`)
    console.log(`C(x|y)   ${bytes(r.conditionalXGivenY)}   (cost of x given y)`)
    console.log(`NCD      ${r.ncd.toFixed(4)}  (profile=${r.profile}, mode=${r.mode}, window=${r.windowBytes} B)`)
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
  const args = parseArgs(rest)
  if (cmd === 'compress') return cmdCompress(args)
  if (cmd === 'decompress') return cmdDecompress(args)
  if (cmd === 'inspect') return cmdInspect(args)
  if (cmd === 'ncd') return cmdNcd(args)
  console.error(`unknown subcommand: ${cmd}\n`)
  console.log(USAGE)
  process.exitCode = 2
}

/**
 * True when this file was started directly. `import.meta.url` is already
 * resolved, so the comparison must resolve `argv[1]` too: an `npm` symlink
 * (`node_modules/.bin/ucz`), a path containing spaces, or a Windows drive
 * letter all make the naive `file://${argv[1]}` form fail silently.
 */
const isMain = (() => {
  if (!process.argv[1]) return false
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
  } catch {
    try { return pathToFileURL(process.argv[1]).href === import.meta.url } catch { return false }
  }
})()

if (isMain) {
  main().catch(err => {
    console.error(english(String(err?.message ?? err)))
    process.exitCode = 1
  })
}
