import { gzipSync } from 'node:zlib'

/**
 * Traditional GZIP-NCD baseline (`zlib.gzipSync(level 9)`).
 *
 * Lives outside `ncd.ts` because that module is bundled into the browser build
 * and a static `node:zlib` import would break the Web bundle. Node-only tools
 * (`ucz ncd`, scientific tests) import this file instead.
 */
export function computeGzipNCD(x: Uint8Array, y: Uint8Array, maxBytes = 32768): number {
  const wx = representative(x, maxBytes), wy = representative(y, maxBytes)
  const cx = gzipSync(wx, { level: 9 }).length
  const cy = gzipSync(wy, { level: 9 }).length
  const cxy = gzipSync(concat(wx, wy), { level: 9 }).length
  const cyx = gzipSync(concat(wy, wx), { level: 9 }).length
  return Math.max(0, (Math.min(cxy, cyx) - Math.min(cx, cy)) / Math.max(cx, cy))
}

/**
 * Prefix window, mirroring `representative()` in `ncd.ts`: the head carries the
 * syntax/table preamble, which is the part two files of the same family share.
 */
function representative(d: Uint8Array, maxBytes: number): Uint8Array {
  return !maxBytes || d.length <= maxBytes ? d : d.subarray(0, maxBytes)
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}
