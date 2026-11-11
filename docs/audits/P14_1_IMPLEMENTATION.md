# P14.1：P1 / P2 / P3 生产实现与有界验证

## 后续：P14.1 用户本机全量验收与基线锁定（运行日期未提供）

用户报告在 **16 核本机、提交 `18f497d`** 完成完整 Silesia：**12/12 PASS**（`verified=true`、输入 size/SHA256 匹配、逐文件零回退）。本节是用户报告转录，**不是 Arena 全量重跑**；原始 JSON、运行源码 SHA、完整硬件/Node 元数据和总耗时未上传。以下 Arena 有界测量与冻结回执仍保持历史原貌。

| 文件 | P13.1 B | P14.1 B | 变化 B |
|---|---:|---:|---:|
| xml | 339,516 | 335,300 | -4,216 |
| dickens | 2,214,517 | 2,214,517 | +0 |
| ooffice | 1,890,887 | 1,889,366 | -1,521 |
| mr | 1,798,884 | 1,772,130 | -26,754 |
| osdb | 2,277,558 | 2,255,954 | -21,604 |
| x-ray | 3,548,450 | 3,548,450 | +0 |
| sao | 3,132,317 | 3,132,317 | +0 |
| reymont | 1,064,930 | 1,064,930 | +0 |
| nci | 1,217,746 | 1,216,095 | -1,651 |
| samba | 3,349,194 | 3,349,194 | +0 |
| webster | 6,276,863 | 6,276,863 | +0 |
| mozilla | 13,122,830 | 13,020,307 | -102,523 |
| **合计** | **40,233,692** | **40,075,423** | **−158,269** |

六项下降、六项持平。精确输入总量 211,938,580 B，计算比例 **18.9089796676%**（四舍五入 18.9090%），净缩小 **0.393374%**。`scripts/diag/baseline.json` 已按用户授权锁定全部十二个逐文件上限及总量，旧锁存于 `baselines/p131-ed09309.json`；转录见 `baselines/p141-local-report.json`。

距离 40,058,000 B 的差为 17,423 B，但**严格小于**仍需至少省 **17,424 B**；严格小于 40,000,000 B 需省 **75,424 B**。两项目标尚未达到。用户另报告 Mozilla 编码 **589.7→723.3 s（+133.6 s）**；这不是全十二文件总耗时，不据此推断整体速度。

原 `p141-results/summary.json` 的 `fullFileAcceptance:false` / `baselinePromoted:false` 描述其冻结时的 Arena 证据，不回写历史结果。旧 `p141/verify.mjs` 固定要求旧 baseline；须在 `18f497d` 历史树验证，不用于新锁定基线。P15 将提供独立的当前基线/生产未变检查。

## 原交付时的 Arena 有界记录

## 结论与边界（18f497d 交付时）

**P1 BIN stride4、P2 WIDE6–8 低平面几何、P3 WORD-PRE token3/merge 已接入生产，默认作为严格择优的可选候选。** 新语义采用显式 **UCZ v21** 标记；旧 v20 及更早格式不重新解释。

六个要求的固定窗口，使用相同偏移的 **65,536 B 连续前缀**，已完成独立旧源码与当前自然 `compressAdaptive → decompress` 对照。五个收益项严格缩小，ooffice / BCJ25 不变；六个 `contextCandidates:false` 产物均与独立 `ed09309` **逐字节一致**。额外 262,144 B XML 窗口也完成真实端到端下降。

- 生产源码最后修改提交：`f08217b`；实现/修复阶段另有 `fbf3c87`、`193cfb6`，均已逐阶段保存推送。
- 最终生产 `src/lib/*.ts` 指纹：`539d10e904c8d677273b8f6d8755ba30c7bc53d44351766500e6a7bccea5ea65`。
- 独立旧源码：`ed09309a54155b799b7ea492b45df1422aab03ae`。只读提取 Git 对象后单独 bundle，**不是用当前源码关闭开关冒充旧基线**。
- 冻结证据目录：[p141-results](../../scripts/diag/p141-results/)、[summary.json](../../scripts/diag/p141-results/summary.json)。共 **80 份回执：74 PASS、6 历史 FAIL，其中 3 次超时**。最终验收矩阵及 9 项项目检查通过；历史失败没有删除或改成 PASS。
- 每条 Arena 测试/构建命令外包 `timeout --signal=KILL 19s`；子进程预算约 17 秒。原文单片最大 **262,144 B**。没有完整大文件压缩，也没有全语料结果外推。
- **当时全十二文件尚未验收，基线为 40,233,692 B，没有提升；后续本机结果见文首。** 严格 `<40,058,000 B` 至少需省 **175,693 B**；严格 `<40,000,000 B` 至少需省 **233,693 B**。本报告不宣称达到任一总量目标，也不宣称全文件加速或 RSS 改善。

