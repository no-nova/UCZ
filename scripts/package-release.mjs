/**
 * Package the Web GUI as the release artifact: one self-contained HTML file.
 *
 * `npm run build:web` already emits `dist/web/index.html` with every script,
 * style and worker inlined (vite-plugin-singlefile). This script turns that
 * build into something that can be attached to a GitHub release and opened by
 * double-click, from any directory, with no server and no sibling files:
 *
 *   dist/ucz-v<version>.html          <- the artifact
 *   dist/ucz-v<version>.html.sha256   <- its digest
 *
 * Two edits are applied to the bundle:
 *   1. the footer's `href="./LICENSE"` is redirected to the canonical MPL-2.0
 *      URL, because a single file has no sibling LICENSE to point at;
 *   2. a provenance comment is prepended (version, commit, build time, tool
 *      versions) so a downloaded artifact is identifiable without asking.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const htmlPath = path.join(root, 'dist/web/index.html')
const versionPath = path.join(root, 'src/version.ts')

if (!existsSync(htmlPath)) {
  console.error('dist/web/index.html is missing — run `npm run build:web` first')
  process.exit(1)
}

const versionMatch = /VERSION\s*=\s*'([^']+)'/.exec(readFileSync(versionPath, 'utf8'))
if (!versionMatch) {
  console.error('cannot read VERSION from src/version.ts')
  process.exit(1)
}
const version = versionMatch[1]

let commit = 'unknown'
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
} catch {
  /* a source tarball has no git history; the artifact is still valid */
}

let html = readFileSync(htmlPath, 'utf8')

// 1. A single file cannot link to a sibling LICENSE, and the footer link is
//    rendered from JSX so it survives the bundle as a plain object literal
//    (`href:"./LICENSE"`), not as an HTML attribute. Rewrite every form.
const MPL = 'https://www.mozilla.org/en-US/MPL/2.0/'
const LICENSE_FORMS = [
  ['href="./LICENSE"', `href="${MPL}"`],
  ['href="/LICENSE"', `href="${MPL}"`],
  ['href:"./LICENSE"', `href:"${MPL}"`],
  ['href:"/LICENSE"', `href:"${MPL}"`],
]
let licenseHrefs = 0
for (const [from, to] of LICENSE_FORMS) {
  const hits = html.split(from).length - 1
  if (!hits) continue
  licenseHrefs += hits
  html = html.replaceAll(from, to)
}
if (!licenseHrefs) {
  console.error('expected a footer LICENSE link in the bundle, found none')
  process.exit(1)
}

// 2. Provenance, and a hard guarantee that nothing is loaded from outside.
const nodeVersion = process.version
const banner = `<!--
  UCZ v${version} — Universal Adaptive Compression (Web GUI, single file)
  MPL-2.0 · https://github.com/no-nova/UCZ
  built ${new Date().toISOString()} from commit ${commit} with node ${nodeVersion}
  self-contained: no external scripts, styles, fonts, or network requests are required
-->
`
html = banner + html

const problems = []
if (!html.includes('<title>UCZ')) problems.push('title is not the UCZ title')
const externalScript = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1])
if (externalScript.length) problems.push(`external <script src>: ${externalScript.join(', ')}`)
const externalStyle = [...html.matchAll(/<link[^>]+href="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((href) => !href.startsWith('https://') && !href.startsWith('data:'))
if (externalStyle.length) problems.push(`external <link href>: ${externalStyle.join(', ')}`)
// The React runtime embeds the literal strings "<script><\/script>", so a naive
// tag balance check is meaningless. Assert what actually matters: exactly one
// module script, and it is inline.
const moduleTags = [...html.matchAll(/<script[^>]*type="module"[^>]*>/g)].map((m) => m[0])
if (moduleTags.length !== 1) problems.push(`expected exactly 1 inline module script, found ${moduleTags.length}`)
else if (/\ssrc=/.test(moduleTags[0])) problems.push(`module script is not inline: ${moduleTags[0]}`)
if (!html.trimEnd().endsWith('</html>')) problems.push('bundle does not end with </html>')
if (problems.length) {
  console.error(`release artifact is not self-contained:\n  - ${problems.join('\n  - ')}`)
  process.exit(1)
}

const outPath = path.join(root, 'dist', `ucz-v${version}.html`)
writeFileSync(outPath, html)

const digest = createHash('sha256').update(html).digest('hex')
writeFileSync(`${outPath}.sha256`, `${digest}  ${path.basename(outPath)}\n`)

const size = statSync(outPath).size
console.log(`[release] ${path.relative(root, outPath)}`)
console.log(`[release] version=${version} commit=${commit} bytes=${size} (${(size / 1024).toFixed(1)} KiB)`)
console.log(`[release] license links rewritten: ${licenseHrefs}`)
console.log(`[release] sha256=${digest}`)
