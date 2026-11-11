# P15.0 四单元有界审计与 P15.1 实施计划

## 结论与证据边界

P15.0 **仅审计，未修改生产代码**。冻结基线为用户报告的 P14.1 本机完整 Silesia 运行（`18f497d`、16 核、12/12 验证与逐文件无回退），总计 **40,075,423 B**；原始 JSON、运行源码 SHA、总耗时和运行日期未提供。`dcf8057` 是转录与基线锁定提交。报告中的窗口结果均为 Arena 测量，不是用户全文件结果；用户报告 Mozilla 从 589.7s 增至 723.3s（+133.6s），不能据此推断总耗时。

严格小于 40,058,000 B 需要再减少 **17,424 B**；严格小于 40,000,000 B 需要再减少 **75,424 B**。各文件上限分别严格保持，任何单文件 1 B 回退都不能被别的文件收益抵消。30–80 KB、双编码 40% 加速及 REC2 理论 0.811 bit/B 是目标或理论例子，不是本次全量实测。

`src/lib` 指纹 `539d10e904c8d677273b8f6d8755ba30c7bc53d44351766500e6a7bccea5ea65`，与 P14.1 生产版本一致。`scripts/diag/p15/` 使用独立复制和补丁，实际生产代码从未改写；单个输入最多 256 KiB，CM 编解码限 512 KiB，外层 19s / 子进程约 17s，未进行全文件压缩。不能使用真正的 Subagent，本审计是隔离探针而非四个独立模型代理。

## 单元 1：转换流覆盖、筛选与双编码

P14.1 限直接 BIN IDs 5/19/24；这里仅强制实验 DELTA4、SUB8 与 TG4 内流，并不意味着生产自适应已选中这些候选。DELTA 中 RES→BIN 是**模型 profile 改变**，不能当作 H8 改善。64 KiB 固定 DELTA4，RES-v20 / BIN-v20 / BIN-stride4 payload：Mozilla resources 9605/9140/9078 B；其 late 9153/8521/8855；OSDB 41793/35229/35071；Samba 5383/4409/4162；ooffice 51801/47158/47481。即 H8 分别省 62、亏 334、省 158、省 247、亏 323 B。SUB8 Mozilla 9018/8804/8757（v13→v20 还改变列分组，H8 本身只省 47）；OSDB v20/stride4 41913/42072，Samba 4701/4713。TG4 Mozilla 32 KiB 4021→3966。均成功逆变换，但这些不是自适应容器：例如 OSDB 强制 DELTA 35071 B 高于 64 KiB 真实自适应 22821 B；Mozilla 强制 SUB 8757 B 高于真实 7352 B。尚无真实自适应转换组的候选命中或端到端净增益证据，不能承诺 30–80 KB。

**现有 BIN/WIDE 筛选已经是头/中/尾拼接的至多 192 KiB**，不是前缀；保留成员接缝和位置处理。实际生产候选函数在 256 KiB Mozilla code、late、OSDB mid、late、Samba mid 上均通过 stride4 筛选，强制全容器分别省 1480、1948、284、236、25 B；它们是现有门工作情况，不是新收益。Samba-c 的现有筛选 26367→26378 B，拒绝；额外完整强制容器 33943→33950 B，拒绝正确。备选前缀和三段各自重置只在有限窗口测过，后者不等价于现有拼接流；没有发现门漏掉的赢家，也不支持放宽 0.15% 或替换现有采样。

原型 `encodeCMContextDual` 同时输出标准和 stride4 或 WP-token3：共享 H0–H7、mht4/mht8 等可共享状态，各自独立 H8、mixer/APM、算术输出；两路预测先于共享学习，WP-merge/WIDE 不在可共享范围。68 个边界组合（两种候选、a2 on/off、0–1024 B）两路均与独立编码逐字节和标志一致，并通过 stock 解码；最初一条测试因为不存在的 APM2 数组被误判为共享而失败，修正断言后通过，失败原样保留，不是字节不一致。

三次预热、交替顺序的总时间（含分配；不含前处理和自适应调用）：Mozilla 128 KiB 3572.134→2871.139 ms（19.62%）；OSDB 128 KiB 3556.132→3468.326（2.47%，其中一次慢 2.20%）；XML WP 63201 token B 1680.977→1455.634（13.41%，字典 437 B 另计）。9 对输出全部一致。与**两个同时存活的独立模型**相比避免的重复 typed arrays 约 BIN 75,628,609 B、WP 42,006,306 B；这不是进程 RSS 或顺序峰值测量。生产常复用已完成的 v20 control，此时双编码可能增加工作；尚无调用端净时间或全 Mozilla 吞吐结论。

## 单元 2：x-ray、MR 与 BE16

