import assert from 'node:assert'

/** P24.6: `assert.deepEqual` on two byte arrays of equal length that differ runs a
 * line-based Myers diff. On a 32 KiB binary payload that allocates gigabytes and can
 * take the whole machine down with it, so byte streams get a fail-fast O(n) compare
 * that reports the first differing offset instead. Everything else still goes through
 * the regular deep comparison (optionally with a message). */
export function fastDeepEqual(a: unknown, b: unknown, message?: string | Error): void {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    const prefix = message ? `${typeof message === 'string' ? message : message.message}: ` : ''
    if (a.length !== b.length) assert.fail(`${prefix}字节长度不同 ${a.length} != ${b.length}`)
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) assert.fail(`${prefix}第 ${i} 字节不同 ${a[i]} != ${b[i]}`)
    return
  }
  assert.deepEqual(a as never, b as never, message)
}
