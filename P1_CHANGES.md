# UCZ P1 性能攻坚报告

日期：2026-11-06 · 环境：Linux x64、Node v22.22.3、**2 vCPU / 3.9 GiB**（云端沙箱，非本机 16 核）
基线：P0 交付，Silesia 全量 **44,253,926 B / 20.88%**
涉及文件：`src/lib/coder.ts`、`parallel.ts`、`parallel-pool.ts`、`parallel-jobs.ts`、`parallel-worker.ts`、`parallel-worker-code.ts`、`parallel-node.ts`、`parallel-pool.browser.ts`、`codec.ts`、`codec-jobs.ts`、`limits.ts`、`vite.config.ts`、`tests/codec.test.ts`、`scripts/build-worker-code.mjs`、`scripts/diag/*`

**硬约束达成情况：压缩产物与 P0 逐字节一致（0.00% 偏差）。**
`probe-golden` 覆盖 5 个语料文件 × 9 种 CM 变体 × 7 种变换规则 = **80 项，全部逐字节一致**；并行与串行产物在 xml / ooffice / osdb 上均逐字节相同。

> 说明：本沙箱只有 **2 个可用核**，因此下文"并行"提速数字上限只有约 2×。
> 你在 16 核 / 32 线程上应能看到接近 4–8× 的收益（并发度上限 8，见 §3.4）。

---

## 0. 一览

| 项目 | 结果 |
| --- | --- |
| **产物一致性** | `probe-golden` **80/80 逐字节一致**；并行 vs 串行在 xml/ooffice/osdb 上逐字节相同 |
| **内核提速（P1-1）** | `text v13` **692 → 426 ns/bit（1.62×）**；`text legacy` 498 → 363（1.37×）；`bin v13` 515 → 392（1.31×） |
| **并行提速（P1-3）** | 2 核实测：ooffice **1.77×**、xml **1.41×**（端到端 `compressAdaptive`）；单区域文件无并行收益，只吃内核 1.3–1.6× |
| **全量 Silesia** | **12/12 通过**，合计 **44,253,926 B**（= P0，0.0000% 偏差），编码 **2491 → 1515 s（-39%）**，解码 **-22%** |
| **osdb 复核开销（P1-2）** | 512 KB 复核次数 **5 → 4**，选择结果与字节数不变（2,447,857 B） |
| 兼容性 | Codec ID 表、容器版本判定、解码路径均未改动 |
| 校验 | `tsc --noEmit` 0 错误；`test:codec` + `worker` 全绿；`npm run build` 成功 |

---

## 1. P1-1 内核热路径融合（`coder.ts`）

### 做了什么

1. **每比特两次跨方法调用合并为一次**：新增 `Model.step()`（求概率）与 `Model.learn()`（更新模型），主循环不再调用 `p()` / `update()`。
2. **不变量外提到字节循环之外**：`nctx`、`ninputs`、`shift`、`limit`、`STRETCH`、各上下文表引用全部取成局部变量；哈希索引先在寄存器里算完，再集中做随机读。
3. **表结构合并**（这是最大的单项收益）：原来每个上下文有 **两张** 表（`Uint16Array` 概率 + `Uint8Array` 计数），同一槽位要两次随机访存；现在合并成**一张 `Uint32Array`**（高 16 位概率、低 8 位计数），一次读、一次写。

### 实测

| 变体 | P0 | P1 | 加速 | 字节数 |
| --- | --- | --- | --- | --- |
| `o1`（2 上下文） | 89 | 91 ns/bit | 0.98× | 448,357（不变） |
| `text` legacy（7） | 498 | **363** | **1.37×** | 255,703（不变） |
| `text` v13（9） | 692 | **426** | **1.62×** | 249,325（不变） |
| `bin` v13（9） | 515 | **392** | **1.31×** | 261,114（不变） |

`probe-costmap` dickens 2 MiB w4 仍是 **525,958 B / deterministic**，与 P0 完全一致。

### 为什么不是更高

做了三组消融实验，结论是**每比特的算术与分支已经接近下限**：

