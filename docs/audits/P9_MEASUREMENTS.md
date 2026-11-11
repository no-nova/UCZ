# P9 新台架实测：首批结构归因

> 历史批次：以下数据来自源码 `4b4648…`，其宏门只有采样判定。用户随后选择完整容器回退，现已另行实现（`../P9_MACRO_GUARD.md`）。新源码运行下方命令会生成新记录，不冒用旧表；用汇总工具读取这里的 key 不会重新编码。

**阶段性证据，不是完整 P9 验收报告。** 这里只收录新增、已推送、校验通过的真实容器记录；不把丢失的旧 `/tmp` 数字补成新实验。
编解码源码未在本批实验中改动。六项均串行、逐字节解码验证通过，各自落盘并推送后才开始下一项。

## 1. osdb 单分片内核接线（R3 §5.8）

输入：osdb，offset=0，n=1048576 B。
切片 SHA-256：`79c5f0f50af5dbb61368cfb91f735545ccc4de12062f6b62cf7f2bcd4290ef14`。
共同源码 SHA-256：`4b4648a6f89ae6064ffbf05f05799a559e8d0b73ba85d015e7c17c744d3b2eaf`。
基线为表中第一行，配置名称不代表另跑了冻结 P7 Git 源码。所有记录均已通过内容校验和与逐字节往返。

| 配置 / trial | 容器 B | Δ B | Δ % | 头 B | 版本 / 模型标志 | 编码 s | 解码 s | 峰值 RSS MiB |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| single-plain-baseline / 0 | 277835 | 0 | 0 | 18 | 7 / 无 | 13.243 | 3.733 | 231.5 |
| single-plain-on / 0 | 268194 | -9641 | -3.47 | 20 | 15 / 无 | 17.859 | 6.927 | 263.4 |

各行只是一次运行；时间和 RSS 是诊断观测，不能据此断言稳定提速或外推全语料。Δ % 的分母是基线容器，不是原始输入。

- **single-plain-baseline / 0**：`38d5a01b61c4810936dd9b92d9b2abdb5145284c0204dcf82091dbe3d4360de9`
  - 相对基线旋钮：无
  - 字典载荷：id=5/s=1/r=1/v15=false/wordPre=false: 277817 B
- **single-plain-on / 0**：`fcd30e76de95b91651d39667b71d37c876f9110e0b6ccff7aa83ce0c5fc75e5e`
  - 相对基线旋钮：`planTuning.v15SinglePlain: false → true`
  - 字典载荷：id=5/s=1/r=1/v15=true/wordPre=false: 268174 B

结论：只打开单分片 v15 开关，容器 −9,641 B（−3.470%）。payload −9,643 B，但头增加 2 B。
它兑现了报告 3 的接线收益；本次编码却慢 34.856%，不能作为提速项或全语料默认值的依据。

## 2. mozilla：逐段 TG 候选与宏组门必须分开算（R2 §3.4）

固定 a2.textOn=true、CM/match=21/20、P7 orphan 范围；对相同中部切片做候选×宏门 2×2。
这不是尚待执行的“分组×a2”矩阵，不能混淆。

输入：mozilla，offset=25085952，n=1048576 B。
切片 SHA-256：`64603b58d5e6f72ad804dbedfef35d2470fcf625c43371ec5e1194028afdfe3c`。
共同源码 SHA-256：`4b4648a6f89ae6064ffbf05f05799a559e8d0b73ba85d015e7c17c744d3b2eaf`。
基线为表中第一行，配置名称不代表另跑了冻结 P7 Git 源码。所有记录均已通过内容校验和与逐字节往返。

| 配置 / trial | 容器 B | Δ B | Δ % | 头 B | 版本 / 模型标志 | 编码 s | 解码 s | 峰值 RSS MiB |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| p7-mid-1m / 0 | 298718 | 0 | 0 | 367 | 15 / 无 | 97.771 | 5.470 | 334.6 |
| tg-mid-1m / 0 | 301278 | +2560 | +0.857 | 379 | 15 / 无 | 101.570 | 5.280 | 342.1 |
| macro-mid-1m / 0 | 272645 | -26073 | -8.728 | 295 | 15 / 无 | 180.480 | 4.399 | 347.6 |
| macro-tg-mid-1m / 0 | 272647 | -26071 | -8.728 | 297 | 15 / 无 | 170.848 | 4.239 | 345.4 |

各行只是一次运行；时间和 RSS 是诊断观测，不能据此断言稳定提速或外推全语料。Δ % 的分母是基线容器，不是原始输入。

- **p7-mid-1m / 0**：`1b68ae349b7404d67f94e4bc916e706c57a56644631d7d73a82b662ffc4d5f3e`
  - 相对基线旋钮：无
  - 字典载荷：id=24/s=1/r=1/v15=true/wordPre=false: 281285 B；id=9/s=28/r=1/v15=false/wordPre=false: 3157 B；id=15/s=36/r=2/v15=false/wordPre=false: 4942 B；id=15/s=28/r=2/v15=false/wordPre=false: 3508 B；id=27/s=2/r=1/v15=false/wordPre=false: 424 B；id=6/s=8/r=1/v15=false/wordPre=false: 1004 B；id=6/s=4/r=1/v15=true/wordPre=false: 225 B；id=27/s=8/r=1/v15=false/wordPre=false: 3287 B；id=9/s=8/r=1/v15=false/wordPre=false: 519 B
