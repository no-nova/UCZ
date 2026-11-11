# P13.1：XML WORD-PRE 准入回退修复

> 后续本机验收已完成：用户报告 P13.1 **12/12 PASS / 40,233,692 B / 编码 1,687.0 s**，XML 恢复 339,516 B。新硬基线见 [P13_IMPLEMENTATION.md](P13_IMPLEMENTATION.md)。以下“尚待验收”描述保留为修复当时的历史证据边界，已被本轮报告取代。


分支 `arena/1220f47e-test`。用户本机 P13 `51ced1f` 报告 **11/12 PASS**，不是完整验收；硬基线仍为 P12 `d9b84df` 的 **40,297,869 B**，逐文件 1 B 回退不允许抵消。

## 用户报告与证据边界

- ooffice：1,955,064 → **1,890,887 B**（-64,177 B）；xml：339,516 → **351,805 B**（+12,289 B）。另十个文件字节不变；总量 **40,245,981 B**。
- 用户此次报告编码行时 2137.5 → 1789.2 s（-348.3 s，约 -16.29%），还未达到 -35%。此前归档的 P12 行时之和是 2137.2 s；差 0.3 s 的两个报告并列保留，不悄悄改写历史字段。
- 原始 JSON、运行源码 SHA、完整机器/Node/命令未上传；结构化转录见 `scripts/diag/p131-results/user-local-51ced1f.json`。没有拿用户报告冒充 Arena 重测。
- **40,233,692 B / 12 PASS 是仅把 xml 恢复后的反事实计算，不是修复后实测。** 本轮禁止完整 XML/NCI/全 Silesia CM 编码；只做至多 192 KiB 的决策编码及有界回归。

## 诊断：实际 P12 代码与两个独立失真因素

核对 `d9b84df..51ced1f`：P12 `wordPreTry` 取连续 **192 KiB raw 前缀**，按完整组的同一词表重新分词，再以 `wordTokens=true` 编码正文，与同内核 raw 前缀比较，严格 `< plain * 0.99`。**并非取完整 token 流的前 192 KiB 与等长 raw 字节对比**；后者覆盖不同数量的原文，不能替代实际 P12 逻辑。

P13 的大组分支改成了头/中/尾代表样本，并通过 `encodeWordPrePayload` 把词典也放进样本的 CM 数据流，同时计算长度前缀/外层头。完整候选正确地需要这些成本，但把它们带进局部准入门，会放大一次性开销，也改变 CM 热身。实际词典是 **xml 主组 554 B、macro 非 FILL 组 559 B、nci 423 B**，不是预设的约 1.6 KB；不是简单将原始词典长度加在压缩样本上。

### SHA 校验的真实输入，停止在任何完整 CM 之前

`prepare` 仅做原文读取、SHA、`analyze()`、建词表/整组 tokenization，**不导入 CM 编码器**。派生组：

| 输入 | 派生 raw B | 分片 | token body B | 词典 B |
|---|---:|---:|---:|---:|
| xml-main：全部 analyze 文本段 | 5320900 | 19 | 3990596 | 554 |
| xml-macro：全部非 FILL 段 | 5339332 | 37 | 4007386 | 559 |
| nci-main：唯一文本段 | 33553445 | 1 | 10920511 | 423 |

这是可复现的主组/宏组假设，不是补跑未知的用户最终选型目录。XML 尾部 5948 B FILL 保留在组外；无需完整 chooser 或完整 CM 即可重现错误准入。

`run.mjs` 从 Git 抽取原生产 gate 语句，只在临时副本导出决策入口；P12 在准入判断后、完整编码前停止。所有副本的 `encodeCM` 入口强制拒绝 **>196608 B** 的输入，记录每个 CM 调用的长度/内核/wordTokens/载荷字节。源码、注入源码、脚本、bundle、预处理数据都有 SHA 回执；不输出完整容器，不报完整文件压缩大小。

### XML 主组：两因素消融

