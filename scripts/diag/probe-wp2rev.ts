// 自检：WORD-PRE v2 与 LZ-PRE 的可逆性（与 tests 里新增的用例同源）。
import { wordPreFwd2Sampled, wordPreInv2 } from '../../src/lib/wordpre'
import { lzPreFwd, lzPreInv } from '../../src/lib/lzpre'
const enc = new TextEncoder()
const sample = enc.encode('the quick brown fox jumps over the lazy dog. '.repeat(400))
const wp2 = wordPreFwd2Sampled(sample, 64 * 1024)
const okWp = wp2 ? Buffer.from(wordPreInv2(wp2.header, wp2.body, sample.length)).equals(Buffer.from(sample)) : false
const lz = lzPreFwd(sample)
const okLz = Buffer.from(lzPreInv(lz.body, sample.length, lz.esc)).equals(Buffer.from(sample))
const esc = Uint8Array.from({ length: 4096 }, (_, i) => (i % 7 === 0 ? 0x9c : (i * 31) & 127))
const lz2 = lzPreFwd(esc)
const okLz2 = Buffer.from(lzPreInv(lz2.body, esc.length, lz2.esc)).equals(Buffer.from(esc))
console.log({ one: wp2?.dict.one.length, two: wp2?.dict.two.length, okWp, okLz, okLz2, lzEsc: lz.esc })
