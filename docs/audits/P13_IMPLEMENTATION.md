# P13 路由、候选调度与残差模型审查

## P13.1 本机全量验收与新锁定基线（2026-11-07）

用户报告 P13.1 在本机 16 核完成 **12/12 PASS**：`verified=true`、输入 size/SHA-256 一致、逐文件零回退。总量 **40,233,692 B**（报告 18.9836%；标准输入精算 18.98365649%），较 P12 **-64,177 B**。唯一变动为 ooffice **1,955,064 → 1,890,887 B**；XML 恢复 **339,516 B**，其它十项严格相差 0 B。

编码行时累计 **1,687.0 s**；与此次用户给出的 P12 **2,137.5 s** 对比为 **-450.5 s / -21.1%**。此前 P12 逐行归档和为 2,137.2 s，两个口径并列保留。未提供本轮每文件时间、原始 JSON、运行源码 SHA、机器/Node 细节；不补造这些字段，也不标作 Arena 全量重测。实现提交为 `ed09309`，本机运行源码身份未独立确认。

`scripts/diag/baseline.json` 的 12 个 `bestUcz` 已逐项校验并锁定 **40,233,692 B**，1 B 回退不可由其它文件收益抵消。原 P12 锁完整保留在 `scripts/diag/baselines/p12-d9b84df.json`；本轮报告转录在 `p131-local-report.json`。旧 `ucz/pct/encMs/decMs` 仍是 v14 字段，未拿它们冒充新测量。

下一阶段 P14.0 仅审计：相对用户提供的 Cubrim v0.3.2 max 约 40,058,000 B 尚差约 **175,692 B**；严格 `<40,000,000 B` 至少需再减 **233,693 B**。两者都未达到；zpaq 38.83 MB 也只是用户提供的比较目标，不是本机同口径 benchmark。

锁定校验：22 项 metadata-only 基线/摘要/目标测试全部通过；P13/P13.1 历史回执核验通过；`src/lib/` 与 `ed09309` 完全一致。首次测试中的旧固定减量 297870 B 已改为从当前锁计算，保留严格 39999999/40000000 B 边界测试。旧 P13 -35% 时间目标仍按历史 P12 2137.2 s 参照，不因本轮基线更新而偷换。

### 以下是原 P13 检查点历史（P13.1 全量通过已取代“待验收”状态）

> 后续用户本机结果：`51ced1f` 为 **11/12 PASS**，XML +12289 B，ooffice -64177 B，其余十项不变；不能抵消回退。P13.1 的准入问题复现和局部修复见 [P13_1_XML_FIX.md](P13_1_XML_FIX.md)。以下保留 P13 当时的检查点记录；硬基线未更新。

固定分支 `arena/1220f47e-test`。最新硬基线 **40,297,869 B / 用户本机 P12 d9b84df、12/12 PASS**，锁定提交 `b244373`；见 [P12 验收](P12_LOCAL_VALIDATION.md)。下述窗口不更新基线。

目标 `<40,000,000 B` 与编码时间 -35% 尚未验证；严格小于 40M 至少需减少 297,870 B。同一统计口径下，用户报告的编码行时之和 2137.2 s 的 -35% 为 1389.18 s。沙箱禁止完整 Silesia 编码，所有命令外层 19 秒 SIGKILL，上限 512 KiB 输入。

**交付状态：A/B 调度与路由已实现；C 有界研究已归档；D 缓存再准入修正、最终回归与本机验收工具已完成。** 生产 `coder.ts` / `transforms.ts` 没有改变 P12 内核语义；仍待用户本机完整十二文件验收。

## 检查点 A：内核候选筛选（已实现）

- `groupV15Candidates` 对 >=256 KiB 的组，用头/中/尾共 <=192 KiB 的真实输入比较 v15/v20。保留原分片边界、变换对齐和绝对位置；明确领先 >=0.15% 才只编码胜者，接近时保留全部候选。
- WORD-PRE 共用一次词表/坍缩结果，复用相同 raw 样本成本，对完整词典+CM 前缀计价；保留既有坍缩率和 1% 采纳前筛，单独选择 WORD-PRE 内核。小组保留原路径。
- 真正的完整 base 字节继续保留，最终按真实 UCZ 头和载荷严格比较。**这是相对 retained base 的保障，不是数学上保证不会输给 P12 曾全量编码的某个被筛掉候选。** P12 逐文件硬上限仍必须本机全量检查。
- >=1 MiB 的 TG→TG3 后续 APM 升级也使用同一调度器，不再无条件做两次完整 APM 编码；该大输入分支未在沙箱编码测试。
- worker 返回完全相同的采样决策元数据；256 KiB 真实 Node worker 与串行的载荷、flags、成本、决策一致。