- **tg-mid-1m / 0**：`d17d36bedcd8630f406dc8ca7ed178917186c7cbaa1a1a71f0c045f62a01aac7`
  - 相对基线旋钮：`planTuning.candidateTgV3: false → true`
  - 字典载荷：id=24/s=1/r=1/v15=true/wordPre=false: 271860 B；id=30/s=4/r=1/v15=true/wordPre=false: 11973 B；id=9/s=28/r=1/v15=false/wordPre=false: 3157 B；id=15/s=36/r=2/v15=false/wordPre=false: 4942 B；id=15/s=28/r=2/v15=false/wordPre=false: 3508 B；id=27/s=2/r=1/v15=false/wordPre=false: 424 B；id=6/s=8/r=1/v15=false/wordPre=false: 1004 B；id=6/s=4/r=1/v15=true/wordPre=false: 225 B；id=27/s=8/r=1/v15=false/wordPre=false: 3287 B；id=9/s=8/r=1/v15=false/wordPre=false: 519 B
- **macro-mid-1m / 0**：`daff0e7566b25ef514ff53ce7f34e91f14a2da822987dd6e8780a366e292f7d0`
  - 相对基线旋钮：`planTuning.macroUniformGate: false → true`
  - 字典载荷：id=30/s=4/r=1/v15=true/wordPre=false: 272350 B
- **macro-tg-mid-1m / 0**：`d4e1819ee07841b02e92e95edc6d7f4d5ba6c579d1dd774d0e370248deadbece`
  - 相对基线旋钮：`planTuning.candidateTgV3: false → true`；`planTuning.macroUniformGate: false → true`
  - 字典载荷：id=30/s=4/r=1/v15=true/wordPre=false: 272350 B

### 可以支持的判断

1. **逐段候选不是这笔宏观收益的来源。** 单开候选，TG_V3 确实被选中，但容器反而 +2,560 B（+0.857%）。不是“没进池”或“没接上”。
2. **回退可以按字典结算。** 原 BIN 共享组总载荷少了 9,425 B，新增 TG 组需要 11,973 B，其余组不变；载荷净 +2,548 B，再加头 +12 B，合计 +2,560 B。这不是对被移动片段单独编码大小的估计。
3. **宏门的收益实测为 −26,073 B（−8.728%）**，来自统一为 id=30/s=4 的一个组，而非仅扩充逐段候选池。
4. **两开没有可相加的新收益。** 与仅宏门相比，最终载荷完全相同（272,350 B），分段数 130→131，头 +2 B，因此组合容器反而多 2 B。
5. **体积有效不等于效率目标完成。** 宏门单次编码 97.771→180.480 s（+84.595%）；组合为 170.848 s。不能把一次计时差当作稳定吞吐结论，但更不能据此宣称快 30%。
6. **本例不建立全文件不回退保证。** 宏门在 ≤1 MiB 窗口上评估后改写更大的计划，没有最终整容器回退。0.2% / 0.25% 的样本边际无法提供这种保证。

## 3. 复现与证据边界

单项测量（每条最多一项；相同指纹和输入会读已保存结果，不重新编码）：

```sh
P9_SET='a2Tuning.textOn=true,planTuning.v15SinglePlain=false' node scripts/diag/run-p9.mjs --bytes 1048576 osdb
P9_SET='a2Tuning.textOn=true,planTuning.v15SinglePlain=true' node scripts/diag/run-p9.mjs --bytes 1048576 osdb
P9_OFFSET=mid P9_SET='a2Tuning.textOn=true' node scripts/diag/run-p9.mjs --bytes 1048576 mozilla
P9_OFFSET=mid P9_SET='a2Tuning.textOn=true,planTuning.candidateTgV3=true' node scripts/diag/run-p9.mjs --bytes 1048576 mozilla
P9_OFFSET=mid P9_SET='a2Tuning.textOn=true,planTuning.macroUniformGate=true' node scripts/diag/run-p9.mjs --bytes 1048576 mozilla
P9_OFFSET=mid P9_SET='a2Tuning.textOn=true,planTuning.macroUniformGate=true,planTuning.candidateTgV3=true' node scripts/diag/run-p9.mjs --bytes 1048576 mozilla
```

`node scripts/diag/summarize-p9.mjs <基线key> <对照key> ...` 只读取已保存结果，检查内容校验和、同源码/输入/运行时和头+载荷总账；异源、混切片或损坏记录会拒绝。
`node --test tests/p9-summary.test.mjs` 覆盖同输入正常表、混输入拒绝、篡改拒绝。

尚未完成：宏门最终不回退策略、orphan 扩围、分组×a2、表宽/匹配表、采样/精确头成本、3a/3b/3ab、六文件 2/4 MiB、五份整文件 `check-baseline`。
当前宏门/TG/单分片等 P9 开关仍为 off；textOff 保留用户已同意的待测策略，并已由 v17 明确标识。
**没有宣称 −200–400 KB 或 30% 提速已经达成。**
