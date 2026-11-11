# P16.0 有界审计 / P16.1 工作状态

**未完成：P16.1 部分生产实现，尚未通过完整验收。** 本次增加了 BITPLANE id33 的生产编解码与严格完整容器比较；尚未实现 v21 context 6/7 或 macro 多候选及预选精炼。用户撤销 Unit 3，保留原有 0.9985 门槛。切勿把本报告称为完成的 P16 实现。

## 已锁定的用户本机基线

用户报告在 16 核本机以 `2e638324b6d0089090d7df5e7b710c97dc282a33` 执行 P15.1，12/12 Silesia 往返通过、逐文件无回退，总量 **40,042,937 B**，比先前 P14.1 的 40,075,423 B 少 32,486 B。5 个变化为 Webster 6,259,837、Samba 3,342,038、Mozilla 13,014,396、Reymont 1,062,905、ooffice 1,888,998 B，其余 7 项不变。`scripts/diag/baseline.json` 的 bestUcz 已按用户授权逐文件锁定，先前记录保存在 `scripts/diag/baselines/p141-18f497d.json`；其他历史性能字段仍为 v14，不是这次运行的性能结果。原始 JSON、运行源码散列、运行日期未提供；这些是用户本机报告，非 Arena 全文件复测。

用户也报告 AITDCC 16/16、零回退，22,113,937→20,281,106 B，其中 D 2,000,018→173,874、K 568,493→564,445、C 399,323→396,684 B；原始逐文件结果和输入哈希未提供，不能据此建立 16 项机器可校验的基线。对外部压缩器的排名/等价设置尚未独立核实。严格低于 40,000,000 B 还需减少 **42,938 B**。

## 初步有界结果

全部实验输入至多 256 KiB，命令以 `timeout --signal=KILL 19s` 包裹；没有在 Arena 运行全 Silesia/AITDCC。`scripts/diag/p16-results/` 的逐次 PASS 收据及 `scripts/diag/p16/history/` 为不可覆盖的源码、测试归档。`node scripts/diag/p16/verify.mjs` 校验收据和归档散列，不重跑测试、也不证明全文件性质。注意并行运行时计时包含资源竞争，不能作为稳定速度基准。

### Unit 1：变换残差 profile（已实现，有界验证）

UCZ v21 新增上下文模式 6 `xform-bin` 与 7 `xform-bin-stride4`（`context-policy.ts` 的 `CONTEXT_CODES`；组标志 17..19 位；`codec.ts` 的 `contextSpecAllowed` / `contextProposalsForGroup` / `contextGroupCandidatesSync` 同步）。两种模式仅适用于已选中的 DELTA(6)、DELTA3(27)、TRANSPOSE-2D(22)、GRAD3(26)，且仅限 v20 内核、非 WORD-PRE。实现方式是**沿用该规则原本的残差变换**（DELTA/DELTA3 用 `deltaFwd`，GRAD3 用 `medFwd`，倒序与现有 `encodeTerrainGroupImpl` 相同），把残差流交给 identity BIN v20 CM（`encodeCM(...,bin,1,1,...,v20)`），模式 7 额外使用 `bin-stride4` 的 H[8] 上下文。transpose2d 的 `encodeTranspose2d`/`decodeTranspose2d` 增加可选 `CMOptions`，内部 CM 由 BIN 子流改为 v20 BIN（保留 1 B 模式字节 `1` 与逐区域 mask/长度/原样列结构），因此 22 的分组走既有几何路径而非新增框架。行宽读取仍用 `r = rRaw & 0x3fff`（`codec.ts` 解码头部一处），模式位不污染 r；22/26 的 r 因此不会被 17..19 位污染。

候选顺序：`contextProposalsForGroup` 先给 `selected-xform`，`contextGroupCandidatesSync` 依次编码 6 与 7 两个候选，仍以「组载荷严格更小 **且** 完整容器严格更小」双门采纳，相等保留原流。串行、并行 worker（`contextGroup` 任务）、`compressAdaptive` 后处理与 macro/wide 提前精炼共用同一实现，worker 与本地结果逐字节一致（收据 `p16-xform--x2-6/22/26/27`、`gates-r2`、`gates-final`）。

有界实测（32 KiB，两组多成员，完整 UCZ v21 容器往返）：

| 规则 | xform-bin | xform-bin-stride4 |
| --- | --- | --- |
| DELTA s4 (mozilla-resources) | 6,023 B | 5,974 B |
| DELTA3 s4 (ooffice-code) | 22,025 B | 22,197 B |
| TRANSPOSE-2D s8 (mozilla-resources) | 5,121 B | 5,021 B |
| GRAD3 s2 r8192 (mozilla-resources) | 11,017 B | 11,687 B |

同一 64 KiB 输入的固定对照（非自适应文件结果）：DELTA/DELTA3 9,608→9,144/9,081 B；TRANSPOSE-2D 7,348→7,671/7,560 B（**变差**）；GRAD3 21,916→21,426/22,511 B。Dickens mid 与 x-ray mid 的 64 KiB 上，22 的新上下文明显更差（20,361→36,822 B、32,338→35,357 B），这也是必须保留双门并让屏幕先筛的原因。生产自适应路径的实际采纳只出现在确实更小的情形：mozilla-resources-late 的 DELTA3 s8 组由 `xform-bin-stride4` 少 81 B，mozilla-resources 的 64 KiB 窗口选择了 `bin-stride4`（19 号组）而非 22。