### 固定 262144 B 窗口，完整 UCZ 编解码

| 窗口 / 指定规则 | P12 完整候选 oracle B | 筛选 B | 完整候选数（不含 base） |
|---|---:|---:|---:|
| mozilla-code / BIN3 | 72080 | 72080 | 2→1 |
| samba-c / TEXT3 | 32224 | 32224 | 2→1（WORD-PRE 前筛拒绝） |
| xml-mid / TEXT3 | 4708 | 4708 | 4→2（raw v20 + WORD-PRE v20） |

以上三项容器 SHA 也与 P12 oracle 一致。注意：192 KiB 探针在仅 256 KiB 的组上有显著额外开销；减少完整候选数不等于已经测得全文件 -35%。样本编码/解码时间分别记录，部分命令并行运行，不能将其时长比当作可比吞吐量。

## 路由审查（P12 源码事实）

| 路径 | 实际情况 | P13 处理状态 |
|---|---|---|
| `unify.ts` BCJ 家族 / `unifyFamilies` | 家族表目标 id25；成员过滤 s1，统一目标固定 s1；单组跳过归一 | 检查点 B 已覆盖单组与合并组的 s2 升级 |
| `groupV15Candidates` | 固定 spec 同时全量 v15/v20，不跨 s | A 完成内核调度；B 完成四路跨 s 调度 |
| macro/orphan 最终容器 | 通过 `encodePreparedPlan` 与 `chooseGroupV15`，已有 v20 候选 | 不误报为全程 v15；沿用严格完整容器门并受新调度覆盖 |
| 家族完整 separate/unified | 已有 v20；`sampleFamilyBytes` 前筛却只测 v15 | B 已改为共同代表样本、覆盖合法 s2 与 v20 |
| 大文件 `macroUniformGate` 样本 | base 规则编码（非新 v20），原窗口上限 1 MiB | B 已改为 192 KiB、内核感知；完整容器门保留 |
| TG3 `encodeGroupData` | BIN/DELTA 已传递 v20；BIN geometry 有新上下文，旧 transpose suppression 仍禁 weights2 | 不把“支持 v20”与“启用新 residual/mixer 特征”混同 |
| WIDE modes3–8 | 已传递 v20；高平面 res、低平面 res2d；res/res2d 的 useMatch=false 且无 weights2 | 现有 v20 未带来新增残差模型能力，不能无版本标识修改 P12 语义 |
| `sub-peel.ts` | variant 参数由调用方指定；某些 RLE/O0 是历史固定子通道协议 | 非漏传 v15 的统一替换点，不盲改旧格式 |
| `transpose2d.ts` | 固定 true/v2 的历史 id22 内层协议，未接受 APM 参数 | 不能直接改为 v20 而沿用旧 decoder 语义 |
| `encodeGroupDual` | v15 的独立诊断等价性入口 | 保留，不是生产重复 base 编码 |

### ooffice 为什么不能直接兑现旧探针收益

1. `candidatesFor` 会在廉价 E8/E9 门通过后加入 BCJ11/20/25 的 s1，以及合法的 BCJ25 s2；但 `chooseSpecCore` 的这些初筛调用仍是不带 APM 的规则探针，不是 `(s2,v20)` 联合评估。
2. `sampleBudgetForSegment` 在大文件、碎片很多时可降到 **8192 B**（上限 16000 B，少段大区另有 64 KiB 预算）；随后三个窗口会再分配这份预算。这是小样本热身偏差的风险点，**没有完整 ooffice 的最终目录/试探记录，不能断言用户那次恰好在 8 KiB 拒绝了 s2**。
3. P12 `unifyFamilies` 仅接受 s1/r1 家族成员、目标固定 s1，而且单一活跃组会跳过家族统一。因此即使 id11/id20 被归一成 id25，也不等于得到 s2。合并后的 `chooseGroupV15` 只改 CM 内核，不跨变换 spec。
4. 所以前述“强制 BCJ25s2 的前 5M 少 48428 B”和“另一个 BIN CM 窗口 -2.53%”描述的是不同实验机会，不能相加成为完整 ooffice 必得收益，更不能据此精确拆分本机 -18840 B。
5. B 现在在最终 BCJ 家族组 >=32 KiB 时独立补齐 s2 候选，不依赖初筛是否曾选中 s2；大组四路共用 192 KiB 样本；目标字典已占用时不非法覆盖，D 保证目标释放后缓存不会继续阻止再准入。**能证实路由缺口及其修复，不能伪造全文件归因。**

