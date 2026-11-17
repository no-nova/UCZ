// NodeNext requires explicit `.js` extensions in ESM declaration imports.
// TypeScript emits declarations from our extensionless source imports, so the
// published `.d.ts` files need a deterministic post-processing pass. This does
// not touch `dist/index.js` or any container bytes.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const RELATIVE_EXT = /\.(?:js|mjs|cjs|json|d\.ts)$/

function resolveSpecifier(file, spec) {
  if (!spec.startsWith('.')) return spec
  const base = resolve(dirname(file), spec)

  // Directory imports such as `./planner` must become `./planner/index.js`;
  // plain `./planner.js` would make NodeNext look for a missing file.
  if (spec.endsWith('.js')) {
    const stem = spec.slice(0, -3)
    const stemAbs = resolve(dirname(file), stem)
    if (!existsSync(stemAbs + '.d.ts') && existsSync(join(stemAbs, 'index.d.ts'))) return stem + '/index.js'
    return spec
  }
  if (RELATIVE_EXT.test(spec)) return spec
  if (existsSync(base + '.d.ts')) return spec + '.js'
  if (existsSync(join(base, 'index.d.ts'))) return spec + '/index.js'
  return spec
}

function rewrite(file, text) {
  let unresolved = 0
  const replace = (m, prefix, quote, spec) => {
    const next = resolveSpecifier(file, spec)
    if (next === spec && spec.startsWith('.') && !RELATIVE_EXT.test(spec)) unresolved++
    return prefix + quote + next + quote
  }
  const out = text
    .replace(/(\bfrom\s*)(['"])(\.[^'"]*)\2/g, replace)
    .replace(/(\bimport\s*\(\s*)(['"])(\.[^'"]*)\2/g, replace)
  return { out, unresolved }
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p, files)
    else if (entry.name.endsWith('.d.ts')) files.push(p)
  }
  return files
}

export function fixDeclarationSpecifiers(root = 'dist') {
  const files = []
  const entry = join(root, 'index.d.ts')
  if (existsSync(entry)) files.push(entry)
  const types = join(root, 'types')
  if (existsSync(types)) walk(types, files)

  let changed = 0
  for (const file of files) {
    const before = readFileSync(file, 'utf8')
    const { out, unresolved } = rewrite(file, before)
    if (unresolved > 0) throw new Error(`unresolved relative declaration import(s) in ${file}`)
    if (out !== before) {
      writeFileSync(file, out)
      changed++
    }
  }
  return { files: files.length, changed }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { files, changed } = fixDeclarationSpecifiers()
  console.log(`fixed declaration specifiers: ${changed}/${files} file(s)`)
}