负控：`p16-xform--gates-r2`/`gates-final` 断言 BIN/BIN_V3/TRANSPOSE 等不兼容规则在 6/7 下编码即抛错，v15 内核与 WORD-PRE 组合被拒，v14/15/17/19/20 容器拒绝携带 v21 组标记，缺少 APM 内核标记、缺 v20 CM 标志、以及截断容器均被拒；`p141-core--unit1-old-compat` 仍解码 10 个旧自适应容器与 4 个冻结 v15/v17 容器。

### Unit 2：macro 多方案（已实现，有界验证）

`finishPreparedPlan` 增加 `refineMacro` 通道：只有在真正提出 macro 候选时，**先对基线容器**运行 `refineContextCandidates`，再对 macro 候选运行同一后处理，之后才进入完整容器比较。当 macro 规则是 TEXT3(23) 或 BIN3(24) 时，再用 `groupKernelSample(...,4,192 KiB)` 取 head/mid/tail 样本，分别定价 `text-sparse5` 与 `bin-stride4`（含选择头）。样本分歧超过较小者 0.2% 时才额外编码另一条完整 macro 方案，两条都过上下文后处理，最终仍按完整容器严格最小者采纳；分歧过小记 `sample-margin-too-small` 并保留原候选。WIDE 升级候选同样走 `refineMacro`。`compressMacroPlanForProbe(..., refineMacro)` 只用于有界显式计划测试。

实测：samba-mid 64 KiB 显式计划，baseline 3,908 B；样本 TEXT 3,666 vs BIN 3,347 → 选 BIN 完整方案 3,350 B（再经 `bin-stride4` 后处理 −6 B），另一方案亦为 3,350 B；mozilla-resources 64 KiB baseline 8,193 → macro 7,057 B（`bin-stride4` 7,033 B 载荷）；dickens-mid 64 KiB baseline 21,422（v13）→ 19,652 B（v20 TEXT3；样本 19,652 vs BIN 20,406 未触发替换）；webster-mid 自适应 16,107→16,064 B；mozilla-resources-late 自适应 7,272→6,912 B（macro 被拒，两个组精炼各自获胜）。

限制：以上都是 ≤64 KiB 有界输入，不能外推全文件。`sao-mid` 64 KiB 自适应在 16–17 s 内未完成（收据 `p16-adaptive--adaptive-sao` 记为超时失败），本机测量存在资源竞争，不能据此给出全文件耗时或零回归结论。没有跨文件补偿：每个容器只与自身基线比较。

### Unit 3：筛选阈值

Dickens mid 256 KiB 固定窗口，按照现有代码截取合计 192 KiB 的 head/mid/tail：真实 TEXT v20 control 含选择头 **53,555 B**，sparse5 **53,547 B**，差 8 B（约 0.0149%）。现有 0.9985 筛选不通过；严格 `<1.0000` 会放行。已归档测试单独计算的筛选费用与生产筛选一致；该测试没有执行松门槛完整候选，也没有证明完整文件会缩小或速度不受影响。P15.1 对完整 256 KiB 固定 Dickens raw TEXT 的强制对照为 69,566→69,556 B，不是自适应文件结果。x-ray 的追加筛选测试尚未进行，不改变 WIDE 逻辑或筛选门槛。

### Unit 4：bit-plane 初探

256 KiB 确定性合成输入：低三个平面分别为 17/18/19 阶线性反馈状态，高五平面由 xorshift 产生（不是加密随机数），首 2 KiB H0=7.90435，REC2 detector 未通过。采用 64 KiB 样本、20 位历史、每次预测先以 Laplace 平滑计算交叉熵再更新计数：这三个平面均为 **1.000 bit/bit**，全部被 `<0.965` 门槛误拒。原因是大状态空间中样本不足以让相同历史重复；低熵模型不能仅凭 in-sample 统计宣称可预测。

强制对相同数据的低三个 packed plane 调用现有 BIN v20 CM（每个 32,768 B 输入）分别得到 **18,343 / 29,101 / 28,412 B**，CM 解码和平面逆变换逐字节正确；加 1 B mask 与每个压缩平面 4 B 长度后，实验性框架为 239,709 B，比 262,144 B 原始输入少 22,435 B。**不是 UCZ 容器，也不是与真实自适应 UCZ 的比较**。说明该门槛能漏掉 CM 可压缩的结构，并不保证所有此类结构可检测。随机对照是固定种子 xorshift，8 个平面均未通过；没有 crypto random 或 adversarial 测试。

屏幕初次测量 135–299 ms，取决于调度和首次运行，显著高于拟议的 <15 ms；这仅是未优化 JS 原型，不能证明优化后不可能。本段是旧原型证据；下节记录此后实现的生产 id33。仍没有 AITDCC L 样本或实际完整文件结果。P15.1 的 12 个 Silesia 首窗首 2 KiB H0 检查均拒绝（见 P15.1 报告），但不是所有窗口的证明，也不能保证任意机器 <0.5 ms。

## P16.1 BITPLANE 部分实现（新增）

