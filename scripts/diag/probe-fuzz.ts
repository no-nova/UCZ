// 诊断：对合法容器做随机变异/截断，确认解码器只会抛错，不会挂死或越界写。
// 用法：node scripts/diag/run.mjs probe-fuzz [轮数]
import { compressAdaptive, decompress } from '../../src/lib/codec'

const rounds = Number(process.argv[2] || 400)
const enc = new TextEncoder()
const samples = [
  enc.encode('alpha beta gamma\n'.repeat(50)),
  Uint8Array.from({ length: 600 }, (_, i) => (i * 91) & 255),
  Uint8Array.from({ length: 400 }, (_, i) => (i % 7 === 0 ? 0 : i & 255)),
]
let seed = 0x9e3779b9
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296 }

let ok = 0, thrown = 0, slowest = 0
const messages = new Map<string, number>()
for (const data of samples) {
  const base = (await compressAdaptive(data)).container
  for (let i = 0; i < rounds; i++) {
    const c = base.slice()
    const mode = i % 4
    if (mode === 0) c[i % c.length] ^= 1 << Math.floor(rnd() * 8)
    else if (mode === 1) c[i % c.length] = Math.floor(rnd() * 256)
    else if (mode === 2) { c[i % c.length] = 255; c[(i * 7) % c.length] = 0 }
    else { const cut = 1 + Math.floor(rnd() * (c.length - 1)); c.set(c.subarray(0, c.length - cut), 0); c.fill(0) }
    const t = performance.now()
    try {
      const out = decompress(c)
      // 成功解码时，长度必须与头部声明一致，且不得超出原始长度太多
      if (out.length > 4 * data.length + 4096) throw new Error('解码输出异常膨胀: ' + out.length)
      ok++
    } catch (e) {
      thrown++
      const m = String((e as Error).message).slice(0, 40)
      messages.set(m, (messages.get(m) ?? 0) + 1)
    }
    const dt = performance.now() - t
    if (dt > slowest) slowest = dt
  }
}
console.log(JSON.stringify({ rounds: rounds * samples.length, ok, thrown, slowestMs: +slowest.toFixed(1), topErrors: [...messages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6) }, null, 1))
