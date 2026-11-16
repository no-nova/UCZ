// P31.0：CLI 冒烟测试。
//
// 单独放在 .mjs 里是因为 `tests/run.mjs` 会把 `tests/codec.test.ts` 打进一个
// 单文件包，而 esbuild 的 JavaScript API 自身不能被这样打包 —— 所以 CLI 的
// 打包/执行必须发生在包外。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

const dir = mkdtempSync(join(tmpdir(), 'ucz-cli-'))
try {
  // Prefer the shipped `dist/cli.js`; fall back to a throwaway bundle when the
  // dist artefacts are absent (e.g. a fresh clone running tests only).
  const distCli = join(process.cwd(), 'dist', 'cli.js')
  const cli = existsSync(distCli) ? distCli : join(dir, 'cli.mjs')
  if (cli !== distCli) {
    await build({ entryPoints: ['src/cli.ts'], bundle: true, platform: 'node', format: 'esm', outfile: cli, logLevel: 'silent' })
  }
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })

  const ver = run(['--version'])
  assert.equal(ver.status, 0, `--version 失败: ${ver.stderr}`)
  assert.equal(ver.stdout.trim(), 'UCZ v0.1.0-beta.1')
  const help = run(['--help'])
  assert.equal(help.status, 0, `--help 失败: ${help.stderr}`)
  assert.ok(/Usage:/.test(help.stdout) && /--version/.test(help.stdout))
  const src = join(dir, 'sample.csv'), arc = join(dir, 'sample.csv.ucz'), out = join(dir, 'sample.out')
  let text = 'id,name,weight\n'
  for (let i = 0; i < 300; i++) text += `${i},row${i % 17},${(i * 37) % 1000}\n`
  const raw = new TextEncoder().encode(text)
  writeFileSync(src, raw)

  const c = run(['compress', src, arc, '--fast'])
  assert.equal(c.status, 0, `compress 失败: ${c.stderr}`)
  const d = run(['decompress', arc, out])
  assert.equal(d.status, 0, `decompress 失败: ${d.stderr}`)
  const back = new Uint8Array(readFileSync(out))
  assert.equal(back.length, raw.length)
  assert.equal(Buffer.compare(Buffer.from(back), Buffer.from(raw)), 0, 'CLI 往返必须逐字节一致')

  const i = run(['inspect', arc, '--json'])
  assert.equal(i.status, 0, `inspect 失败: ${i.stderr}`)
  const parsed = JSON.parse(i.stdout)
  // `--json` always returns the same top-level shape: container-only data lives
  // under `container`, and (unless --no-compress) the stream instruments sit
  // beside it, so consumers never get two different schemas.
  assert.equal(parsed.container.totalRawBytes, raw.length)
  assert.ok(parsed.container.segments.length >= 1)
  assert.equal(parsed.compressedBytes, readFileSync(arc).length)
  assert.ok(parsed.fingerprint && typeof parsed.fingerprint.inferredManifoldClass === 'string')
  const minimal = JSON.parse(run(['inspect', arc, '--json', '--no-compress']).stdout)
  assert.equal(minimal.container.totalRawBytes, raw.length)
  assert.ok(!('fingerprint' in minimal), '--no-compress must not invent a fingerprint')

  const n = run(['ncd', src, out])
  assert.equal(n.status, 0, `ncd 失败: ${n.stderr}`)
  assert.ok(/NCD\s+0\./.test(n.stdout), `ncd 输出缺少 NCD 行: ${n.stdout}`)

  // 0 B 空文件往返（CLI 一级）。
  const emptySrc = join(dir, 'empty.bin'), emptyArc = join(dir, 'empty.bin.ucz'), emptyOut = join(dir, 'empty.out')
  writeFileSync(emptySrc, new Uint8Array(0))
  assert.equal(run(['compress', emptySrc, emptyArc, '--fast']).status, 0, '空文件 compress 失败')
  assert.equal(run(['decompress', emptyArc, emptyOut]).status, 0, '空文件 decompress 失败')
  assert.equal(readFileSync(emptyOut).length, 0, '空文件往返应为 0 B')
  // P0-1: `npm` 通过 `node_modules/.bin/ucz` 的符号链接调用 CLI。裸的
  // `import.meta.url === file://${argv[1]}` 在这里会静默退出 0（什么都不做）。
  const link = join(dir, 'ucz-link.js')
  symlinkSync(cli, link)
  const viaLink = spawnSync(process.execPath, [link, '--version'], { encoding: 'utf8' })
  assert.equal(viaLink.status, 0, `symlink --version 失败: ${viaLink.stderr}`)
  assert.equal(viaLink.stdout.trim(), 'UCZ v0.1.0-beta.1', `symlink 入口未命中: ${JSON.stringify(viaLink.stdout)}`)

  // 标志可以出现在任意位置。
  assert.equal(run(['compress', '-1', src, join(dir, 'flag-first.ucz')]).status, 0, '前置 -1 失败')
  assert.equal(run(['inspect', '--json', arc]).status, 0, '前置 --json 失败')

  // `--mode` 严格校验，且不会把名为 `cm`/`container` 的文件当成模式。
  const bogus = run(['ncd', src, out, '--mode', 'bogus'])
  assert.equal(bogus.status, 1, '--mode bogus 应以退出码 1 失败')
  assert.ok(/invalid --mode/.test(bogus.stderr), `--mode 报错信息不清晰: ${bogus.stderr}`)

  // 非 `.ucz` 输入解压时默认写 `<input>.out`，绝不可能原地覆盖。
  const plain = join(dir, 'container.bin')
  writeFileSync(plain, readFileSync(arc))
  const noExt = run(['decompress', plain])
  assert.equal(noExt.status, 0, `非 .ucz 输入解压失败: ${noExt.stderr}`)
  assert.ok(existsSync(`${plain}.out`), '应默认写入 <input>.out')
  assert.equal(Buffer.compare(readFileSync(`${plain}.out`), Buffer.from(raw)), 0, '默认输出必须还原原文件')
  assert.equal(Buffer.compare(readFileSync(plain), readFileSync(arc)), 0, '输入文件必须保持原样')

  // 已存在的输出必须要求 -f，且在压缩之前就失败（fail fast）。
  const guarded = run(['compress', src, arc])
  assert.equal(guarded.status, 1, '覆盖已存在文件应失败')
  assert.ok(/refusing to overwrite/.test(guarded.stderr), `覆盖保护缺失: ${guarded.stderr}`)

  // P0-2: `node --input-type=module -e` 下 worker 继承 execArgv 会崩在
  // `require is not defined`，且 10 分钟看门狗会把进程钉住。这里必须在 5 s 内退出。
  const lib = join(dir, 'lib.mjs')
  await build({ entryPoints: ['src/index.ts'], bundle: true, platform: 'node', format: 'esm', outfile: lib, logLevel: 'silent' })
  const big = join(dir, 'multi.bin')
  const chunks = []
  for (let r = 0; r < 900; r++) chunks.push(new TextEncoder().encode(`${r},alpha,${(r * 131) % 997},payload-${r % 37}\n`))
  writeFileSync(big, Buffer.concat(chunks.map(c => Buffer.from(c))))
  const libUrl = pathToFileURL(lib).href
  const script = `
const { readFileSync } = await import('node:fs')
const { compressAdaptive, decompress } = await import(${JSON.stringify(libUrl)})
const raw = new Uint8Array(readFileSync(${JSON.stringify(big)}))
const enc = await compressAdaptive(raw, undefined, { level: 'fast' })
const back = decompress(enc.container)
if (back.length !== raw.length) throw new Error('length mismatch')
console.log('module-eval ok', enc.container.length)
`
  const started = Date.now()
  const evalRun = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, UCZ_THREADS: '4' },
  })
  const elapsed = Date.now() - started
  assert.equal(evalRun.status, 0, `--input-type=module 下 worker 崩溃: ${evalRun.stderr}`)
  assert.ok(/module-eval ok/.test(evalRun.stdout), `缺少成功标记: ${evalRun.stdout}`)
  assert.ok(elapsed < 20000, `--input-type=module 调用过慢（${elapsed} ms），看门狗可能未 unref`)

  console.log(`[cli] compress/decompress/inspect/ncd + symlink + module-eval ok uz=${readFileSync(arc).length}`)
} finally { rmSync(dir, { recursive: true, force: true }) }