`54efea3` 阶段的 `src/lib/bitplane.ts` 和 `codec.ts` 实现 id33（随后筛选逻辑已按下节修正）：先执行 REC2；若其未赢且 n≥16384、首 2048 B H0>7.5，检查至多 262144 位/平面，按 `min(16,max(11,floor(log2(M))-3))` 计算 k，经验条件熵小于 0.985 的平面才试 BIN v20；每个平面仅当 `compressed.length+4<q` 才写压缩版本。格式为 1 B mask、按位号顺序原始平面或 uint32LE 长度+CM 数据、最后 n%8 个未变换原始字节；不二次编码整组。CM 保留实际模型旗标，v21 组携带 APM/v20，容器标记 0x4000/0x0800/0x1000。只有完整容器严格小于现有结果才替换。解码检查掩码、每个长度、精确余数与 MAX_OUTPUT_BYTES；无校验和，不保证任意篡改被发现。

64 KiB 合成输入实际 `compressAdaptive`：65,554→57,116 B、id33 v21，往返通过；256 KiB 合成输入 262,162→176,383 B、id33 v21，往返通过。64 KiB+3 尾字节、零 mask、超大平面长度、截断、旧版本拒绝及 MAX_OUTPUT_BYTES 单元测试通过。随机 SHA-256 计数器输入完整容器 65,554→65,554 B、逐字节保留旧版本且往返；早期测试使用真实 `crypto.randomBytes`，只保存哈希、不能逐字节重现，后续确定性对照可重现。十个旧自适应容器及四个冻结 v15/v17 容器解码通过，REC2 的 80 组边界和畸形测试通过。

**重大速度风险：** 对随机 64 KiB 输入，k=13 的经验熵约 0.90，而不是 1；八个平面全部小于 0.985 并被送入 CM（最终均被大小门拒绝）。这不是快速随机退出，也不满足最初 P16 对随机样本早退出的意图。由于用户要求的经验熵门存在有限样本向下偏差，不能宣称 `<15ms` 或高熵负控无性能代价；此提交是有风险的部分实现，不建议在完成性能评估、单位 1/2 和完整本机验证前作为 P16 发布。12 Silesia 首窗的 H0 拒绝只说明那 12 个所测首窗，不证明全文件或所有输入的性能。

## 筛选校正检查点（P16.1 续）

现在线路在 k=12 与 k=`min(16,max(13,floor(log2(M))-2))` 分别计算经验条件熵与 `activeStates/(2*ln(2)*(M-k))` 修正，并使用 0.975 门。**仅此修正不足以满足随机早退要求**：64 KiB / 256 KiB 的 SHA-256 计数器随机对照，高阶修正后仍约 0.954–0.963，八个平面都会被错误放行（收据 `mm-random64` / `mm-random256`）。因此额外要求同一阶模型的后半样本按因果 Laplace 序列预测交叉熵 `<0.985`，通过后才允许该阶的校正结果参与择优。这是用户指定公式之外的额外保守门，可能造成新漏报，不能声称仅一行 MM 即解决了误报。

加入后，两个确定性随机对照均 0 平面通过，无平面 CM 尝试；64 KiB 和 256 KiB 结构化自适应结果分别保持 65,554→57,116 B 和 **262,162→176,383 B**，均 v21 id33 且往返。完整确定性输入及散列见对应 `checked-*` 收据；这些有限对照不保证任意随机/对抗分布。性能仍不满足用户的 `<15 ms`：不并行的 256 KiB 冷调用约 332 ms，64 KiB 原型单进程约 118 ms（并行测试受竞争更慢）；此数只测屏幕本身，不含 REC2。合并上线前仍需优化和可比较计时；这是部分进展，不可宣称验收。

## P16.1 Unit 1/2 检查点

新增 `tests/p16-xform.ts`、`tests/p16-macro.ts`、`tests/p16-adaptive.ts` 并登记到 `scripts/diag/p16/run.mjs`。本轮 `node scripts/diag/p16/verify.mjs` 校验 **69** 份收据（60 PASS / 9 FAIL）的源码与测试归档散列；失败收据保留为超时/断言失败的原始记录，未被覆盖或改写。`npm run check:worker`、`npx tsc --noEmit`、`npm run build`、`npm run test:ui` 14/14、`node --test tests/p10-baseline.test.mjs tests/p122-diagnostics.test.mjs tests/p13-diagnostics.test.mjs` 22/22 通过。这些仍不是完整 Silesia/AITDCC 验收。

## P16.2：BITPLANE 在 STORE 主导输入上失效的两个独立缺陷（已修复）

用户报告 `AITDCC/L` 3,000,000 B 输出 `3,000,021 B`（ver 7、单 STORE 段、`encMs` 2035）。用有界 L 同构代理（20 位 LFSR 驱动低平面 + 噪声、高平面 xorshift，≤262144 B）在沙盒内完整复现，并定位到**两个互相独立的缺陷**，此前 P16.1 的 0.975 门槛与 Miller–Madow 校正都不是主因：