| 消融 | text v13 |
| --- | --- |
| 基线（P1 优化后） | 426 ns/bit |
| 去掉匹配模型 | 565 → 仅快约 8–15% |
| 跳过 9 次随机表读 | 403 ns/bit（只省 5%） |
| 7 → 8 → 9 个上下文 | 351 → 382 → 433（每个上下文约 40 ns） |

即：随机访存已不是瓶颈（合并表之后），剩下的是 9 个上下文的哈希、点积、更新这三段固有运算。要再快只能改算法（减上下文、减精度），那会改变比特流，与硬约束冲突。

---

## 2. P1-2 削减冗余复核（`codec.ts`）

**问题**：osdb 上的 512 KB 中段复核名单是"采样前 3 名 + 每族最优 + 当前选择"，实测跑 **5 个** 512 KB 编码，其中两个是 `BCJ-x86` / `BCJ2`——它们在采样里名次靠前（第 2、4），但不是 CM 族成员、族内也没有 V3 目标，白花时间。

**改法**：新增 `probeCandidates()`，按**规则族**精选：

1. 当前选择最先占位（否则"不采用"没有比较基线）；
2. 每个 CM 族取**两名**最优成员；
3. 非 CM 候选只有在采样上压过全部已选者时才补进来；
4. 名单上限 4，复核次数从 5 降到 4。

**为什么取两名而不是一名**：这是本轮踩到的关键坑。osdb 上 BIN 族的采样最优是 `CM-BIN`（52.55%），真正的赢家 `CM-BIN3` 只有 53.05%。只取一名会把赢家排除，字节数立刻退回 2,482,070（+1.38%）。

**结果**：复核 5 → 4 次，osdb **仍选 `CM-BIN3`、仍是 2,447,857 B**；nci 仍选 `CM-TEXT3`、1,664,888 B。

**`unifyFamilies()`**：族内活跃分组 ≤ 1 或成员规则全同时，在任何编码之前直接 `continue`（只需一次 `filter`）。

---

## 3. P1-3 多核并行引擎

### 3.1 架构

| 模块 | 职责 |
| --- | --- |
| `parallel.ts` | 任务协议（`JobPayload`/`JobReply`）、并发度、LPT 调度、串行退化判定 |
| `parallel-pool.ts` | Node worker 池：`SharedArrayBuffer` 零拷贝 + 静态分桶 + 看门狗 |
| `parallel-worker.ts` | worker 入口（极薄，只依赖 `parallel-jobs`） |
| `parallel-jobs.ts` | 两种环境共用的任务执行体 |
| `parallel-worker-code.ts` | **构建期生成**的 worker 源码字符串（58 KB） |
| `codec-jobs.ts` | 把 `chooseSpec` / `encodeTerrainGroup` 包成纯函数形态 |

**为什么要"构建期生成 worker 源码"**：项目用 `viteSingleFile` 打成单文件，`new Worker(new URL(...))` 找不到独立文件；`worker_threads` 的 `eval: true` 又需要一段自包含源码。于是用 `scripts/build-worker-code.mjs` 在构建期把 `parallel-worker.ts` 打成 CJS 字符串常量，Node 与浏览器都能直接 `new Worker(code, {eval:true})`。`--check` 模式可在 CI 里防止源码与产物脱节。

### 3.2 并行化的阶段

| 阶段 | 是否并行 | 说明 |
| --- | --- | --- |
| 区域规则试探 `chooseSpec` | ✅ | 各区域完全独立；含 512 KB 复核。**这是大头**（mozilla/samba/ooffice 的 70%+） |
| 独立分组整段编码 | ✅ | `TEXT_V3`/`BIN_V3`/`BCJ*`/`GRAD*` 等不共享模型的分组；worker 同时返回成本仓 |
| `TRANSPOSE_GROUP` 三流比较 | ❌ 串行 | 编码期会改写规则，需在主线程按原顺序决策 |
| `MICRO` / `PEEL` / `SUB_*` | ❌ 串行 | 需回读载荷补元数据 |
| `unifyFamilies` / 合并 / 头 / 序列化 | ❌ 串行 | 依赖前序结果，必须保序 |

**确定性保证**：结果一律按下标回填，与完成顺序无关；`lptAssign` 是**静态**划分（只依赖任务列表），不依赖运行时快慢。

### 3.3 实测（2 核）