### 已测 BCJ/WIDE 审查证据

ooffice-code 固定 256 KiB、组起点归零：s1/v15 101991 B、s1/v20 100154 B、s2/v15 100314 B、s2/v20 **98479 B**。s2/v20 相比 s1/v20 小 1675 B；不能把不同变换与 CM 的收益简单相加，也不能外推到用户提到的完整 5.11 MB 分组（实际最终分组 JSON 未提供）。

mr-mid s6/v20 **49259 B**；x-ray-mid s7/v20 **115234 B**，与此前对应 v15 容器字节数相同（flags/容器 SHA 不同）。模型代码确认 res/res2d 的 match 与 weights2 未启用，所以此处不是仅换调用字符串便能获得增益。

## 检查点 A 的验证记录

- 新 P13 `policy`、`screen`、真实 `worker` shards PASS，单命令 <9 秒。
- P12 历史解码、14 份冻结 v20 混合容器、worker-plan、规则冲突、缓存冲突回归 PASS；组合命令 15045 ms。
- 初次 `xray-mid` 是错误的清单名称，506 ms 断言失败，凭证保留为 FAIL；改用清单中实际的 `x-ray-mid` 后通过。没有隐藏失败或重写凭证。
- 凭证：`scripts/diag/p13-results/audit/`、`screen/`；入口 `scripts/diag/p13/run.mjs <阶段> <清单窗口> <case> [git-ref]`，内部 17.5 秒上限，不覆盖同名记录。原始语料仅用于恢复/校验，探针只读取清单限定窗口。
- 当时待办的 BCJ 升级、占用键/worker/缓存覆盖与前筛修正已在 B 完成；残差实验见 C。最终收尾与本机全量验收另列，不回写这些历史测量。
- 完整 `test:codec` 尚未运行；有界 shards 不是整个历史大套件的通过证明。

检查点 A 收尾：源码与 P13 测试 TypeScript + P9 defaults 14 checks 的组合命令 PASS / 13737 ms；生产构建（含 worker freshness）PASS / 4914 ms。后续每次源码改动仍须重新验证。

## 检查点 B：BCJ 组级升级与筛选路由（已实现）

- 基线锁定 `b244373` 后，内核调度检查点 A 已独立提交推送为 `b93e236`。
- 任意 >=32 KiB 的 BCJ/BCJ2/BCJ3 s1 组，只要 BCJ25 目标字典键空闲，就评估 s2/v15 与 s2/v20；既适用于单个组，也适用于家族合并后的组。>=256 KiB 的四路 `(s,kernel)` 在共同 192 KiB 样本上预选，明确赢家才只编码一个完整候选；真正的原 base 保留。
- ooffice-code 窗口实际走新的候选 API：四路样本完整成本分别 **77706 / 76292 / 76514 / 75103 B**，选 s2/v20；只编码一份完整 APM 候选，最终 **98479 B**，与独立强制 s2/v20 的容器 SHA 完全一致。未声称完整 ooffice 已获益多少。
- 字典目标先于 worker 派发确定所有权；任务明确携带允许升级与筛选策略。跨线程恢复变体的 flags 并验证目标规则。缓存的旧别名在目标被占用时拒绝复用，避免重演 Mozilla 冲突。
- 家族过滤覆盖 BCJ s2；前筛改用共同 <=192 KiB 头/中/尾输入和 base/v15/v20/合法 s2，而非只看 v15。前筛移到完整 separate 编码之前，拒绝时不浪费完整编码。
- **另一个真实冗余：** 原 `groupJobs` 会对 `candidatesDone=true` 且有 `baseCost` 的家族结果再派发候选-only worker 任务，主线程却不会采用它们。现在明确跳过；32 KiB 合并 BCJ 回归验证了 familyTrials=1、workerJobs=0、workerFallbacks=0、成本与 roundtrip 正确。
- 大 binary macro 筛选上限从 1 MiB 收窄为 192 KiB，使用当前可用内核的真实探针成本；最后仍比较完整容器。完整探针可复用时显式携带 APM 标记，不把 v20 载荷当作 legacy base 解码。直接 macro/orphan 最终编码原本已有 v20，并未盲替换旧协议。
- `bench-one` 新增 `candidateDecisions`（样本选择、实际完整候选、最终规则/flags/字节）；`--verbose-segs` 也记录明确 spec 与 modelFlags，便于本机归因而不是从总字节猜测。