**缺陷 1：STORE 主导时 id33 根本不触发。** `refineBitplane` 原以 `bitplaneEntropyGate`（前 2 KiB H0 > 7.5）为唯一入口。L 型数据高平面近随机、低平面强结构，前 2 KiB H0 常低于 7.5（实测 12 个 Silesia 首窗为 1.99~7.31，全部 <7.5），而整文件又因字节级 CM 全败而留在 STORE。新增 `bitplaneStoreTrigger`：`raw>=16384 且 stored*2>raw` 时也进入位平面阶段。该条件只在字节级模型几乎完全失败时成立，普通文本/代码/二进制不会触发（上面 12 个首窗即不满足其一）。

**缺陷 2：即使通过，打包成 byte 后交给 byte 级 BIN CM 也看不见 16~20 阶位历史。** 实测：把低位平面 pack 成 `ceil(n/8)` 字节后，BIN v20 CM 在 32 KiB 采样上只有 0.89~0.90 的比值上限，而位级模型能到 0.065。新增 `src/lib/bitcm.ts`：显式 k 位历史（阶 16 与 20）、`Uint16Array` 计数的 Laplace 概率、可学习混合权重（含常数偏置项使 p=0.5 可表达）、LZMA 式进位处理的二值区间编码器。

实现过程中修掉两个**只能靠收据发现**的编码器缺陷，两者都不会在往返测试中暴露（编码与解码同样错，往返仍"正确"）：
1. `squashTable` 用**浮点**下标（混合权重使 `mixed` 为小数）→ 查表得 `undefined` → `NaN` 概率 → 全部输出塌缩成 5 字节。现统一 `Math.round`。
2. 区间编码器把 `prob` 当作 **P(0)**，而模型输出的是 **P(1)**，分支取反。后果：只有在 p≈0.5（随机数据）时才"看起来正常"，一旦数据真有偏斜就膨胀 4 倍以上。由 40,000 位合成概率序列的交叉熵对照定位（理论 2,365 B vs 实际 15,001 B，往返仍 0 错误）。

**采纳门改为真实编码器仲裁，不再用统计熵猜。** 先用 16 KiB 采样试点，实测发现对 16/20 阶是**错误设计**：状态空间 65,536/1,048,576 在 2,048 字节采样里几乎填不满，采样比值退化到 ~0.96 甚至 >1，把全量能压到 0.09 的平面全部误杀（收据 `p16-bitplane-L--noise5` FAIL 即此证据，予以保留）。改用 `bitplaneFullProof`：**直接全量编码**，只有 `coded+4 < q` 才采纳。代价可接受（实测 8 平面合计 0.31 s/256 KiB，即约 1.2 s/MiB，解码约 0.34 s/MiB），换来**结构上不可能误放行**：随机平面的模型输出必然大于原始平面。随机 SHA-256 计数流 64 KiB / 256 KiB 均 8 个平面全拒、完整容器逐字节不变。

**线上格式：** id33 的 `r` 现在选择模型，`1` = 旧 byte-CM 平面（字节完全不变，旧收据仍可解码），`2` = bit-CM 平面（阶 16 与 20 固定，否则模型无法仅凭 `r` 重建）。每个压缩平面长度的**最高位置 1** 作为 bit-CM 标记，因此 `r` 与载荷互相校验：模型标志与分组规则不符直接抛错，而不是静默解出乱码（已加断言）。`r` 仍是低 14 位，`rRaw & 0x3fff` 掩码不变。

有界结果（204,800 B 代理，SHA-256 见收据）：

| 输入 | 采纳平面 | 平面载荷 | 完整容器 | 比值 |
| --- | --- | --- | --- | --- |
| 2% 噪声代理 | 0,1,2,3 | 161,571 B | 178,617→**161,593 B** | 0.789 |
| 5% 噪声代理（仅采样门会漏掉的强度） | 0,1,2,3 | 178,617 B | **178,639 B** | 0.872 |
| 结构化 LFSR 256 KiB（旧生产测试） | 0,1,2 | 171,134 B | 262,162→**171,156 B** | 0.653 |
| SHA-256 随机 64/256 KiB | 无 | — | **不变** | 1.000 |

**这些都不是 L 的实测，也不能换算成 L 的预期收益。** L 的真实平面统计（用户提供：plane0 `causalH20=0.539`、`distinct20=219,942`）与本代理同向，但只有本机 `bench-one L` 能给出真值。若 L 的平面结构能被该模型捕获，容器应从 `3,000,021 B` 显著下降；反之 `refineBitplane` 返回原容器，逐字节零回退。

## P16.2：Silesia 侧的两处结构性缺口（已定位，一处修复）

**缺口 A：单组计划的 profile 从没被比较过（已修复）。** P16.1 的 23/24 竞争只挂在 `finishPreparedPlan` 的 macro 候选分支里；而 `macroUniformGate` 在「只有 1 个组」或「已是 direct 方案」时**直接返回 null**。实测 `samba-mid` 64 KiB 全自适应用生产入口：`macro: {proposed:false}`、`groups:[{id:15 SUB_TRANSPOSE s38}]`、baseline=refined=2143 B —— 所以 P16.1 在 samba 上的 0 B 变化不是阈值问题，而是**这条路径根本没有运行**。`mozilla-mid` 同理（11 个 BIN3 组，macro 未提出）。

