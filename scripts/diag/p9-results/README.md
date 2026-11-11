# P9 持久测量记录

这里存小型、受 Git 保护的证据；**不存语料或压缩载荷**。不要再将 `/tmp/p9-ab` 当唯一存储。
入口是 `npm run diag:p9 -- ...`，恢复交接见项目根目录 `P9_STATUS.md`。

## 保存/续跑保证与边界

- 默认**最多新测 1 项**（一个配置 × 一个文件切片），默认单项 **300 秒**上限。
- 每 15 秒输出等待心跳。结束时提交并推送本目录，成功后才能开始下一项。
- 每项成功须完成 `compressAdaptive` / `decompress` 逐字节比对；结果先 fsync，再同目录 rename。
- 文件名为任务身份的 SHA-256；身份包含源码内容指纹、输入整文件/切片 SHA-256、偏移、切片大小、全部旋钮、Node/V8 版本和显式 `P9_TRIAL`。容器 SHA-256、环境和耗时也记录在结果中。
- 只复用内容校验通过、`verified: true`、身份完全匹配的记录。标签不参与身份，改标签不会重新编码。
- Git commit ID 仅记录来源，不参与缓存键。仅提交结果/报告不会让所有样本重测。
- 已失败/超时项默认拒绝自动重试；必须 `--retry-failed`。损坏 JSON 或校验失败直接报错，不能静默覆盖。
- 进程互斥防止重复运行；boot_id + PID + 启动 tick 区分旧沙箱的残留锁。若锁自身损坏，停止检查，不盲目抢锁。
- 默认入口将小型记录提交并推送到固定分支 `arena/1220f47e-test`。有暂存改动、源码未提交、推送失败时停止；不自动提交源码，不强推。
- `--local-only` **不提供远端备份**，只用于开发测试。直接运行老入口 `run.mjs probe-p9-ab` 也只原子保存，不具备父驱动的超时/心跳/远端保存功能。

这不能修复 Arena 服务端/界面的超时，也不能保证正在编码的一项在进程被强杀后接着编码。
**正常续跑会跳过已推送的完成项，只重做未完成项。** 若恰好死在落盘与推送之间，本地记录仍在时可补推；若连工作区一起被回收，该项仍可能需要重跑。

## 命令（从项目根目录）

```bash
# 恢复依赖（node_modules 是可重建缓存）
npm ci --no-audit --no-fund

# 只查状态，不编码/提交/推送；语料不在也能看到历史证据
npm run diag:p9 -- --status --bytes 2097152

# 实际语料放项目 .diag-data/corpus（Git 忽略），或显式传 P9_CORPUS
# 以下命令每次至多新完成一项；再次执行同一命令会从剩余项继续
P9_LABEL=p9-a2off npm run diag:p9 -- --bytes 2097152 mozilla samba webster dickens osdb ooffice

# 严格单变量：旋钮快照自动记录；当前 a2 默认值仍为之前待定的 false
P9_LABEL=p7-knobs P9_SET='a2Tuning.textOn=true' npm run diag:p9 -- --bytes 2097152
P9_LABEL=3a P9_SET='planTuning.dropZeroHitIds=true,planTuning.dropLegacyV12Ids=false' npm run diag:p9 -- --bytes 2097152
P9_LABEL=3b P9_SET='planTuning.dropZeroHitIds=false,planTuning.dropLegacyV12Ids=true' npm run diag:p9 -- --bytes 2097152
P9_LABEL=3ab P9_SET='planTuning.dropZeroHitIds=true,planTuning.dropLegacyV12Ids=true' npm run diag:p9 -- --bytes 2097152
P9_LABEL=big22 P9_SET='modelTuning.maxTableBits=22' npm run diag:p9 -- --bytes 4194304

# 已知失败项须明确重试；调整单项上限不要改成一个无界总批次
npm run diag:p9 -- --bytes 4194304 --retry-failed --timeout 600 ooffice

# 需要独立时间复测时显式区分 trial；不要靠改 label 绕过缓存
P9_TRIAL=timing-2 npm run diag:p9 -- --bytes 2097152 dickens

# 快速恢复机制测试（临时合成数据，不是 P9 压缩收益验收）
npm run test:p9-recovery

# 验证真实落盘/推送链路的 4 KiB 合成样本，重复命令应显示 cached
P9_CORPUS=scripts/diag/fixtures P9_LABEL=recovery-smoke npm run diag:p9 -- --bytes 4096 recovery-smoke.txt
```

`--status` 的 `saved` 表示记录内容已校验，但 `inputRechecked: false` 不代表重新检查了当前语料。
有语料时，后续 `cached` 才表示输入/源码/旋钮全部吻合。缺失语料报告 `missing-input`，不会假装测完。
`.diag-data/` 的大语料是可重建缓存，不提交到 Git；标准 Silesia 文件还会核对 `baseline.json` 的大小和 SHA-256。
不能根据单次、不匹配运行环境的 `encMs` 声称编码提速百分比。

## 文件与证据资格

- `<64 位 key>.json`：完成记录，含 `recordSha256` 自校验和来源信息。
- `jobs/<key>.json`：启动/失败/超时等状态，不是成功证据。`running` 若没有结果只能表示曾启动过。
- `*.tmp`：中断残留临时文件，Git 忽略，绝不能提升成完成记录。
- `.diag-state/`：本地锁及简短日志，Git 忽略；成功证据不依赖它存活。
- `input.kind = custom` / `label = recovery-smoke`：恢复测试数据，**不得纳入 Silesia 收益表**。

旧聊天和提交说明中的 P9 数字不伪造成完成记录。缺少原始 JSON 的历史结果保持“未迁入/未复测”状态。
独立审计原文与三份拆分报告在 `docs/audits/`，已经保存，不必再次上传。

## 汇总已保存的同源对照（不编码）

`node scripts/diag/summarize-p9.mjs <基线key或JSON路径> <对照key或路径> ...`

- 先校验每份记录的内容摘要、verified 标志、头/载荷/实际容器总账。
- 必须同源码、同输入（包含 offset）、同运行时和串行选项，否则拒绝混表。
- 列出真实容器差值、头成本、时间、RSS、全部旋钮差异和实际分组字典。
- `node --test tests/p9-summary.test.mjs` 是快速汇总校验，不重复压缩。
- 当前首批表与解读：`docs/audits/P9_MEASUREMENTS.md`。
