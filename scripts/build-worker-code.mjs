#!/usr/bin/env node
// 把 parallel-worker.ts 打包成一段自包含源码字符串，写入 src/lib/parallel-worker-code.ts。
//
// 为什么要在构建期生成：worker 必须能在 Node（probe/test/bench）与浏览器（Vite 打包）
// 里都能启动，而两边的模块加载机制不同。把 worker 代码固化成普通字符串常量后，
// 主包只需 `new Worker(source, {eval:true})`（Node）或 Blob URL（浏览器），
// 不依赖任何运行时文件路径，也不会被单文件打包（viteSingleFile）打断。
//
// 用法：node scripts/build-worker-code.mjs [--check]
//   --check  只校验生成结果是否与磁盘一致（CI 用），不一致则退出码 1。
import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const entry = join(root, 'src/lib/parallel-worker.ts')
const target = join(root, 'src/lib/parallel-worker-code.ts')

const result = await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  write: false,
  logLevel: 'silent',
  // worker 里不需要 sourcemap；压缩到最小可减少主包体积。
  minify: true,
})
const source = result.outputFiles[0].text
const file = `// 由 scripts/build-worker-code.mjs 生成，请勿手改。
// 内容：src/lib/parallel-worker.ts 打包后的自包含源码（CJS）。
// 重新生成：node scripts/build-worker-code.mjs
export const PARALLEL_WORKER_CODE = ${JSON.stringify(source)}
`

// 宪法第 9 条：固化后的 worker 源码必须 <= 512 KiB（主包与单文件 Web 构建的硬上限）。
const SIZE_LIMIT = 512 * 1024
if (process.argv.includes('--check')) {
  let current = ''
  try { current = await readFile(target, 'utf8') } catch { /* 缺失即不一致 */ }
  if (current !== file) { console.error('parallel-worker-code.ts 与源码不一致，请运行 node scripts/build-worker-code.mjs'); process.exit(1) }
  const bytes = Buffer.byteLength(current, 'utf8')
  if (bytes > SIZE_LIMIT) { console.error(`parallel-worker-code.ts 超过 ${SIZE_LIMIT} B 上限（当前 ${bytes} B）`); process.exit(1) }
  console.log(`parallel-worker-code.ts 是最新的（${(bytes / 1024).toFixed(1)} KB <= 512 KB）`)
} else {
  await writeFile(target, file)
  console.log(`已生成 ${target}（${(source.length / 1024).toFixed(1)} KB）`)
}