新增 `refineWholeGroupProfile`，在 `compressAdaptive` 后处理中于 REC2 之前运行：仅当**所有**分段都是 `s=1,r=1` 的 TEXT3/BIN3 时（即现有方案本身就是纯 CM 组），用 3×16 KiB head/mid/tail 采样决定是否值得编码另一 profile 的完整重排，最终仍由完整容器严格更小决定。选中变换、STORE/RLE、REC2 一律不改写。

实测（64 KiB 有界，完整容器）：
- `dickens-mid`：TEXT3 19,649 B vs BIN3 完整候选 20,174 B → **拒绝**，容器不变（证明门有效）。
- 固定 payload 对照显示 profile 选择本身价值很大：`mozilla-mid` TEXT3 24,705 vs BIN3 22,071（−10.7%）、`osdb-mid` 23,562 vs 22,823、`sao-mid` 44,725 vs 42,951、`mr-mid` 18,434 vs 17,996；反向 `samba-c` 10,813 vs 11,262、`reymont-mid` 13,199 vs 13,427、`nci-mid` 4,774 vs 4,784、`xml-mid` 2,318 vs 2,337。

**缺口 B：samba 这类「单一选中变换组」仍然拿不到比较（未修复，仅记录）。** samba 的 3.3 MB 由单个 SUB_TRANSPOSE 组构成，不是纯 CM 组，上述通道按设计跳过。把变换组强制并入单一 TEXT3 需要改写选中的变换规则，本轮不做（而且 `samba-c` 的 256 KiB 实测中 SUB_TRANSPOSE 38,070 B 远好于 TEXT3 10,813 B，说明该变换在文件内多数区域是对的，不能靠一个窗口推翻）。真正可行的方向是「保留变换、只替换熵后端」，需要新 wire 语义，留给下一阶段。

**缺口 C：0.9985 预筛（本轮不改，有数据支撑）。** 对 x-ray-mid 与 dickens-mid 各 8 种变换规则（DELTA/DELTA3/TRANSPOSE/TG/TRANSPOSE-2D/GRAD3/SUB_TRANSPOSE/SUB_TRANSPOSE_V3）在 16 KiB 上逐条对比 192 KiB 采样预算下的 0.9985 门与全量 v20 结果：**16 个用例中 0 例被门误杀**（`missedByScreen=0`），采样比与全量比的符号完全一致（如 DELTA −3.16%/−2.96%，TRANSPOSE +0.697%/+0.461%）。在这些有界样本上把门放宽到 `<1.0000` 不会带来任何收益，只会多花编码时间，因此**保持不变**。这不是全文件证明。

## P16.2 检查点与待续

本轮验证：{"status":"PASS","count":115,"passes":97,"failures":18,"scope":"receipt and archived source/test hash validation only; does not rerun tests or prove full-file behavior"} 校验 **115** 份收据（97 PASS / 18 FAIL，失败收据全部保留，含  的采样门误杀证据与  超时）；
> react-vite-tailwind@0.0.0 check:worker
> node scripts/build-worker-code.mjs --check

parallel-worker-code.ts 是最新的、、
> react-vite-tailwind@0.0.0 prebuild
> node scripts/build-worker-code.mjs --check

parallel-worker-code.ts 是最新的

> react-vite-tailwind@0.0.0 build
> vite build

vite v7.3.2 building client environment for production...
transforming...
✓ 59 modules transformed.
rendering chunks...
[plugin vite:singlefile] 

[plugin vite:singlefile] Inlining: index-imrc7NnN.js
[plugin vite:singlefile] Inlining: style-DNzWrXMt.css
computing gzip size...
dist/index.html  459.15 kB │ gzip: 150.32 kB
✓ built in 2.93s、
> react-vite-tailwind@0.0.0 test:ui
> node tests/run-ui.mjs

TAP version 13
# Subtest: B display keeps every integer digit, including totals above 32 bits
ok 1 - B display keeps every integer digit, including totals above 32 bits
  ---
  duration_ms: 1.432082
  type: 'test'
  ...
# Subtest: two files run concurrently, a third stays unread, duplicate names keep separate results
ok 2 - two files run concurrently, a third stays unread, duplicate names keep separate results
  ---
  duration_ms: 6.858925
  type: 'test'
  ...
# Subtest: one read failure or failed verification does not stop other files or inflate totals
ok 3 - one read failure or failed verification does not stop other files or inflate totals
  ---
  duration_ms: 0.960604
  type: 'test'
  ...
# Subtest: zero, oversized and invalid file sizes are rejected without reading or blocking valid files
ok 4 - zero, oversized and invalid file sizes are rejected without reading or blocking valid files
  ---
  duration_ms: 0.854366
  type: 'test'
  ...
# Subtest: a read-size mismatch never reaches the codec
ok 5 - a read-size mismatch never reaches the codec
  ---
  duration_ms: 0.693206
  type: 'test'
  ...
# Subtest: cancel during a pending read never starts its worker; the next file can start immediately
ok 6 - cancel during a pending read never starts its worker; the next file can start immediately
  ---
  duration_ms: 1.068141
  type: 'test'
  ...
# Subtest: cancelled queued files are not read; cancel-all preserves completed output and settles active work
ok 7 - cancelled queued files are not read; cancel-all preserves completed output and settles active work
  ---
  duration_ms: 1.950504
  type: 'test'
  ...
