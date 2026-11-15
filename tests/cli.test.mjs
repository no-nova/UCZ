// P31.0：CLI 冒烟测试。
//
// 单独放在 .mjs 里是因为 `tests/run.mjs` 会把 `tests/codec.test.ts` 打进一个
// 单文件包，而 esbuild 的 JavaScript API 自身不能被这样打包 —— 所以 CLI 的
// 打包/执行必须发生在包外。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  assert.equal(parsed.totalRawBytes, raw.length)
  assert.ok(parsed.segments.length >= 1)

  const n = run(['ncd', src, out])
  assert.equal(n.status, 0, `ncd 失败: ${n.stderr}`)
  assert.ok(/NCD\s+0\./.test(n.stdout), `ncd 输出缺少 NCD 行: ${n.stdout}`)

  // 0 B 空文件往返（CLI 一级）。
  const emptySrc = join(dir, 'empty.bin'), emptyArc = join(dir, 'empty.bin.ucz'), emptyOut = join(dir, 'empty.out')
  writeFileSync(emptySrc, new Uint8Array(0))
  assert.equal(run(['compress', emptySrc, emptyArc, '--fast']).status, 0, '空文件 compress 失败')
  assert.equal(run(['decompress', emptyArc, emptyOut]).status, 0, '空文件 decompress 失败')
  assert.equal(readFileSync(emptyOut).length, 0, '空文件往返应为 0 B')
  console.log(`[cli] compress/decompress/inspect/ncd ok uz=${readFileSync(arc).length}`)
} finally { rmSync(dir, { recursive: true, force: true }) }