检查点 B 验证：三旧 BCJ ID 的 32 KiB 规则升级/阈值/完整求值 PASS（8644 ms）；缓存冲突 + 实际 worker PASS（5065 ms）；完成家族不重复派发 PASS（4257 ms）；256 KiB 四路筛选 + 实际 worker + 最终容器逐字节一致 PASS（17636 ms，未超时）。TypeScript/P12 family/worker-plan 组合 PASS（9950 ms）；P13 TypeScript/P9 defaults 组合 PASS（12476 ms）；构建及 15 项诊断/基线测试组合 PASS（9988 ms）。每条命令均有外层 19 秒上限。

检查点 B 已提交推送为 `269bcdc`。下列 C 不修改生产内核。


## 检查点 C：残差与 sao 研究（已测，不启用新格式）

`residual-run.mjs` 只向 `.diag-state/p13-residual/` 复制 `src/lib`，精确锚点补丁只改该副本；原始及实验源码 SHA、逐条补丁、探针/runner/bundle SHA 和输入窗口 SHA 均在不可覆盖回执中。已核对 LE16 `get` 访问器、编码与逆变换使用的已知邻域、构造器初始化顺序以及编码/解码签名。旧版研究脚本归档于 `p13/history/`；只读验证器逐条重建补丁并核验源码哈希，不将回执检查伪称重放编码。

以下全为 **原始 payload 字节，不含 UCZ 外层头**。每个成功实验在副本内逐字节解码校验。变更后的流不是生产兼容格式，也没有输出可部署的 UCZ 文件。

### 256 KiB mr / x-ray

| 机制 | mr-mid WIDE6 / B | 对控制差值 B | x-ray-mid WIDE7 / B | 对控制差值 B |
|---|---:|---:|---:|---:|
| 原 v20 控制 | 49237 | 0 | 115212 | 0 |
| res/res2d useMatch | 49087 | -150 | 115206 | -6 |
| res/res2d weights2 | 48965 | -272 | 115223 | +11 |
| 两者同时 | **48897** | **-340** | 115217 | +5 |
| 自定义四邻域 WIDE9 | 52559 | +3322 | 116471 | +1259 |
| 四邻域 + match + weights2 | 52236 | +2999 | 116467 | +1255 |

- 现有 WIDE6 = grad332 + ZigZag 分平面，WIDE7 = average + ZigZag 分平面；高平面使用 res，低平面使用 res2d。控制数各加 22 B 与先前完整强制容器对齐，但实验表不借此声称新格式的头成本。
- `useMatch` 试验同时让现有 v20 的四态主混合分桶生效（无匹配 / <6 / <16 / 更长）；这不是单独隔离 ms4bk 的因子实验。
- 四邻域为左 A、上 B、左上 C、右上 D，`gx=|B-C|+|D-B|`、`gy=2|A-C|`，用梯度权重混合 A/B 并四舍五入；保留首行/首列边界。这里的 `ged` 只是实验名，**不是标准 GED16 实现或文献性能声明**。
- 决策：四邻域明确拒绝。match+weights2 对 mr 仅 -0.691%，对 x-ray 无稳定收益；没有据单窗口引入新的格式/内核标志。生产 v20、旧解码语义及 worker 保持 B 的字节定义。

### sao：区分内层混合与外层布局

| 窗口 | 配方 | 控制 payload B | 内层 weights2 B | 差值 B |
|---|---|---:|---:|---:|
| sao-mid-256 / 262144 B | TG4 | 160441 | 157549 | -2892 |
| sao-mid-64 / 65536 B | TG4 | 42885 | 42501 | -384 |
| 同一 sao-mid-64 | TG28 | **36575** | **36513** | -62 |