# Subtest: appending after cancel-all is not overwritten by an old completion; finished results can be released
ok 8 - appending after cancel-all is not overwritten by an old completion; finished results can be released
  ---
  duration_ms: 1.158604
  type: 'test'
  ...
# Subtest: progress and logs are per-file, bounded to 200 entries, and stale progress cannot revive a cancelled task
ok 9 - progress and logs are per-file, bounded to 200 entries, and stale progress cannot revive a cancelled task
  ---
  duration_ms: 1.849948
  type: 'test'
  ...
# Subtest: concurrency is bounded and increasing it starts queued files without eager reads
ok 10 - concurrency is bounded and increasing it starts queued files without eager reads
  ---
  duration_ms: 2.287988
  type: 'test'
  ...
# Subtest: worker client supports separate compression/restore requests, transfers only the owned view, and cleans handlers
ok 11 - worker client supports separate compression/restore requests, transfers only the owned view, and cleans handlers
  ---
  duration_ms: 0.883102
  type: 'test'
  ...
# Subtest: worker cancellation rejects instead of leaving an unresolved promise and ignores late messages
ok 12 - worker cancellation rejects instead of leaving an unresolved promise and ignores late messages
  ---
  duration_ms: 0.700745
  type: 'test'
  ...
# Subtest: worker errors, unreadable messages, constructor and postMessage failures all reject and release resources
ok 13 - worker errors, unreadable messages, constructor and postMessage failures all reject and release resources
  ---
  duration_ms: 0.561178
  type: 'test'
  ...
# Subtest: result table renders complete B values, verified-only totals, file-specific actions and escaped names
ok 14 - result table renders complete B values, verified-only totals, file-specific actions and escaped names
  ---
  duration_ms: 16.116275
  type: 'test'
  ...
1..14
# tests 14
# suites 0
# pass 14
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 133.677386 14/14、 22/22； 旧容器兼容（10 个自适应 + 4 个冻结 v15/v17）通过；REC2 12×16 KiB 负控全拒。仍**没有**完整 Silesia/AITDCC 测量。

## 检查与待续

本检查点 `node --test tests/p10-baseline.test.mjs tests/p122-diagnostics.test.mjs tests/p13-diagnostics.test.mjs` 22/22、`npm run test:ui` 14/14、`npm run check:worker`、`npx tsc --noEmit`、`npm run build` 均通过；测试中的初次基线更新引起过期预期失败，修正新数值后重跑通过。上述检查已在 BITPLANE 生产修改后重跑；它们不能替代 unit 1/2 的测试，或实际大文件验收。继续时应先完成完整文件本机基准，尤其解决长上下文样本稀疏、选择完整容器比较与安全解码；保留超时和失败收据，验证完整的版本兼容性、worker parity、畸形帧与内存界限，再做生产实现。完成后方可按 `docs/audits/P15_1_IMPLEMENTATION.md` 的用户本机说明跑完整基准；本检查点不能宣称已准备好 P16 本机验收。

---

# P16.2：验收反馈修正（`0912a8f` 之后）

本节记录用户 P16.2 验收提出的三个问题，以及沙箱能证明与不能证明的部分。**没有**在 Arena 编码任何完整 Silesia / AITDCC 文件。

## 1. `testP9Macro` 的 `macroComparison.sample` 回归 — 已修

**症状**：`tests/run.mjs` 的 `testP9Macro` 在 `assert.ok(partial.macroComparison?.sample)` 失败。

**根因不在 `0912a8f`**：`git worktree` 检出 `1d25fec` 用同一份最小复现（三段非 FILL、跨度 >1 MiB）跑出完全相同的结果（`hasComparison:false`）。缺陷来自 `269bcdc`：它把 `macroUniformGate` 的窗口预算 `WIN` 从 1 MiB 收紧成 `GROUP_KERNEL_PROBE_BYTES = 192 KiB`，以复用 P13 的内核筛选预算，但窗口扫描仍然按**原始字节跨度**计：

```ts
while (merged[hi].end - merged[lo].start > WIN && lo < hi) lo++   // 旧：原始跨度
```

一段长 FILL 游程（常量）就能撑满预算，把第二个真实的非 FILL 片段挤出窗口，于是 `inWin.length < 2` / `bySpec.size < 2` 命中，门直接返回 `null`。**门根本没看见它想看的碎片。**

**修法**（三处，全部是语义修正，不放宽采纳条件）：

1. 预算改按**非 FILL 字节**计。FILL 段不进 `inWin`、不参与定价，把它的长度记入预算只会挤掉真正的合作者。成本天花板不变（仍然 ≤ `WIN` 字节被编码）。
2. 采样下限同样按信息字节计：`MIN_PROBE_BYTES = 16 KiB`（0.2% 判决边际在 16 KiB 上约 33 B，已大于实测 ≤30 B 的组间帧头成本）。
3. 步长探测改为在**拼接后限 64 KiB** 的缓冲上做，成本与窗口跨度脱钩。
4. 报告语义：`macroComparison.sample.bytes` 改为**被定价的信息字节**，原始窗口跨度另记 `sampleSpanBytes`。用跨度冒充证据量是错的。