## 1. 真实 adaptive 端点结果

所有数字为实际完整 UCZ 字节数，包含字典、帧、长度前缀、组标记和完整容器头。各行均通过真实生产解压、逐字节比较及 SHA256。

| 固定窗连续前缀 | 输入 B | 独立 ed09309 B | 当前默认 B | 节省 B | 最终相关规则 |
|---|---:|---:|---:|---:|---|
| mozilla-code | 65,536 | 15,849 | 15,528 | **321** | BIN24，58,368 B 多成员合并组 |
| mozilla-resources | 65,536 | 7,594 | 7,352 | **242** | BIN19，45,568 B 多成员合并组 |
| osdb-mid | 65,536 | 22,845 | 22,821 | **24** | BIN5 单组 |
| mr-mid | 65,536 | 14,056 | 12,117 | **1,939** | WIDE6 / r1024，保留原两个成员边界 |
| xml-mid | 65,536 | 2,370 | 2,191 | **179** | TEXT23 / WORD-PRE token3 |
| ooffice-code | 65,536 | 24,512 | 24,512 | **0** | BCJ25 / s2，容器 SHA 也相同 |

六行的当前 **baseline-off 完整容器与旧源码产物逐字节相同**，不是只比较长度。六个自然端点没有强制 spec、分组计划、文件名规则或测试专用调参。

另有完整固定窗：

| 固定窗 | 输入 B | 独立旧端点 B | 当前默认 B | 节省 B | 实际采用 |
|---|---:|---:|---:|---:|---|
| xml-mid | 262,144 | 6,274 | 4,542 | **1,732** | WORD-PRE merge；192 KiB 筛选后只编码一个完整新变体 |

输入身份沿用 [P14 固定窗口清单](../../scripts/diag/p14/slices.json)。短前缀现在先对完整、至多 256 KiB 的父窗验证 SHA，再仅编码前缀；不读取完整语料文件。原 Mozilla 256 KiB 旧源码 adaptive 超时后，主矩阵统一采用 64 KiB 前缀，偏移未变。`code/resources` 是历史窗口名称，**不是完整 Mozilla 文件终局分组目录或已验证的架构分类**。

### 收益拆分：不要把新增候选覆盖全算成 kernel 收益

只处理“旧最终赢家已经是 WIDE / WP”的第一版，在短 MR / XML 上无收益。最终实现补齐了有既存依据的候选入口，仍保留原容器。这部分收益与纯上下文收益必须区分：

| 输入 | 旧实际端点 B | 同成员布局标准 v20 控制完整容器 B | 新完整容器 B | 候选覆盖部分 B | 纯上下文相对控制 B |
|---|---:|---:|---:|---:|---:|
| MR 65,536 B | 14,056 | 12,213 | 12,117 | 1,843 | **96** |
| XML 65,536 B | 2,370 | 2,212 | 2,191 | 158 | **21** |
| XML 262,144 B | 6,274 | 4,708 | 4,542 | 1,566 | **166** |

MR 保留旧端点的两个原文成员及变换重置边界，因此端点 **12,117 B** 不等于强制单组 kernel 的 **12,045 B**。XML 64 KiB 最终 token3 为 2,191 B，merge 的 2,206 B 被拒绝。多个候选的收益不能相加。

### 自然语言保护

下列同样为固定窗的 65,536 B 前缀；旧/新完整容器 SHA 全部相同：

| 输入 | 旧 / 新 B | 原 P13.1 前缀 CM plain / token-body B | 结果 |
|---|---:|---:|---|
| dickens-mid | 19,649 / 19,649 | 19,627 / 21,881 | 原 `<0.99` 准入拒绝 |
| webster-mid | 16,107 / 16,107 | 16,086 / 16,224 | 原 `<0.99` 准入拒绝 |
| reymont-mid | 13,220 / 13,220 | 13,199 / 13,227 | 原 `<0.99` 准入拒绝 |

三个新阶段均没有调度完整 WP 上下文候选，`fullCandidateInputBytes=0`。这不是全自然语言文件的验收替代品，但证明没有把文本全局替换成 WP 新模型。

## 2. 格式与对称解码