| 准入样本 / v20 | plain 成本 B | WORD-PRE 成本 B | 严格 1% 门 |
|---|---:|---:|---|
| P13 头/中/尾 + 词典/封装 | 18061 | 18278 | 拒绝 |
| 只去掉词典，仍头/中/尾（保留其它封装计价） | 18061 | 18037 | 仍拒绝 |
| 只改连续前缀，仍带词典/封装 | 8411 | 8504 | 仍拒绝 |
| P12 连续 raw 前缀 → 同词表坍缩，正文 CM 对比 | **8390** | **8250** | **通过** |

因此只去掉词典或只改窗口均不足；必须恢复两个维度。P12 v15 同样通过（8611 → 8401 B）。这是当前输入/固定词表的观测，不把不同窗口的绝对成本互相作压缩率收益比较。

XML macro 非 FILL 组：P13 v20 17946 → 18168 B，拒绝；P12 8387 → 8256 B，通过。NCI 在 P13 **本来就通过并筛选 v20**（10645 → 10037 B），P12 连续前缀也通过（9916 → 9106 B）。修复应恢复 XML，并保持 NCI 准入，不声称 NCI 原本也被拒绝。

### family / macro / worker 排查

- `unify.ts` 是家族表，实际筛选在 `codec.ts`。`sampleFamilyBytes` 用 raw base/v15/v20 比较合并计划，不直接做 WORD-PRE 准入；最终 separate/unified 都调用同一个 `groupV15Candidates`。
- XML 长度低于直接 macro 的 25 MiB 上限，文本占主导；分析派生的 TEXT/BIN/FILL 计划通过 `macroDirectSpec` 返回 TEXT_V3，**不走大 binary macro 的 192 KiB 前筛**。最终宏组仍进入相同 WORD-PRE 错误门；不应为了 XML 修改 BIN/macro 启发式。
- NCI 的分析结果只有一个文本组，macro 无需归并。实际用户最终分组目录未提供；以上是源码和明确派生计划的检查，不杜撰最终目录。
- worker 入口 `parallel-worker.ts` 仅转发 `runJob → encodeGroupForJob → groupV15CandidatesSync`，没有独立 WORD-PRE 策略。应修正共享实现并重建生成 worker，不能另写一套线程规则。

### 时限的真实记录

八个旧/消融决策进程为 1849–2715 ms；其中实际决策为 1578–2518 ms，均 <5 s；每个 CM 输入 <=192 KiB。首次 XML/NCI 的分析与词典准备分别为 5725/9642 ms（macro 5254 ms），不含 CM；**冷启动准备并非 <5 s，不能隐去**。后续决策复用 SHA 绑定的预处理缓存。每个命令均外包 `timeout --signal=KILL 19s`。

一次 harness 预检因 Git 子树路径缺少 `--full-tree` 停止，0 CM 调用；修正后再运行，记录在 `harness-preflight.json`。生产源码未受该工具错误影响。

## 诊断检查点（已提交 `3ecd75c`）

当时确认的修复范围：只替换大 TEXT_V3 的 WORD-PRE 准入，恢复实际 P12 连续 raw 前缀/正文比较；跟随 raw 筛选胜出的内核，明确 v20 时只准入/编码完整 WORD-PRE v20，歧义时保留现有候选比较策略。保留完整字典与容器严格择优，不改 BCJ/BIN 采样、码流数学、词典算法、小组 P12 路径。该诊断检查点没有修改生产源码；后续实际修复如下。


## 已实现的局部修复