**边界证据**（沙箱，`tests/p9-macro.test.ts` 夹具口径；`planTuning.macroProbeBytes = 64 KiB`）：跨度 1,134,592 B、信息量 86,016 B → `sample.bytes = 57,344`、`sampleSpanBytes = 581,632`、`reusedProbePayload = false`、容器 roundtrip 通过。

**新增旋钮** `planTuning.macroProbeBytes`（默认 = 192 KiB = 旧行为）。它只影响门看见多少，不影响采纳：调小只会更容易返回 `null`，最终仍由完整容器严格更小裁决。没有它，"跨度远大于预算"这条分支在生产规模下无法有界测试（1.2 MiB 跨度 × 约 10 条候选实测 ≈200 s）。

## 2. `refineWholeGroupProfile` — 已撤回

按"零收益的时间消耗必须撤回或精确闸门"的纪律撤回，理由有两条：

- **从未赢过**：dickens / mozilla / nci 采样筛后即放弃；冻结回执 `p16-macro-gate--dickens-swap`、`--dickens-all-sub`、`--moz-all-sub` 中 `accepted` 全为 `false`。
- **动机不成立**：其注释声称为 samba 的"单组计划"服务，但 samba 的实际产物是 `SUB_TRANSPOSE(s=38)`，而该函数第一步就要求"所有段都是 `s=1,r=1` 的 TEXT3/BIN3"——samba 永远进不去。

撤回同时删除了 `Compressed.profileComparison` 与 `tests/p16-macro-gate.ts` 里的对应字段。

**保留的有价值观察**：`refineWholeGroupProfile` 用的 3×16 KiB head/mid/tail 采样对 23/24 有 13/14 的判决准确率（14 个 64 KiB 切片，唯一分歧是 `nci-mid`：采样 1.17% 偏好 BIN、全量 0.21% 偏好 TEXT，且两边绝对差都 <1 B）。这个采样器本身是可靠的，撤回的是**调用它的那个阶段**。

## 3. Silesia 编码时间上升 — **未复现，机制仍未定位**

用户报告 `0912a8f` 相对 `1d25fec`：mozilla 653.2→765.3 s、samba 343.8→412.8 s、ooffice 100.4→117.0 s（约 +197 s），而 12 个文件字节完全一致（40,038,909 B）。

沙箱的排除结果（**不是**结论）：

| 假设 | 检验 | 结果 |
|---|---|---|
| `refineBitplane` 的熵门在顶层触发 | 12 个语料文件前 2 KiB 的 H0 | 全部 ≤ 7.5（最高 sao 7.2499）→ **不可能触发** |
| `refineBitplane` 的 STORE 门在顶层触发 | 需要顶层 STORE 过半 | 12 个文件都不到 → **不可能触发** |
| `refineWholeGroupProfile` 是元凶 | 64–256 KiB 切片上单测该函数 | 0 ms（不合格早退）到 410 ms，且从未采纳 |
| 提交本身变慢 | 同一切片 A/B：`1d25fec` 26,916 ms / 80,390 B vs `0912a8f` 26,874 ms / 80,390 B | **没有变慢，字节相同** |

仍未排除的是**段内部**的 `refineBitplane` 调用点：若某段自身以 STORE 为主，`bitplaneStoreTrigger` 可以在段级触发，代价是 8 个平面 × 该段长度。沙箱无法用 ≤256 KiB 输入区分"段级"与"文件级"，所以**这条路径仍然开放**，需要在本地大文件上用 `onStage` 计时定位。

已完成的降低暴露面工作：撤回每文件必跑的 `refineWholeGroupProfile` 后，管线少了一条无收益的后处理。

## 4. 新增交付

- `docs/ARCHITECTURE_AND_ALGORITHMS.md`：端到端流水线、容器 v7–v21、33 个变换的数学、CM 内核、上下文策略、**理论盲点**（AITDCC I 的 632 B、lzma 友好的 H/J、深度混合的 B/C/K、Silesia 五个文件头寸的机制分析）。
- `scripts/diag/inspect-structure.mjs`：只读结构取证（熵谱 / 平稳性、步长与自相关谱 d∈[1,256]、64 KiB / 1 MiB / 全文件的长程 LZ 特征、亚字节平面独立性、UCZ 段决策）。在 262,144 B 切片上自测：sao 读出 d=28（流水线选 `id30/s=28`）、mr 读出 d=2 等值率 0.658（流水线选 `id26/s=2/r=1024`）、dickens 无对齐峰（流水线选 `id23`）——工具与流水线的判断一致。

## 5. 本检查点的验证

`npm run check:worker`、`npx tsc --noEmit`、`npm run test:ui` (14/14)、`npm run build`、p10/p122/p13 诊断台架 (22/22) 均通过。**`test:codec` 的 `testP9Macro` 仍未在沙箱跑完整体**：完整 P9 套件在 19 s 上限内被 SIGKILL（历史事实，非本轮引入）；本轮用等价的最小复现证明该分支，见 §1。

**未证明**：完整 Silesia / AITDCC 的任何新数字；§3 的时间差机制；`testP9Macro` 整体通过（只有其失败断言的等价复现通过）。

# P16.3 — test:codec 全绿 + refineWholeGroupProfile 的门位置审计

## 1. 四个断言：全部是"测试写死了某一代实现"，不是产品缺陷

