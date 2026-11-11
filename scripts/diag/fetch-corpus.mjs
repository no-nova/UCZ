// 按需恢复一个/数个标准输入；先验 baseline SHA-256，再原子放入可重建缓存。
// node scripts/diag/fetch-corpus.mjs osdb [dickens ...]；不会隐式下载全套。
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256, atomicJson } from './p9-checkpoint.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
const names = process.argv.slice(2)
if (!names.length) throw new Error('请明确指定需要恢复的文件，不默认下载全套')
const baseline = JSON.parse(await readFile(join(root, 'scripts/diag/baseline.json'), 'utf8')).files
const repo = 'yewq/Silesia-compression-corpus'
const folder = join(root, '.diag-data/corpus')
await mkdir(folder, { recursive: true })
let tree
for (const name of names) {
  const ref = baseline.find(f => f.file === name)
  if (!ref) throw new Error(`非标准语料名：${name}`)
  const path = join(folder, name)
  const existing = await readFile(path).catch(e => { if (e.code === 'ENOENT') return null; throw e })
  if (existing?.length === ref.size && sha256(existing) === ref.sha256) { console.log(`${name}: SHA-256 verified, cached`); continue }
  if (existing) throw new Error(`${path} 指纹错误；先检查，不静默覆盖`)
  tree ??= JSON.parse(execFileSync('gh', ['api', `repos/${repo}/git/trees/HEAD?recursive=1`], { encoding: 'utf8', timeout: 45000 }))
  const blob = tree.tree.find(t => t.type === 'blob' && (t.path === `${name}.bz2` || t.path.endsWith(`/${name}.bz2`)))
  if (!blob || !/^[a-f0-9]{40}$/.test(blob.sha)) throw new Error(`找不到 ${name}.bz2 的 Git blob`)
  const bz = execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/git/blobs/${blob.sha}`], { timeout: 45000, maxBuffer: 64 * 1024 * 1024 })
  const raw = execFileSync('bzip2', ['-dc'], { input: bz, timeout: 45000, maxBuffer: ref.size + 1024 })
  if (raw.length !== ref.size || sha256(raw) !== ref.sha256) throw new Error(`${name}: 与 baseline 大小/SHA-256 不符`)
  const temp = `${path}.${process.pid}.part`
  try { await writeFile(temp, raw); await rename(temp, path) } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e }) }
  await atomicJson(`${path}.source.json`, { repo, blob: blob.sha, bytes: raw.length, sha256: ref.sha256 })
  console.log(`${name}: ${raw.length} B, SHA-256 verified, saved to ${path}`)
}