1. `codec.ts` 新增共享的决策函数 `screenWordPreCandidates`，**只供大 TEXT_V3 的 WORD-PRE 分支调用**。保留 `>=32768`、坍缩率 `<=0.85`、严格正文 CM `<plain*0.99` 的 P12 门；使用现有 192 KiB 上限，不添加新启发式参数。
2. 不再拿头/中/尾 raw 内核样本决定是否采用 WORD-PRE，也不把词典/容器固定开销放入该局部门。按连续 raw 前缀、同词表重新分词，`wordTokens=true`、相同内核与 probe model scope 做比较。
3. WORD-PRE 跟随已经选出的 raw 内核。raw 明确选 v20 时只探测/调度完整 WORD-PRE v20，**不做多余的完整 WORD-PRE v15 编码**；raw 歧义时，对其候选做原 0.15% 清晰胜出比较。不是全局硬编码 v20。
4. 完整 `encodeWordPrePayload` 与最后的完整头/载荷择优没有改动：词典、4 B 长度字段、全部 CM 与 UCZ 头仍按真实成本收取，保留真实完整 base。准入并非无条件采用。
5. `group-policy.ts` 仅增加可结构化克隆的 `wordPreGate` 诊断类型，记录正文样本成本、字典长度和参与内核；**raw 代表采样器/胜出策略逐字节不变**。
6. worker 继续调用同一实现，只重建 `parallel-worker-code.ts`（82.4 KiB）；不另改 `parallel-worker.ts` 的转发逻辑。`coder.ts`、词典算法、变换、BCJ、BIN、family、macro、小组 WORD-PRE、缓存和解码规则均不变。

只读 `p131/verify.mjs --current` 除了核验三份最终决策源码 SHA，还对照 `51ced1f` 断言：去掉上述 WORD-PRE 分支/新增函数后，**整份 codec.ts 其余内容完全一致**；group-policy 的两个运行时函数一致；其它生产源文件一致（生成 worker 除外）。不是仅靠人工声称“没动 BCJ/BIN”。

### 修复后的生产函数决策（没有完整组编码）

| 输入 | v20 raw 前缀 CM B | v20 token 正文 CM B | 调度的完整 WP 内核 | 决策进程 ms |
|---|---:|---:|---|---:|
| xml-main | 8390 | 8250 | **仅 v20** | 2788 |
| xml-macro | 8387 | 8256 | **仅 v20** | 2835 |
| nci-main | 9916 | 9106 | **仅 v20** | 2419 |

三项与 P12 相应 v20 准入成本完全相同；raw 头/中/尾内核筛选成本也与 P13 旧结果一致。实际决策耗时分别 2650/2704/2185 ms，最大 CM 输入 196608 B。回执中的 `fullBytes` 表示**将调度**的组输入量，不是已编码的字节；`fullCMCalls=0`、`containerEmitted=false`、`fullFileBytesMeasured=false` 均明确记录。回执位于 `scripts/diag/p131-results/fixed/`。

## 有界回归与验证

- 新 `gate` 测试：直接 CM 成本与生产准入相同、词典长度扰动不污染局部门、只继承胜出内核、v15-only/null/坍缩率/长度门。新 `worker` 测试在 **256 KiB 合成文本**上验证真实 worker 的载荷/flags/成本/准入元数据，再把其回复送入生产恢复/完整容器择优路径，零 fallback、完整解码通过。该合成样本 raw 胜者是 v15，最终 109 B，亦验证没有强制所有文本使用 v20；不是全文件测量。
- 固定 XML 中段 **262144 B** 完整编码/解码：仍选 WORD-PRE v20，**4708 B**，SHA `e8f6e5f57d916b08205cb285ce934a498f2f4c4a2f0098145c1c19c51151eb77`，与既存 P12 oracle 完全一致。完整候选只有 base/raw-v20/WP-v20。回执 `scripts/diag/p13-results/p131-fixed/xml-mid-text-policy-current.json`，8397 ms。这不是用切片替代完整 XML 的 339516 B 验收。

| 检查 | 结果 / 命令耗时 ms |
|---|---|
| worker 重建 + 生产/诊断 TypeScript | PASS / 8217 |
| 新测试 TypeScript + gate + 最终决策回执核验 | PASS / 4884 |
| 新 256 KiB 真实 TEXT worker（最终测试源码） | PASS / 7533 |
| P13 policy + BCJ 缓存再准入 + 非零起点/接缝 | PASS / 10229 |
| P13 三个 BCJ ID 升级 + 家族复用 | PASS / 8138 |
| P13 256 KiB 四路 BCJ 真实 worker | PASS / 12647 |
| P13 BIN 筛选 + 真实 worker | PASS / 13043；仍为 37705 B |
| 历史独立解码 + 14 份冻结 v20 容器 + worker-plan | PASS / 6589 |
| 生产变更范围核验 + P9 defaults 14 项 | PASS / 7112 |
| `npm run check:worker` + `npm run build` + 基线/诊断 22 tests | PASS / 10005 |

