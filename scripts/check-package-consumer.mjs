// Release gate: install the packed tarball into a fresh ESM project and compile
// a real consumer with `module: NodeNext`. This catches declaration graphs that
// work under `moduleResolution: bundler` but fail for NodeNext users.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const tmp = mkdtempSync(join(tmpdir(), 'ucz-consumer-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

try {
  const packed = JSON.parse(execFileSync(npm, [
    'pack', '--json', '--ignore-scripts', '--pack-destination', tmp,
  ], { cwd: root, encoding: 'utf8' }))
  const entry = Array.isArray(packed) ? packed[0] : Object.values(packed)[0]
  if (!entry?.filename) throw new Error('npm pack did not report a filename')
  const tarball = join(tmp, entry.filename)

  const project = join(tmp, 'consumer')
  mkdirSync(project)
  writeFileSync(join(project, 'package.json'), JSON.stringify({
    name: 'ucz-node-next-consumer', private: true, type: 'module',
  }, null, 2))

  execFileSync(npm, [
    'install', tarball, '--silent', '--no-audit', '--no-fund', '--ignore-scripts',
  ], { cwd: project, stdio: 'inherit' })

  writeFileSync(join(project, 'consumer.ts'), `import { compressAdaptive, decompress, VERSION } from 'ucz'
const encoded = await compressAdaptive(new Uint8Array([1, 2, 3]))
const decoded = decompress(encoded.container)
if (decoded.length !== 3) throw new Error('roundtrip failed')
console.log(VERSION, encoded.container.length, decoded.length)
`)
  writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: false,
      noEmit: true,
    },
    include: ['consumer.ts'],
  }, null, 2))

  const tsc = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
  execFileSync(tsc, ['-p', 'tsconfig.json'], { cwd: project, stdio: 'inherit' })
  console.log('NodeNext consumer compile: OK')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
