import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const base = '38d5a01b61c4810936dd9b92d9b2abdb5145284c0204dcf82091dbe3d4360de9'
const alt = 'fcd30e76de95b91651d39667b71d37c876f9110e0b6ccff7aa83ce0c5fc75e5e'
const otherInput = '1b68ae349b7404d67f94e4bc916e706c57a56644631d7d73a82b662ffc4d5f3e'
const summary = (...args) => execFileSync(process.execPath, ['scripts/diag/summarize-p9.mjs', ...args], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
})

test('same-source/input records show true container and header costs', () => {
  const text = summary(base, alt)
  assert.match(text, /\| 268194 \| -9641 \| -3\.47 \| 20 \| 15/)
  assert.match(text, /planTuning\.v15SinglePlain: false → true/)
})
test('different inputs cannot be compared as an isolated A/B', () => {
  assert.throws(() => summary(base, otherInput), e => e.status !== 0 && /input 不同/.test(String(e.stderr)))
})
test('a tampered measurement is rejected, never silently used', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p9-summary-test-'))
  try {
    const d = JSON.parse(readFileSync(join(root, `scripts/diag/p9-results/${alt}.json`), 'utf8'))
    d.ucz++
    const path = join(dir, 'corrupt.json')
    writeFileSync(path, JSON.stringify(d))
    assert.throws(() => summary(base, path), e => e.status !== 0 && /无效检查点/.test(String(e.stderr)))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