一次测试 TypeScript 初查因 `reply.cand` 可能为 null 失败（TS18047）；补充运行时断言后重查并重跑 worker 通过，未修改生产逻辑。所有命令均有外层 19 s 上限；工具结果转录在 `p131-results/validation.json`，明确不是独立重跑证据。**完整 `test:codec` 未运行，完整 Silesia 未编码。**

最终 `src/lib` SHA：`3f6971ff4feff664f7fc16f50c6d89a7ac92622ee57d1b4c586ce52c722b62a3`。三份修复回执对应此工作源码；不会将记录里的父提交字段冒充为后来修复提交。P12 硬基线与全部历史测量保持不变。最终只读核验执行回执为 `p131-results/verification.json`；核验三组修复成本逐项等于历史 P12、raw 筛选成本等于 P13，并拒绝出现 WP-v15 探针。

### 复现命令（每条分别执行）

```bash
# 原文校验/分析/建词表，不做 CM；冷准备约 5–10 s，一次准备后复用
# 需要先按需 fetch-corpus 恢复 xml / nci；大缓存只放忽略目录 .diag-state
timeout --signal=KILL 19s node scripts/diag/p131/prepare.mjs xml main replay-preparation-01
timeout --signal=KILL 19s node scripts/diag/p131/prepare.mjs xml macro replay-preparation-01
timeout --signal=KILL 19s node scripts/diag/p131/prepare.mjs nci main replay-preparation-01
# 决策约 2–3 s；每次复现使用新的 phase 名，不覆盖已有回执
timeout --signal=KILL 19s node scripts/diag/p131/run.mjs replay-01 xml-main fixed
timeout --signal=KILL 19s node scripts/diag/p131/run.mjs replay-01 xml-macro fixed
timeout --signal=KILL 19s node scripts/diag/p131/run.mjs replay-01 nci-main fixed
# 不需要原文/缓存的只读档案检查和有界单元测试
timeout --signal=KILL 19s node scripts/diag/p131/verify.mjs --current
timeout --signal=KILL 19s node tests/run-p131.mjs gate
timeout --signal=KILL 19s node tests/run-p131.mjs worker
```

准备缓存存在时 `prepare` 会拒绝覆盖，应直接复用；缓存丢失时使用新的可选 receipt-phase（如上），不改写提交中的原始准备回执。初版准备脚本已按原字节归档，以保留历史脚本 SHA。归档 receipt 与新的复现回执分目录；离开本次源码后检查历史证据用不带 `--current` 的模式。

## 用户本机验证：仍是最终验收条件

可先在最新源码的项目目录只跑 XML（**本机执行，不在 Arena 执行**）：

```bash
mkdir -p .diag-data
OUT=$(mktemp -d "$PWD/.diag-data/p131-xml-XXXXXXXX")
UCZ_THREADS=16 node scripts/diag/run.mjs bench-one /absolute/Silesia/xml \
  --no-single --no-bench --verbose-segs > "$OUT/xml.json.tmp" &&
mv "$OUT/xml.json.tmp" "$OUT/xml.json" &&
node scripts/diag/check-baseline.mjs "$OUT/xml.json"
```

随后完整十二项沿用：

```bash
UCZ_THREADS=16 bash scripts/diag/p13/local-validate.sh all /absolute/Silesia
```

注意该包装器分开检查“十二项 P12 无回退”与“P13 总量 <40M / 同口径耗时 -35%”。即便 XML 恢复、十二项无回退，40,233,692 B 仍未达到 <40M，最后的 `targets.meta` 可以正确地报 `TARGETS_NOT_MET`；不能把它混同于 XML 再次回退。只有收到最新完整结果后，才能确认 XML 实际回到 339516 B、其余文件无回退及实际耗时。**本轮已修复并验证的是准入错误，不宣称已得到完整 12/12 PASS。**