逐条用 `0912a8f` worktree 做对照，四条在**改动前就已失败**，且失败原因一致：
测试把"某个正确的家族行为"写成了"必须命中某个特定 ID 或特定版本号"。

| 断言 | 输入上的真实最优（全量实测） | 原断言为何错 |
|---|---|---|
| `BCJ` family | 生成器是**严格步长 5** 的 E8 记录 → `TRANSPOSE_GROUP s=5` 66 B，BCJ 无立足点 | 断言要求 BCJ 胜出，但那是生成器的性质，不是 BCJ 的性质；真 exe 的判据是**指令长度不规则 + 调用目标集合小** |
| `SUB_TRANSPOSE` | `TRANSPOSE_GROUP_V3 s=16` 32,158 B vs `SUB_TRANSPOSE_V3` **32,129 B** | 多流变换每个剥离列各付一次模型热身，短采样系统性高估它 |
| `PEEL \| TRANSPOSE_2D` | `TRANSPOSE_2D` 168,943 < `SUB_*_V3` 169,017 < `PEEL` 169,674 < 恒等 194,605 | 三族都是"按列拆分"的同代实现，差 0.4% |
| `container[3] \in {9,12,13}` | 胜者 id 28 需要 v13 | 版本号是**胜者的函数**，不该反写成常量表 |

修正方式：断言改写成**不变式**（"属于该家族"、"至少比恒等规则小 10%"、
"版本号 ≥ 该 spec id 所需的最小版本"），并把 `minVersionForSpec` 写成
writer 阶梯（`codec.ts` 容器版本推导）的镜像，而不是枚举答案。

## 2. 一处真实的产品缺陷：多流候选的采样偏差

`SUB_TRANSPOSE` 在 336,000 B 列混合记录上比 `TRANSPOSE_GROUP` 小 49 B，
但采样窗口选出的是后者：SUB 有 N 个剥离列，**每列各付一次模型热身**，
单流的 TG 只热身一次。管线里已经为**同一个偏差**准备了四条整区域仲裁
（`PEEL`、`ANCHOR_FOLD`、`MICRO`、`WIDE_GRAD`），唯独 SUB 没接上。

修法：把 SUB 接到同一条既有规则上——当 SUB 的样本比落在胜者 6% 以内时，
用**整区域**实测决定，而不是相信样本序。实测收益
32,170 → **32,129 B**（ver 21 → 10，且流更小）。

时间代价（no-zero-gain-burn 检查，2 轮 × 2 文件）：

| 文件 | 关 | 开 |
|---|---|---|
| dickens-mid 64 KiB | 6,810 / 6,713 ms | 7,085 / 6,607 ms |
| sao-mid 64 KiB | 58,466 / 52,345 ms | 55,423 / 53,358 ms |

差值在 ±5% 噪声内，**体积完全相同**（19,649 / 36,456）——即 6% 近失门
只在真正接近时开火，不是无条件时间税。

## 3. `refineWholeGroupProfile` 的门位置：确实站错了地方

它是 `0912a8f` 相对 `1d25fec` **新增**的阶段（`1d25fec` 中该符号不存在），
本轮已整段删除。审计结论（这是 §3 时间差目前最有力的候选机制）：

- **触发面**：只有当**每个**段都是 `TEXT_V3`/`BIN_V3` 且 `s=r=1` 时进入。
  在用户点名的时间回归三文件中，只有 **mozilla** 满足（4×id24，s=r=1）；
  **samba** 是单个 `SUB_TRANSPOSE s=38`、**ooffice** 是 4×id25（`s=2`），
  两者都因 `s!==1` 在该函数第一行早退。
  **因此它最多只能解释 mozilla 的 +112 s，无法解释 samba 的 +69 s 和
  ooffice 的 +17 s** —— 后两者的机制仍然未定位。
- **规模错配**：用 `3×16 KiB = 48 KiB` 的 head/mid/tail 采样，去决定要不要对
  **整个文件重跑一遍完整编码 + 一遍完整 v21 上下文重探**
  （`encodePreparedPlan` + `refineContextCandidates`）。在 51 MB 的 mozilla 上，
  0.2% 的采样面无法预测全文件结果，于是"看起来有戏"→ 全量重编码 → 大概率被
  完整容器比较拒绝（`accepted=false`），净结果 0 B、净成本一次全量编码。
  这正是用户定义的 **zero-gain time burn**。
- **门位置**：判据用的是**编码后的字节估计**（`payload.length + header`），
  而它要决定的是"要不要花一次全量编码"，属于"用廉价模型决定昂贵动作"的
  正确形状——但**采样规模**必须与决定的重要性成比例。48 KiB 只够筛掉明显更差的
  候选，不够给全量重编码签发通行证。
- **保留**：采样器本身（3×16 KiB，14 个 64 KiB 切片上 13/14 判决正确）是可靠的，
  撤回的是**阶段**而不是采样器。
- **诚实边界**：本轮**没有**在沙箱复现那 +197 s（红线：输入 ≤256 KiB，无法
  区分段级与文件级行为）。上面是**机制归因**（原文如此，不是实测复现）：
  删除该阶段消除了一条"每文件必跑、且必然伴随一次全量编码"的路径，
  但它是否就是用户观测到的 +197 s 的全部，**未证明**。
