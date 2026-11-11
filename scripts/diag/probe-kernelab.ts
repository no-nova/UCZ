// P5-1：v15 内核各开关在图像残差（res / res2d）上的端到端 A/B。
//
// 背景：本机全量显示 mr / x-ray 相对 P2 回退（mr +13,923 B、x-ray +4,479 B）。
// 择优是"严格更小才替换"，所以回退只可能来自 **v15 候选本身变差**（P4-1 的
// a2 级联 / mht8），而不是选择逻辑。这里把三个开关拆开逐一实测。
//
// 用法：node scripts/diag/run.mjs probe-kernelab <文件> [起始偏移] [长度]
import { readFile } from 'node:fs/promises'
import { compressAdaptive, decompress } from '../../src/lib/codec'
import { apm2Tuning, setNoMht8 } from '../../src/lib/coder'

const args = process.argv.slice(2)
const file = args[0] ?? '/tmp/corpus/mr'
const start = Number(args[1] ?? 0)
const len = Number(args[2] ?? 1024 * 1024)
const raw = await readFile(file)
const data = raw.subarray(start, Math.min(raw.length, start + len))

type Cfg = { name: string; a2: boolean; mht8: boolean }
// 两个配置即可回答问题：a2 开 / 关（mht8 只对 text/bin 有意义，res2d 不分配）。
// 加 --full 跑全部组合。
const full = args.includes('--full')
const configs: Cfg[] = full
  ? [
    { name: 'a1 only（mht8 关）', a2: false, mht8: false },
    { name: 'a1+mht8 = P3', a2: false, mht8: true },
    { name: 'a1+a2（mht8 关）', a2: true, mht8: false },
    { name: 'a1+a2+mht8 = 当前 P4', a2: true, mht8: true },
  ]
  : [
    { name: 'a1 only（P2 行为）', a2: false, mht8: true },
    { name: 'a1+a2（P4-1 行为）', a2: true, mht8: true },
  ]

const rows: Record<string, unknown>[] = []
for (const c of configs) {
  // 注意：这些开关都是"构造 Model 时读取"的全局量，进程内切换是安全的。
  apm2Tuning.on = c.a2
  setNoMht8(!c.mht8)
  const t0 = performance.now()
  // 必须串行：并行分组在 worker 进程里跑，全局开关不会跨线程同步。
  const comp = await compressAdaptive(data, undefined, { serial: true })
  const ms = performance.now() - t0
  const ok = Buffer.from(decompress(comp.container)).equals(Buffer.from(data))
  rows.push({ cfg: c.name, a2: c.a2, mht8: c.mht8, bytes: comp.container.length, ver: comp.container[3], ms: Math.round(ms), verified: ok })
}
apm2Tuning.on = true
setNoMht8(false)
console.log(JSON.stringify({ file: file.split('/').pop(), start, len: data.length, rows }, null, 1))
