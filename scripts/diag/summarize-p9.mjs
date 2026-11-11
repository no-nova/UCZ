// 从已校验的持久结果生成同源/同输入对照，不编码、不提交、不能混合切片。
// node scripts/diag/summarize-p9.mjs <baseline-key|json-path> <variant-key|json-path> ...
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonical, loadResult, RESULT_DIR } from './p9-checkpoint.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
if (args.length < 2) throw new Error('需要基线和至少一项对照的 key 或 JSON 路径')
const records = []
for (const arg of args) {
  const path = /^[a-f0-9]{64}$/.test(arg) ? join(root, RESULT_DIR, `${arg}.json`) : resolve(arg)
  const raw = JSON.parse(await readFile(path, 'utf8'))
  const d = await loadResult(path, raw.identity)
  if (d.identity.input.kind !== 'Silesia') throw new Error('收益表只接受标准 Silesia；合成恢复测试不能混入')
  assert.equal(d.header + d.groups.reduce((n, g) => n + g.payloadBytes, 0), d.ucz, '头与载荷之和必须等于实际容器')
  const m = d.macroComparison
  if (m) {
    assert.ok(d.ucz <= m.baselineBytes, '宏门完整容器必须不回退')
    assert.equal(d.ucz, m.accepted ? m.candidateBytes : m.baselineBytes)
    assert.equal(d.header, m.accepted ? m.candidateHeaderBytes : m.baselineHeaderBytes)
    assert.equal(d.ver, m.accepted ? m.candidateVersion : m.baselineVersion)
    if (m.accepted) assert.ok(m.candidateBytes < m.baselineBytes, '相等也应保留原方案')
  }
  records.push(d)
}
const base = records[0]
for (const d of records.slice(1)) {
  for (const field of ['sourceSha256', 'input', 'runtime', 'encodeOptions']) {
    assert.equal(canonical(d.identity[field]), canonical(base.identity[field]), `${field} 不同，拒绝混表`)
  }
  assert.equal(d.environment.cpu, base.environment.cpu, 'CPU 型号不同，拒绝混表')
  assert.equal(d.environment.logicalCpus, base.environment.logicalCpus, 'CPU 数不同，拒绝混表')
}
function differences(a, b, prefix = '') {
  const out = []
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const path = prefix ? `${prefix}.${key}` : key
    if (a[key] && b[key] && typeof a[key] === 'object' && typeof b[key] === 'object') {
      out.push(...differences(a[key], b[key], path))
    } else if (a[key] !== b[key]) out.push(`${path}: ${JSON.stringify(a[key])} → ${JSON.stringify(b[key])}`)
  }
  return out
}
const signed = n => n > 0 ? `+${n}` : String(n)
console.log(`输入：${base.file}，offset=${base.identity.input.offset}，n=${base.n} B。`)
console.log(`切片 SHA-256：\`${base.sha256}\`。`)
console.log(`共同源码 SHA-256：\`${base.identity.sourceSha256}\`。`)
console.log('基线为表中第一行，配置名称不代表另跑了冻结 P7 Git 源码。所有记录均已通过内容校验和与逐字节往返。\n')
console.log('| 配置 / trial | 容器 B | Δ B | Δ % | 头 B | 版本 / 模型标志 | 编码 s | 解码 s | 峰值 RSS MiB |')
console.log('| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |')
for (const d of records) {
  const delta = d.ucz - base.ucz
  console.log(`| ${d.label} / ${d.identity.trial} | ${d.ucz} | ${signed(delta)} | ${signed(+(delta / base.ucz * 100).toFixed(3))} | ${d.header} | ${d.ver} / ${d.modelFlags ?? '无'} | ${(d.encMs / 1000).toFixed(3)} | ${(d.decMs / 1000).toFixed(3)} | ${d.maxRSSMiB} |`)
}
console.log('\n各行只是一次运行；时间和 RSS 是诊断观测，不能据此断言稳定提速或外推全语料。Δ % 的分母是基线容器，不是原始输入。\n')
for (const d of records) {
  console.log(`- **${d.label} / ${d.identity.trial}**：\`${d.key}\``)
  const changes = differences(base.knobs, d.knobs)
  console.log(`  - 相对基线旋钮：${changes.length ? changes.map(s => `\`${s}\``).join('；') : '无'}`)
  console.log(`  - 字典载荷：${d.groups.map(g => `id=${g.id}/s=${g.s}/r=${g.r}/v15=${g.v15}/wordPre=${g.wordPre}: ${g.payloadBytes} B`).join('；')}`)
  const m = d.macroComparison
  if (m) {
    console.log(`  - 宏门完整容器：${m.baselineBytes} → ${m.candidateBytes ?? '未完成'} B；${m.accepted ? '采用' : '保留原方案'}；复用完整探针载荷=${m.reusedProbePayload}`)
    if (m.error) console.log(`  - 宏候选异常（不能当成成功收割）：${m.error}`)
  } else if (d.knobs.planTuning.macroUniformGate) {
    console.log(`  - 宏门：${d.macroComparison === null ? '未提出候选，仅编码原方案' : '历史记录未提供完整容器回退收据'}`)
  }
}