| 字段 | 含义 |
|---|---|
| 容器 uint16 `0x4000` | v21 上下文能力，须同时有 v20 CM 能力 |
| 组 `rRaw` 位 17..19，mask `0xe0000` | 1=stride4；2=wide-geom；3=wp-token3；4=wp-merge；5..7 拒绝 |
| 组 `0x10000` | 原 v20 CM 内核位，保留 |
| 组 `0x8000` | 原 APM 内核位，**不是 a2-off 位** |
| 组 `0x4000` | 原 WORD-PRE 位，保留，与容器字段独立 |
| `rRaw & 0x3fff` | 真实 `r`；包括合法 `r=8192` 的 `0x2000` |
| 容器 `0x2000` | 原 BIN recovery 位，未挪作他用 |

`planHeader` 根据实际选中载荷的 flags 和 context 选择 v21。没有新上下文胜出时保留旧容器及版本，不把全部输出强制升级。v21 可混合未改变的 legacy-v15 组。缺少能力、缺少 APM/CM、模式与 profile/规则/WP 不匹配、保留模式、未知高位、v21 无上下文组等非法组合被拒绝。

`CMOptions.context` 是 CM / terrain API 的可选末参数。未指定时旧计算不变。编解码都按组标记显式选择上下文，不把新 payload 标成旧 v20。旧版解码器不支持 v21，使用新文件须更新解码器。

## 3. 生产实现与候选边界

关键代码：`src/lib/context-policy.ts`、`coder.ts`、`codec.ts`、`parallel.ts`、`parallel-jobs.ts`；生成文件 `parallel-worker-code.ts` 已同步，未手工编辑。

### P1：直接 BIN stride4

- 此仓库没有 `TransformID.RAW`。只允许恒等 BIN **5 / 19 / 24**，`s=r=1`、bin profile、`geomStride=0`。
- v20 的 H8 可选改为 `hh(b4, g(8), g(12), pos & 3)`；缺失历史为零。BCJ **11 / 20 / 25**、STORE 及变换后的内层 BIN 均不套用。
- 原文组至少 16 KiB；小组及 family/batch 合并组作完整实际比较。
- >=256 KiB 用至多 192 KiB 有界样本。样本完整单组成本超过 0.15% 改善才调度完整新候选；**筛选从不替代真实完整旧基线**。
- 旧单片 BIN19 包装器历史上忽略 kernel。没有全局修写该旧路径；新阶段的标准控制显式编码真实 v20，测试其 flags 与独立 `encodeCM(...,'v20')` 字节。已有真实 v20 载荷则直接保留/复用。

### P2：WIDE6–8 低平面几何

- 新上下文仅把 low/res2d 平面的 `geomStride` 设成 `r/2`，编码与解码对称。高平面不变，真实测试逐字节比较了高平面。
- 标准控制与新候选分别完整编码；新阶段正确继承两个平面的 flags。历史包装器默认行为保持不变，保证旧路径一致性。
- 已选择的 WIDE6–8 组直接参与上述候选门。
- **短组覆盖补充：** 仅对旧 chooser 已识别的 `GRAD_V3/s=2`，成员长度均偶数、既有行距合法，且 **16 KiB <= 合并组 <256 KiB**，沿用同一行距提出 WIDE6/7/8 几何候选。没有新的行距扫描、文件名规则或修改原 WIDE 探测阈值。每个提案都编码完整标准控制。
- >=256 KiB 仍由原 WIDE chooser 提供规则，不额外展开三份完整大组编码。

### P3：WORD-PRE token3 / merge

- 保留原词典/预处理、`.85` 坍缩限制及 **P13.1 `<0.99` 连续前缀 CM 准入**。不把一次性字典成本塞入旧准入公式；后续完整比较包含字典、4 B 前缀、CM 和容器头。
- token3 使用前前词 / 前词 / 当前词上下文；merge 使用审计过的 ASCII 字母与高字节联合词累积。两种都只有显式 WP 新模式才启用。
- 对最终 TEXT23 组尝试新变体，保留完整标准 v20 WP 控制。小组比较两个实际完整变体；大组的有界筛选只选择最好的一种作完整新编码。
- **既存文本试探覆盖：** 对原文本/锚点规则，仅当每个成员均为 text、且每个成员的原有 trials 实际包含 TEXT_V3 时，允许重新提出对应 WP 候选。仍经过同一准入和双重完整成本门。不是全局文本替换，不跨组重分段。
- 默认 raw text 与 WORD-PRE 均 a2-on；历史 `textOn=false` 和 WP 专用 off 标志仍支持并已验证。