真实 x-ray-mid 64 KiB 自适应容器 30,760 B，12 个最终段均 D16 id8，context proposals 为空；这只解释该切片。256 KiB 的真实自适应尝试在 17s 超时（49/79 regions），未得到结果且未重试；因此**无法解释全文件 x-ray 平台**。wide16 检测本身至少需要 256 KiB，不能把 64 KiB 的规则推到全文件。

固定 256 KiB x-ray mid 的 WIDE7 low-only geometry：完整 high-length framing 的 payload 115212→115205 B，late 108651→108647；WIDE6 117635→117631，WIDE8 117729→117719。WIDE7 gradclass 连同实验标记 115205→115208，MR WIDE6 48773→48868；无推广依据。D16 一阶/二阶 119784/125402，byte MED row3800 144809/145651（普通/geometry），row1900 176448/184216。比较是固定配置 payload，不是自适应 UCZ；候选 row/transform 和标记成本都须与真实基线比较。

合成 BE16（lag2 相等 87.48%、lag1 0）WIDE6 LE 9249 B，字节交换 BE 325 B（含实验 1B 标记），可逆；然而该样本真实生产自适应容器仅 **195 B**，所以并非生产净收益。D16 一阶 9074→9080，二阶 767→765（含标记，不含完整 UCZ header）。x-ray 错误交换 WIDE7 带标记 143082 B，明显劣于正常 115212 B。两端各 2 KiB 的 BE/LE 平均残差提案在合成 BE 命中，在合成 LE、随机、x-ray、MR 拒绝；是有限提案测试，不是可靠通用识别或采纳。位序、边界、奇数长度、混合 endian、真实 BE holdout 与完整容器成本仍须验证。

## 单元 3：数字字段和原始 TEXT

代码核对：BIN 的 H6/H7 是字节上下文，不是 word hash。独立数值/分隔符状态只用于实验 H8，不改变原有字母 wordHash。所有下表为固定 profile 的真实 CM payload，未含新 wire 标记、字典或自适应比较；正数为省 B。

| 实验 | main | holdout / 对照 |
|---|---:|---:|
| 合成 offset:id:title，TEXT numfield / numclass | +2484 / +6353 | 合成 holdout numclass +6750，不代表真实文件 |
| OSDB BIN numfield / numclass vs P14.1 最佳 control | -407 / -444 | late numclass -415 |
| Dickens TEXT puncword / sparse5 / numclass | +20 / +10 / -1 | late sparse5 -1 |
| Webster TEXT puncword / sparse5 / numclass | -30 / +90 / +4 | late sparse5 +95 |
| Reymont TEXT puncword / sparse5 / numclass | -140 / +226 / -71 | late sparse5 +249 |
| Samba TEXT numclass / sparse5 | +9（samba-c） | +892（samba-mid，非同分布 holdout） |

真实 64 KiB Webster 是 TEXT id23、16107 B，P13.1 WP admission 拒绝；OSDB 是 BIN id5，现有 stride4 将 22845→22821 B。以上展示可达组，但未实现新 H8 在真实自适应的试选及完整容器对照；Samba 的强制 TEXT 不证明生产选 TEXT。尤其自然语言和 WP 的逐文件地板必须守住，不能全局替换 TEXT。后续先验证 sparse5 在真实选中 raw TEXT 组的收益及计时，再决定是否值得新增模式；数字字段在真实 OSDB 负面，暂不实现。

## 单元 4：REC2

检测器先对首 2 KiB 做 H0>7.5 筛选，训练 2048 B，枚举 1≤a<b≤63 共 1953 对、五种加减/xor 运算（9765 候选，约 2000 万残差计算），另以不重叠末尾 2048 B 验证零/一集中度 >80% 或 H0<5。合格后变换和逆变换均 O(n)，搜索成本是固定但不小的常数（合格搜索实测约 193–283 ms）。实验 P15R 框架：16 B header + 种子 + 实际 CM payload；**不是 UCZ 格式**。

256 KiB seed=1 glibc `rand()` 每次返回值的低 8 位：stock STORE 262162 B，实验 16+31+26815=**26862 B，10.247%**；a=3,b=31,++，残差 H0 0.81012 bit/B，零/一比例 75.07%/24.93%，检测 194.639 ms，正变换 7.321 ms，CM 编码 177.548 ms、解码 227.358 ms，完整实验框架往返正确。另三种合成 plus/minus/xor 均 26895 B；它们共享同一个噪声序列，不能视为三个独立统计样本。Python `ctypes` 对本机 glibc 2.36 `srand(1); rand() & 255` 全 262144 字节与记录输入 SHA 逐字节一致（`checks/glibc-native.json`）；这不适用于所有 rand 字节解释、其他 libc、LCG 或一般伪随机流。

随机与训练伪装/尾部不符 endpoint 保留 stock 原字节，随机 holdout 拒绝；6 个原始 Silesia 窗因低 H0 不进入搜索，另 x-ray **偶数字节平面**高 H0 进入搜索后拒绝，它不是连续原始 Silesia 窗口。80 个边界和畸形长度/操作测试通过，但不是任意损坏检测，也不能推称普遍零误报。尚缺更多真实高熵原始数据、分布漂移对抗、解码资源上限和可部署 UCZ 设计；不建议直接生产启用。