- TG4 的 `tg-both`（另加残差 match）与 `tg-mix` 载荷 SHA 完全相同，没有额外收益。
- 256 KiB TG4 混合 -1.8025%，但不能与历史相邻窗口的 TG28 直接比较。256 KiB 和随后 128 KiB TG28 控制均触及内部 17.5 s，保留两份 **FAIL/ETIMEDOUT**，不填补字节数，不延长上限重跑。
- 源码定位到 `planColumnGroups`：这两个长度都使用 64 KiB 布局样本，宽 28 的多 start/span/reverse/codec 搜索成本不随此次减半下降。改用固定前 64 KiB 后，未改生产的布局样本自然降为 16 KiB；相同 64 KiB 输入上 TG28 仍显著优于 TG4，混合对 TG28 只少 62 B（0.170%）。此结果支持**不为 TG4 的孤立收益贸然改格式**，也没有声称解释了全部超时成本。
- 这些 TG 实验只变内层 CM；布局搜索仍按生产规则用非 APM 模型。下一轮若做布局搜索复用，必须针对模型/宽度/输入分片身份精确缓存，不能用本轮结果授权盲减候选。

研究凭证共 **21 份：19 PASS、2 个保留超时 FAIL**，位于 `scripts/diag/p13-results/residual/`。该计数不含 A/B 的完整容器回执；部分实验并行，时间不作吞吐量 A/B 结论。

```bash
# 只读证据核验，不编码任何输入
timeout --signal=KILL 19s node scripts/diag/p13/verify-residual.mjs
# 单项复现实验（同名回执已存在会拒绝覆盖；使用独立工作副本保存新回执）
timeout --signal=KILL 19s node scripts/diag/p13/residual-run.mjs mr-mid wide6 res-both
```

C 已提交推送为 `423344e`。最终边界回归/构建/本机包装脚本见 D；**P13 全十二文件 <40M、逐文件无 1 B 回退、编码 -35% 都仍待本机测量。**

C 收尾检查：研究回执源码/补丁/脚本哈希核验（`--current`）与研究探针 TypeScript PASS，组合命令 4183 ms；历史 63 份实现回执和 3 份冲突修复回执只读核验 PASS（206 ms）。`src/lib` 与锁定基线对 B 均无改动。


## 检查点 D：缓存再准入与最终有界验收

补测发现并修复了 B 未覆盖的状态转换：`free → occupied → free`。当中间计划占用 BCJ25s2 目标时，允许保留原 s1 的结果；但那个结果不能当作“已评估并拒绝 s2”永久复用。32 KiB BCJ + 37 B 目标组的合成输入上，同一空闲计划首次输出 113 B，经过占用计划后旧缓存输出 720 B，严格字节一致断言失败。原始 **FAIL** 回执保留为 `tests/cache-before-bcj-target-first.json`，不将失败当作无损损坏或完整文件回退测量。

修正为缓存显式记录 `bcjUpgradeChecked`；以后目标空闲且缓存未评估过升级时，重新执行候选流程。保留原有目标所有权校验、严格完整成本门与已评估缓存复用，不改任何格式位/CM 数学定义。目标在目录前后两种顺序、free/occupied/free 与冷缓存对照、实际 worker 再准入均已通过。额外覆盖非零绝对起点、不连续分片、E8 指令在分片末尾截断、s2/v15 与 s2/v20 完整解码和 worker 的字节/flags/成本一致。

### 最终源码验证记录

| 检查 | 结果 / 单命令耗时 |
|---|---|
| worker 重建 + `npx tsc --noEmit` + P13 测试 tsc | PASS / 8282 ms |
| 原目标在前 / 在后，缓存再准入 | PASS / 回执 4797 / 4841 ms |
| 缓存再准入实际 worker | PASS / 回执 6002 ms |
| 非零 BCJ 分片接缝实际 worker | PASS / 回执 4590 ms |
| 256 KiB 四路 BCJ 实际 worker + 完整容器 | PASS / 回执 12766 ms |
| P13 policy + family + 三 BCJ ID 升级 | PASS / 11935 ms |
| P13 256 KiB screen / worker | PASS / 7833 / 8727 ms |
| P12 独立历史解码、14 冻结 v20 fixtures、正反序规则冲突、缓存冲突 | PASS / 11911 ms |
| P12 family/绝对位置、worker-plan、P9 defaults 14 项 | PASS / 13358 ms |
| `npm run check:worker` + `npm run build` + 基线/诊断共 22 tests | PASS / 10061 ms |
| 最终源码 ooffice-code 完整容器重放 | PASS / 回执 7678 ms |

