import { readFile, stat } from 'node:fs/promises'
import { compressAdaptive, decompress, singleModelSize } from '../src/lib/codec'
import { runBenchmarks } from '../benchmark/algorithms.mjs'

async function main() {
  const args = process.argv.slice(2)
  const filename = args.find(a => !a.startsWith('--'))
  if (!filename) throw new Error('用法: npm run bench -- <文件路径> [--single] [--no-external] [--verbose]')
  const info = await stat(filename)
  if (info.size > 256 * 1024 * 1024) throw new Error('命令行基准目前限 256 MiB；避免系统内存不足。')
  const data = await readFile(filename)
  console.log(`文件: ${filename}\n原始: ${data.length} B`)
  let last = 0
  const t = performance.now()
  const comp = await compressAdaptive(data, (msg, pct) => {
    if (performance.now() - last >= 1500) { console.log(`${pct.toFixed(1)}% ${msg}`); last = performance.now() }
  })
  const encodeMs = performance.now() - t
  const t2 = performance.now(), back = decompress(comp.container)
  const verified = data.equals(Buffer.from(back.buffer, back.byteOffset, back.byteLength))
  const decodeMs = performance.now() - t2
  console.log(`UCZ: ${comp.container.length} B, ${(comp.container.length / Math.max(1, data.length) * 100).toFixed(2)}%, 压缩 ${(encodeMs / 1000).toFixed(2)}s, 解码 ${(decodeMs / 1000).toFixed(2)}s, 校验 ${verified ? '通过' : '失败'}, 区域 ${comp.segs.length}, 头部 ${comp.overhead} B`)
  if (!verified) throw new Error('无损校验失败')
  if (comp.segs.length <= 20 || args.includes('--verbose')) for (const [i, sg] of comp.segs.entries()) {
    console.log(`  区域 ${i + 1}: ${sg.start}..${sg.end} → ${sg.label}, ${sg.compLen} B`)
    if (sg.subPeel) console.log(`    子通道: ${JSON.stringify(sg.subPeel)}`)
    if (sg.peel) for (const col of sg.peel) console.log(`    剥离列 ${col.column}: ${col.rawLen} → ${col.payloadSize} B; ${col.regions.map(r => `[${r.start},${r.end}) ${r.terrain} → ${r.rule} ${r.payloadSize} B`).join(' | ')}`)
    console.log(`    试探: ${sg.trials.map(t => `${t.label} ${t.payloadSize}/${t.sampleLen} B${t.fullSize !== undefined ? ` (完整区域 ${t.fullSize} B)` : ""}`).join(' | ')}`)
  }
  if (args.includes('--single') || data.length <= 10 * 1024 * 1024) {
    const start = performance.now(), size = singleModelSize(data, args.includes('--single') ? Infinity : undefined)
    console.log(`单一 CM: ${size} B, ${((performance.now() - start) / 1000).toFixed(2)}s`)
  } else console.log('单一 CM：超过 10 MiB 已跳过（使用 --single 强制运行）')
  if (!args.includes('--no-external')) await runBenchmarks(data, (r: {label:string; size?:number; encodeMs?:number; ms?:number; verified?:boolean; error?:string}) => {
    console.log(r.error ? `${r.label}: 不可用 (${r.error})` : `${r.label}: ${r.size} B, ${(r.size! / Math.max(1, data.length) * 100).toFixed(2)}%, 压缩 ${(r.encodeMs! / 1000).toFixed(2)}s, 端到端 ${(r.ms! / 1000).toFixed(2)}s, 校验 ${r.verified ? '通过' : '失败'}`)
    if (!r.error && !r.verified) process.exitCode = 1
  })
  console.log(`进程 RSS ${(process.memoryUsage().rss / 1048576).toFixed(1)} MiB（非峰值）`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