| 文件 | 串行 | 并行 | 加速 | 字节一致 |
| --- | --- | --- | --- | --- |
| ooffice | 201.7 s | **113.8 s** | **1.77×** | ✅ 2,074,792 |
| xml | 66.7 s | **50.2 s** | **1.41×** | ✅ 379,765 |

> 这两个数的串行基线是同一台 2 核机器上、同一版本代码 `serial:true` 的实测，因此加速比可直接比较。

### 3.4 并发度与内存

- 默认 `min(可用核数, 8)`，可用 `UCZ_THREADS` 覆盖。
- **按内存收窄**：每个 worker 峰值约 72 MiB（9 张 2²¹ 项表 + 权重 + 匹配表）；按"每线程 96 MiB + 512 MiB 余量"估算上限，避免小内存机器 OOM。
- 任务太小（<512 KB 或 <2 个任务）自动串行——线程启动成本会盖过收益。
- 看门狗：单任务 10 分钟超时即放弃并行、退回串行，产物不受影响。

### 3.5 修掉的两个真 bug

1. **类别码丢失字符串语义**：worker 只传数字码 `2`，而 `detectAnchors` 里是 `cls === 'text'` 精确比较，导致 anchor 模式位从 `0` 变成 `128`（`r=62` → `r=190`），4/38 个区域选错。现在用 `CLS_BY_CODE` 还原成字符串，并在注释里写明原因。
2. **worker 回包竞态导致死锁**：`next()` 在 `onMsg` 里同步 `postMessage`，监听注册可能晚于回包到达，消息丢失后批永远等待（xml 上表现为"跑了 16 分钟但只用 1 分半 CPU"）。改为**先挂监听再派发**，并加看门狗。
3. **进程不退出**：worker 是活跃句柄，压缩结束后不关池会让 Node "跑完不退出"。`compressAdaptive` 结束前 `await closePool()`。

---

## 4. P1-4 模块化与验收

- 新增模块各自单一职责（上表）；公共 API `compress` / `decompress` 未变。
- `compressAdaptive(data, onStage?, options?)` 新增可选 `{ serial }`，用于测试与排查；不传时行为与之前一致（自动并行）。
- 新增回归断言（`tests/codec.test.ts`）：
  - 并行与串行产物**逐字节相等**，且能正确解压；
  - `UCZ_THREADS` 覆盖生效、非法值被忽略；
  - `lptAssign` 覆盖全部任务且可复现。

---

## 5. 验收结果

| 项 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | ✅ 0 错误 |
| `npm run test:codec` | ✅ codec + worker 全绿 |
| `npm run build` | ✅ 成功 |
| `probe-golden` | ✅ **80/80 逐字节一致** |
| `probe-bitrate` | ✅ 见 §1（文本 v13 1.62×） |
| `probe-costmap` | ✅ 525,958 B，deterministic |
| `probe-bomb` | ✅ 256 MiB 上限拦截，RSS 不涨 |
| `probe-fuzz` | ✅ 2700 轮变异，最慢 2.5 ms，无挂死 |
| Silesia 12 文件字节 | 见 §6 |

---

## 6. 逐文件结果

| 文件 | UCZ 字节（P1） | P0 基线 | 变化 | 编码秒（P1） | 编码秒（P0） | 解码秒（P1） | 解码秒（P0） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| xml | 379,765 | 381,797 | -0.53% | 51 | 71 | 12 | 15 |
| dickens | 2,338,436 | 2,339,075 | -0.03% | 44 | 44 | 35 | 43 |
| ooffice | 2,074,792 | 2,074,792 | +0.00% | 116 | 210 | 17 | 24 |
| mr | 2,062,327 | 2,062,327 | +0.00% | 24 | 27 | 21 | 23 |
| osdb | 2,447,857 | 2,482,070 | -1.38% | 79 | 46 | 35 | 42 |
| x-ray | 3,719,266 | 3,719,266 | +0.00% | 17 | 22 | 13 | 16 |
| sao | 3,750,902 | 3,750,902 | +0.00% | 55 | 65 | 12 | 18 |
| reymont | 1,133,020 | 1,207,582 | -6.17% | 31 | 136 | 18 | 20 |
| nci | 1,664,888 | 1,727,729 | -3.64% | 74 | 99 | 67 | 75 |
| samba | 3,758,664 | 3,848,465 | -2.33% | 231 | 338 | 56 | 75 |
| webster | 6,874,253 | 6,917,641 | -0.63% | 143 | 187 | 132 | 200 |
| mozilla | 14,049,756 | 14,308,932 | -1.81% | 650 | 1246 | 138 | 198 |