最终 ooffice-code 仍选 s2/v20，**98479 B / 22 B 头**，SHA `b7aeec869d460497909b3ac3911a8852838a9d4ae96a7a86cb0c3397fd4c9d09`，与独立强制 oracle 一致；一份完整 APM 候选。新回执在 `p13-results/final/`，使用工作区源码哈希而不是冒充尚未产生的提交哈希。最终 `src/lib` 摘要为 `d26e57edf093235c746739342974639bb0ebb9a4867ba507a2d3e8f273d02603`。

P13 证据分类：完整容器 **15 份（14 PASS、1 份历史清单拼写错误 FAIL）**；残差 payload **21 份（19 PASS、2 超时 FAIL）**；新有界回归 **6 份（5 PASS、1 修复前预期失败）**。测试/档案验证不重复计算为测量。完整 `test:codec` **没有运行**；大输入 TG 调度分支、大 binary macro 的完整编码和 16 核吞吐量也未在 Arena 验证。

```bash
# 每条均只读，或只运行指定有界测试；没有全语料编码
timeout --signal=KILL 19s node scripts/diag/p13/verify.mjs --current
timeout --signal=KILL 19s node scripts/diag/p13/verify-residual.mjs
timeout --signal=KILL 19s node scripts/diag/p12-impl/verify.mjs
timeout --signal=KILL 19s node scripts/diag/p12-fix/verify.mjs
timeout --signal=KILL 19s node tests/run-p13.mjs bcj-seams
timeout --signal=KILL 19s node --test tests/p13-diagnostics.test.mjs
```

C 的 `--current` 源码核验发生于 D 修正前；现在用残差验证器的归档模式，仍逐条验证原提交内容与补丁，不能用 D 的源码摘要覆盖 C 的回执。最终容器/回归由 `p13/verify.mjs --current` 单独绑定。

## 用户本机 16 核完整验证（不要在 Arena 执行）

在本分支最新代码的项目目录、依赖安装完成后：

```bash
UCZ_THREADS=16 bash scripts/diag/p13/local-validate.sh all /absolute/Silesia
```

- 每个文件请求 16 workers，**文件之间串行**，不额外叠加 `xargs -P`；请求数不伪称实际同时工作的线程数。
- 每次创建新的 `.diag-data/p13-all-XXXXXXXX/`，记录源码 SHA、Git HEAD、CPU/Node、请求线程数、脚本摘要及参数；每个文件保存错误日志，失败或混合源码的临时 JSON 不提升为成功回执。
- `verified=true`、原始 size/SHA、相同运行源码都必须满足；**任意文件超过锁定 P12 上限 1 B 立即失败**。不覆盖旧 `/tmp/p4`、历史证据或基线。
- 全十二项完成后先执行 `check-baseline --all` 与汇总，再分别检查 `<40000000 B` 和编码行时之和 `<=1389180 ms`。不能用一次批次 wall time 冒充这个行时口径。
- 用户 P12 报告未提供原始机器/Node 元数据，脚本默认只比较时间的数值门槛，不自行认定同机同口径。即使数值都达标，未确认时仍输出 `TIMING_UNCONFIRMED` 并以非零状态退出；输出目录和已完成测量完整保留。
- 若用户确认此次与 P12 使用相同机器/线程配置/编码计时口径，可在首次运行前设置 `P13_CONFIRM_COMPARABLE_TIMING=1`；或者测完后仅做下列只读检查，无需重新压缩：

```bash
node scripts/diag/p13/check-targets.mjs /actual/path/to/p13-all-RESULTS --confirm-comparable-timing
```

`check-targets.mjs` 的七项合成元数据/CLI/脚本语法测试覆盖 40M 严格边界、-35% 包含边界、1 B 不能抵消、重复/缺失/混合来源/错误指纹、计时可比性与非零退出。这些不是新的全量性能证据；本地包装脚本在 Arena 只做语法检查，没有运行完整文件。

**当前硬结论：P12 锁定值仍为 40,297,869 B；P13 路由/调度/缓存修正已通过上述有界检查，尚无新的完整十二文件总字节或 -35% 吞吐量结论。**