## P15.1 精确实施计划（条件式，须另行授权生产修改）

1. **先测覆盖而非扩门。** 增加不改变决策的组目录追踪：最终规则 ID、成员顺序、转换内部 BIN 精确字节/边界、原完整 control 与耗时；对 SUB 10/16/27、DELTA 1/18、TG3 30 逐类建立可达及负样本，核实实际 ID/内流 profile。以真实选中的组生成新候选，收集 main/不重叠 holdout；保留现有头中尾门，不凭目前证据放宽。若没有真实完整容器严格缩小则不合入。
2. **双编码先解决调用方复用。** 只在控制和候选都确需重新编码且模式支持共享时调用；已缓存 control 保持单候选路径。扩充任意长度/边界、a2 on/off、成员接缝、独立双输出逐字节对照与旧解码兼容测试；独立测串行与并行分配、端到端墙钟及 RSS，在受控本地实测 Mozilla，未达到收益则不启用。绝不共享会改变 H0–H7 的 WP-merge/WIDE。
3. **候选格式与保护。** 如果上述证明新 H8 值得加入，分配独立版本/组语义，编码解码对称，绝不重新解释 v20 或 ≤v19。保留 WORD-PRE 0x4000、APM 0x8000、v20-CM 0x10000；每处读取 r 均掩掉新上下文位；不占 group r 0x2000（r=8192 合法），不把 container recovery 0x2000 与它混同，v18 无空余位。保持 v19 0x400 的固定 mht4 与旧无标志语义。验证 worker/serial 字节一致、旧流和错误/截断边界。
4. **TEXT / BE16 均为条件研究。** 先对真实 selected raw-TEXT 组比较 sparse5 完整候选（含模式/header/字典）和现有最佳含 WP 的容器，做自然语言 main/holdout 和 1 B 回退控制；数字门先不推广。BE16 先补真实 BE、LE、随机、混合、奇长 holdout，以两端小窗口仅提议，再做完整实际成本严格比较；目前合成 BE 自适应已更好，不构成实施理由。x-ray 需用户本地真实大文件目录与规则追踪，不能用超时切片推断。
5. **REC2 延后。** 先加更多高熵真实/近似递推假阳性、训练尾段漂移和不同种子/来源，测 detector 成本及完整容器，包括所有种子、长度、版本及安全解码边界；严格小于现有最优 UCZ 才采用。须先制定新可逆 wire 版本、格式和资源上限，不能把 P15R 直接当 UCZ。
6. **集成及验收。** 保持既有 P11.1 内存 tiers、P13 BCJ gate 和 cache 修复、P13.1 WP <.99 admission、P14.1 低平面 WIDE 与 TEXT/TG3、宏路径只严格更小时采用、orphan 策略及旧 flag/textOn=false 行为。先运行有限 parity/兼容/worker/metadata/UI/build 检查并保存所有失败；不宣称长期 legacy `test:codec` 已通过。最后仅用户本机完整 12 文件验收、逐文件 SHA 与零回退、实际总大小和耗时，才可更新基线或宣称达到目标。

## 可复现性与失败清单

- `scripts/diag/p15/run.mjs unitN input variant bytes offset phase`；每次用 `timeout --signal=KILL 19s`，输入与源码 SHA、完整收据、隔离补丁、精确命令参数和历史源码存于 `scripts/diag/p15-results/unit*/`、`scripts/diag/p15/history/`。固定语料窗口及其父 SHA 位于 `scripts/diag/p14/slices.json`，语料数据不纳入 Git。
- `node scripts/diag/p15/verify.mjs`：87 收据，85 PASS / 2 FAIL，48 个源码归档哈希通过；验证收据结构、来源、归档与声明的边界，**不是重跑或独立证明算法**。两条 FAIL：dual-boundary 初始 APM2 存在性断言；x-ray-mid 256 KiB 自适应超时。收据均保留。验算器第一次运行因 `totals` 属性拼写错误失败，修正为 `total` 后通过。
- `node scripts/diag/p15/typecheck.mjs`：隔离补丁和诊断 TypeScript 最终 PASS；初次把拼接片段当独立模块及引用不存在的 `SegResult.wordPre` 导致 FAIL，收据保留，修正后检查实际拼接后的 coder。22 个 baseline/diagnostics metadata 测试 PASS；`npm run build`（含 worker 生成文件一致性检查）PASS。未跑或声称完整 legacy test:codec。
- 原始 P14.1 80 收据（74 PASS、6 历史 FAIL、3 超时）和用户本机报告独立保留；基线运行日期原误写为 2026-11-07，现更正为未知，不改变用户报告本身。全量验收与 Arena 固定切片的证据等级不同。
