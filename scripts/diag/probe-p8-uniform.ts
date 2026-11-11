// P8-环节三/五 探针：整份文件“一个段 + 一个恒等规则”对照。
//
// 512 KiB 切片上的神谕实验说明“纯恒等常常打平甚至打赢整条流水线”，
// 但切片不能外推：这里对**整份文件**直接算 TEXT_V3 / BIN_V3 单段方案的真实容器字节，
// 与线上流水线的实测容器字节并列，量出“分段+选规则”这套机器在整份文件上到底值不值。
//
// 用法：node scripts/diag/run.mjs probe-p8-uniform [文件...]
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { analyze } from '../../src/lib/analyze'
import { evaluatePlan, ID } from '../../src/lib/codec'

const files = process.argv.slice(2).length ? process.argv.slice(2) : ['mozilla', 'samba', 'webster', 'osdb', 'dickens']
await mkdir('/tmp/p8-uniform', { recursive: true })
for (const f of files) {
  const data = await readFile('/tmp/corpus/' + f)
  const n = data.length
  const t0 = Date.now()
  const an = analyze(data)
  const out: Record<string, unknown> = { file: f, n, analyzeSegs: an.segs.length, ms: {} as Record<string, number> }
  for (const [name, id] of [['TEXT_V3', ID.TEXT_V3], ['BIN_V3', ID.BIN_V3]] as [string, number][]) {
    const t = Date.now()
    try {
      const c = evaluatePlan(data, [{ start: 0, end: n, cls: 'text', spec: { id, s: 1, r: 1 } }])
      out[name] = { bytes: c.totalBytes, header: c.headerBytes, payload: c.payloadBytes, groups: c.groupCount }
    } catch (e) { out[name] = { error: String((e as Error).message).slice(0, 100) } }
    ;(out.ms as any)[name] = Date.now() - t
  }
  out.ms.total = Date.now() - t0
  await writeFile(`/tmp/p8-uniform/${f}.json`, JSON.stringify(out))
  console.log(JSON.stringify(out))
}
