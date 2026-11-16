/**
 * CRC-32C (Castagnoli, poly 0x1EDC6F41 reflected = 0x82F63B78).
 *
 * Used only for *accidental corruption detection* of the decompressed payload.
 * It is not a MAC and does not authenticate anything: an attacker can rewrite
 * the payload and recompute the crc. Do not describe it as tamper protection.
 */

const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? (0x82f63b78 ^ (c >>> 1)) >>> 0 : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

/** Running CRC-32C over `data`, starting from `seed` (use 0xffffffff to begin). */
export function crc32cUpdate(data: Uint8Array, seed = 0xffffffff): number {
  let c = seed >>> 0
  for (let i = 0; i < data.length; i++) c = (TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)) >>> 0
  return c >>> 0
}

/** Finalised CRC-32C of `data` (standard init/xorout). */
export function crc32c(data: Uint8Array): number {
  return (crc32cUpdate(data) ^ 0xffffffff) >>> 0
}

/** Big-endian 4-byte trailer, the form stored at the end of a v24 container. */
export function crcTrailer(value: number): Uint8Array {
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
}

export function readCrcTrailer(c: Uint8Array, at: number): number {
  return (((c[at] << 24) | (c[at + 1] << 16) | (c[at + 2] << 8) | c[at + 3]) >>> 0)
}
