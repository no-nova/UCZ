// 诊断：追踪单个大区域的候选采样比与探针结果，定位“探针没纠正选择”的原因。
// 用法：node scripts/diag/run.mjs probe-trace <文件>
import { readFile } from 'node:fs/promises'
import { compressAdaptive } from '../../src/lib/codec'

const data = await readFile(process.argv[2] ?? '/tmp/corpus/nci')
const comp = await compressAdaptive(data)
for (const [i, s] of comp.segs.entries()) {
  if (s.end - s.start < 1024 * 1024) continue
  console.log(`区域 ${i} ${s.start}..${s.end} (${(s.rawLen/1048576).toFixed(1)} MiB) cls=${s.cls} → ${s.label}`)
  for (const t of s.trials.slice(0, 8)) {
    console.log(`  ${t.label.padEnd(22)} ratio=${(t.ratio*100).toFixed(2)}% sample=${t.payloadSize} probe=${t.probeSize ?? '-'} full=${t.fullSize ?? '-'}`)
  }
}