## 4. 严格不回退的完整容器门

顺序不变：先完成真实 P13.1 chooser、family、orphan、macro、WIDE 等原有最终比较，再运行新阶段。编码时按容器 WeakMap 保留各组原始实际 payload、内核/WP 元数据和成员目录；不从估算比例重建旧基线。

设当前实际组 payload / 完整容器为 `P_old / C_old`；完整标准 v20 控制为 `P_control / C_control`；新候选为 `P_new / C_new`。只接受：

```text
P_new < P_old     && C_new < C_old
P_new < P_control && C_new < C_control
```

`C_control` 与 `C_new` 都调用真实 `planHeader`，连同所有其它当前组的实际 payload 计价。相等、头变贵、候选异常都不能换掉安全结果。多次接受构成严格递减序列，最后再确认完整容器确实小于最初旧容器。

- 原规则字典 key 预留，新候选不能覆盖另一组；后续提案也检查实际选中 key 冲突。
- 如果换了候选规则，正确更新 segment spec / label / context / modelFlags，并移除旧 anchor/peel/micro 描述；原 buffer 与原 metadata 不被就地改写。
- segment 压缩字节为精确整数分摊，合计加 header 等于最终 UCZ 字节数。**热力图只是旧成本的重新加权，不是新模型逐 bit 归因。**
- `compressAdaptive(..., {contextCandidates:false})` 跳过新阶段；Node pool 仍由现有 outer `finally` 关闭。
- worker 计算候选，不选择容器。`contextGroup` 回复携带实际 payload flags、准入/筛选数据；主线程恢复 flags 并经过同一个完整门。

## 5. 验证结果

### 格式、内核与 worker

- v21 合法/非法组合、旧 v20 拒绝新标记、混合 legacy-v15、保留模式、未知位、BCJ/STORE 排除：PASS。
- 三个 BIN ID 的单片/多片、短历史、WIDE6/7/8 的 **r8192** 和成员边界、高平面不变、WP 三种 a2 配置：PASS，其中额外格式分片完成 **12 个实际 roundtrip**。
- 完整门的相等、候选错误、保留原 buffer、BCJ 排除、字典 key 冲突：PASS。另有真实序列化头成本例：payload 100→99 B，而头 16→20 B，必须拒绝。
- 四种新上下文的 256 KiB **标准控制及新载荷 SHA 都与独立冻结的 P14 审计相符**：

| 固定布局验证，**不是 adaptive** | 标准完整容器 B | 新完整容器 B | 差额 B |
|---|---:|---:|---:|
| Mozilla-code BIN stride4 | 72,080 | 70,600 | −1,480 |
| MR WIDE6 geom | 49,259 | 48,795 | −464 |
| XML WP token3 | 4,708 | 4,563 | −145 |
| XML WP merge | 4,708 | 4,542 | −166 |

- 有界 192 KiB 实际 screen 与完整候选验证 PASS；XML 256 KiB 自然入口的两种 WP 样本成本为 3,860 / 3,856 B，完整阶段只调度 merge。
- 真正生成的 BIN19 / WP Node worker：payload、flags、控制与筛选信息和串行一致，且能生产解压。
- MR 自然 `compressAdaptive` 并行入口：**3 个实际 context worker jobs，0 fallback**；完整输出与同源码串行逐字节一致。请求 4 线程，不把请求值当成实测活动核数或全文件吞吐。
- 当前解码器已解开 **10 份独立 ed09309 adaptive 容器**、4 份冻结 v15/v17 样本；另有 P12 historical shard 验证独立 v18 / 旧无 fixed-mht4 位的 v19 / WP 参考流。未更改这些历史样本。

### 分别有界运行的项目检查

| 检查 | 结果 |
|---|---|
| `npm run check:worker` | PASS |
| `npx tsc --noEmit` | PASS |
| `npx tsc --noEmit -p tsconfig.p141.json` | PASS |
| `npm run build` | PASS，Vite 产物 439.66 kB，gzip 143.87 kB |
| `npm run test:ui` | 14/14 PASS（调度/展示回归，不是新的浏览器性能测试） |
| 现有三份 metadata test 文件 | 22/22 PASS |
| P12 historical decode shard | PASS |
| P13.1 gate shard | PASS |
| P13.1 真实 worker / restoration shard | PASS |