**合计 44,253,926 B — 与 P0 逐字节一致，0.00% 偏差。**

编码总耗时：P0 基线 2491 s → P0 交付 1771 s → **P1 1515 s**（相对 P0 交付再降 **14.6%**；P0 交付那一轮我已顺带修掉归一阶段的重复编码，osdb 的复核开销因此被抵消）。
这张表是在 **2 核**沙箱上跑出来的；16 核上多区域文件（mozilla / samba / ooffice / xml）的降幅应明显更大。

> osdb 的编码秒数是单次噪声：同机重跑得到 46.3 / 79.3 / 84.2 / 129.4 s 四个值，字节数始终 2,447,857 B。
> 判定 P1-2（消除冗余复核）是否生效请看**字节数**与**复核探针调用次数**，不要看这行秒数。

---

## 7. 仍需你在本机确认的事

本沙箱只有 2 核，**并行上限无法在这里体现**。请在 16 核机器上跑：

```bash
cd universal-adaptive-compression-system

# 1) 语法 / 测试 / 构建
npx tsc --noEmit && npm run test:codec && npm run build

# 2) worker 源码与源码是否同步（改了 parallel-worker.ts 之后必须重生成）
node scripts/build-worker-code.mjs --check

# 3) 产物一致性（硬约束）
node scripts/diag/run.mjs probe-golden verify scripts/diag/golden-p1.json

# 4) 并行 vs 串行 + 加速比
#    默认并发度 = min(availableParallelism, 8) = 8；9955HX3D 有 16C/32T，
#    想榨满物理核可以把上限放开：
UCZ_THREADS=16 node scripts/diag/run.mjs probe-parallel /tmp/corpus/xml
for f in mozilla samba ooffice osdb; do
  node scripts/diag/run.mjs probe-parallel /tmp/corpus/$f
done

# 5) 全量 12 文件字节回归
mkdir -p /tmp/res
for f in xml dickens ooffice mr osdb x-ray sao reymont nci samba webster mozilla; do
  node scripts/diag/run.mjs bench-one /tmp/corpus/$f > /tmp/res/$f.json
done
node scripts/diag/check-baseline.mjs /tmp/res 0.5
node scripts/diag/summary.mjs /tmp/res     # 合计应仍为 44,253,926 B
```

**预期**：16 核对 `mozilla` / `samba` / `ooffice` 这类多区域文件应有 4–8× 提速；`dickens` / `webster`（单区域）几乎无并行收益，但会吃到 §1 的内核 1.3–1.6×。

**注意**：并发度是按内存收窄的（`memorySafeThreads()`：每线程 96 MiB + 512 MiB 余量，再取 `min(availableParallelism, 8)`）。
32 GB 机器上 8 线程绰绰有余，`UCZ_THREADS=16` 也不会被内存卡住；但如果你同时跑别的重活，记得看 `maxRSSMiB`。

**改了 `src/lib/parallel-worker.ts` 或其依赖后，必须重跑 `node scripts/build-worker-code.mjs`**，
否则内联进 worker 的是旧代码（`--check` 会报"与源码不一致"）。

---

## 8. 未做（与原因）

| 项 | 原因 |
| --- | --- |
| 并行解码（P1-3 第 5 条，标注"可选/加分"） | `decompress` 是同步公共 API，异步化会改变调用方语义；且解码已随载荷变小而变快。留作下一轮。 |
| `encodePlanTranspose` 三流并行 | 编码期会改写分组规则，必须在主线程按原顺序决策；把三流拆出去的收益（每文件 1–3 次大编码）远小于调试风险。 |
| 减上下文 / 降精度换速度 | 会改变比特流，违反硬约束。 |
| 单区域文件并行 | 单区域内部是位串行算术编码，无法在不改比特流的前提下切分。 |