回执见 `p141-results/checks/`。**完整 legacy `test:codec` 未运行，不标成 PASS。** P14 的 112 份历史审计回执、审计报告和当前 baseline lock 均由 Git diff 验证未变；没有修改旧 P14 final verifier 来掩盖新的生产代码差异。

## 6. 失败记录与阶段修复

以下六份 FAIL 均保留在不可覆盖的回执目录与最终索引：

| 失败 | 原因 / 处理 |
|---|---|
| Mozilla-code 256 KiB 旧源码 adaptive 超时 | 17 秒子进程预算到期；主矩阵改为明确标注的固定 64 KiB 前缀，没有延长重跑 |
| Mozilla resources 初版 current 失败 | BIN19 误用只支持 v3 的拼接助手；改成新候选专用恒等拼接，补三 ID 单/多片测试 |
| MR 64 KiB 初版收益断言失败 | 最终 GRAD3 组没有新候选；后续通过既存两字节行距的窄范围候选补齐 |
| MR 256 KiB 旧源码串行超时 | 保留失败；不改成固定 WIDE 的端点证据 |
| MR 256 KiB 旧源码请求并行仍超时 | 原池受 >=2 jobs / >=512 KiB load 门槛约束；没有把请求线程数当成实际工作线程数 |
| XML 64 KiB 初版收益断言失败 | 最终 anchor 赢家漏掉对应 WP 候选；后续仅重开已有 TEXT_V3 trials 的文本组，原完整赢家仍保留 |

此外，早期 worker 测试只验证新候选回复，未充分验证单片 BIN19 的标准控制；代码审查/flags 检查暴露后，补上真实 v20 控制、独立标准字节断言与 worker 往返。旧 PASS 回执没有被用来宣称它当时已证明这项控制性质。

初版 XML 256 KiB 的 6,274→6,274 B 仅是零回退 PASS，不是收益 PASS；最终同一输入在覆盖补齐后为 6,274→4,542 B。前后回执及源码快照均保留，不能只留下正结果。

## 7. 复现与后续完整验收

工作目录为项目根目录。每次只执行一个有界分片，例如：

```sh
timeout --signal=KILL 19s node tests/p141-implementation.test.mjs wire
timeout --signal=KILL 19s node tests/p141-implementation.test.mjs format-extra
timeout --signal=KILL 19s node tests/p141-implementation.test.mjs guard
timeout --signal=KILL 19s node tests/p141-implementation.test.mjs proposals
```

一个自然端点的独立对照顺序（不要合并成一个长期脚本）：

```sh
timeout --signal=KILL 19s node tests/p141-implementation.test.mjs adaptive mozilla-code old 65536
timeout --signal=KILL 19s node tests/p141-implementation.test.mjs adaptive mozilla-code off 65536
timeout --signal=KILL 19s node tests/p141-implementation.test.mjs adaptive mozilla-code current 65536
```

六个目标与额外窗口列于 [cases.json](../../scripts/diag/p141/cases.json)。`kernel <slice> <context>` 和 `screen <slice> <context>` 明确标为固定布局，不能替代 `adaptive`。`worker xml-mid wp 65536` 运行实际 WP worker；`adaptive mr-mid current-parallel 65536` 要先有同源码串行输出，用于逐字节一致性检查。

只读证据复核，不编码、不读语料：

```sh
timeout --signal=KILL 19s node scripts/diag/p141/verify.mjs --verify
```

验证器核验归档脚本/源码 SHA、逐份回执 SHA、独立旧 Git 源码、最终同源码矩阵、六个 baseline-off、三个自然语言保护、worker 一致性、项目检查及历史失败清单。`summary.json` 是一次性创建的索引；新增测量后应创建新的明确检查点，不覆盖旧证据。

完整 12 文件已由用户报告在本机 16 核环境验收（见文首）；后续版本仍须：必须同源码、完整输入 SHA/大小正确、真实压解压通过，且**每个文件分别 <= 当前 bestUcz**。一文件多 1 B 不能被别的收益抵消。然后分别检查两个严格总量上界，不按切片外推。

现有 `scripts/diag/p13/local-validate.sh` 可在用户本机收集同源码完整 JSON，但其末尾仍有历史 P13 的 **−35% 时间门**，使用存档 **2137.2 s / 1389.18 s**，不是本次两个字节目标，也不是后来用户报告的 2137.5 s；本次没有修改或混合这些时间基准。Arena 未执行该长程脚本。本次后续本机报告已授权锁定 P14.1；仍未超过 Cubrim 或进入 40M。
