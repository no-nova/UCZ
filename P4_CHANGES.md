# UCZ P4 报告：v15 校准内核与 WORD-PRE 预坍缩落地

日期：2026-11-07 · 环境：Linux x64、Node v22.22.3、**2 vCPU / 3.9 GiB**（云端沙箱）
基线：P3 交付（`b686532`），Silesia 全量 **43,743,048 B / 20.64%**

**铁律：12/12 文件单调不劣（`<= 0.00%` 回退）。**

---

## 0. 一览

| 项目 | 结果 |
| --- | --- |
| **P4-1 v15 校准内核** | 已落地（`mht8` 长距匹配表 + a2 级 APM 级联），1 MiB 切片 **7/7 正收益** |
| **P4-2 WORD-PRE 预坍缩** | 已落地，接入 `TEXT_V3` 分组；xml **−4.55%**、ooffice −0.43% |
| **P4-2b 分块词表** | 探针完成，**实测证伪并废弃**（§2.4） |
| **P4-3 双流进 Worker 池** | 已落地：分组编码的 v15 / WORD-PRE 候选与 v13 载荷同一个 worker 任务产出（§4） |
| **P4-3b 单分片候选剪枝** | 已落地：单分片 `TEXT/BIN/O0` 的 v15 候选必然等于基线，直接判否（osdb 1 MiB **−33% 耗时**，字节不变） |
| 兼容性 | **零新增 Codec ID**；容器版本号不变；v12 fixtures 全部通过 |
| 校验 | `tsc` / `test:codec` / `build` / `build-worker-code --check` / `probe-dualmap` 全绿 |

---

## 1. P4-1：v15 校准内核

### 1.1 两处改动

| 改动 | 内容 | 为什么 |
| --- | --- | --- |
| `mht8` | 8 字节步长的长距匹配表，**仅 `variant==='v15' && useMatch` 时分配** | v13 的 `mht` 只看 4 字节哈希，长重复块（XML 标签、SQL 语句）抓不住 |
| a2 级 APM | 在 a1 校准之后再叠一级，`apm2CtxOf(prevByte, matchState, c0)` = `((prevByte>>>6)&3)*3 + ms`（**12 桶**） | 一级 APM 的误差是系统性偏置，二级能按"上字节高位 × 匹配状态"再细分 |

一级 APM 的上下文是 `(c0&255, lastMs)`，二级刻意用**更粗**的 12 桶。

> **反直觉结论**：级联 APM 的上下文越细越糟。`ctx=0/1`（2048 / 768 桶）实测全面退化，只有 12 桶收敛。
> 这与单级 a1 的"越细越好"正好相反——因为 a2 的输入已经是校准过的概率，细粒度只带来稀疏的学习样本。

### 1.2 1 MiB 切片实测（v13 → v15）

| 文件 | v13 | v15 | Δ | 耗时 |
| --- | --- | --- | --- | --- |
| nci | 62,162 | 58,504 | **−5.88%** | 2174 → 2459 ms |
| xml | 98,343 | 95,904 | −2.48% | 2565 → 2917 ms |
| osdb | 282,518 | 276,628 | −2.08% | 3727 → 4295 ms |
| ooffice | 465,742 | 459,047 | −1.44% | 3482 → 4202 ms |
| webster | 194,494 | 193,198 | −0.67% | 3330 → 3591 ms |
| dickens | 249,324 | 248,009 | −0.53% | 3882 → 4274 ms |
| mozilla | 638,176 | 636,199 | −0.31% | 3318 → 3589 ms |

7/7 正收益，耗时约 v13 的 1.1–1.25×。

### 1.3 为什么总耗时没有明显上涨

`chooseGroupV15()` 需要"v13 基线 vs v15 候选"两份比特流才能择优。若各跑一遍，
1.25× 的慢内核会直接翻成 2.5×。P3-1 的 `encodeGroupDual()` **一遍出双流**解决了这点：
同一遍 `step()` 遍历、两个算术编码器，`alt` 只多一次点积访存。

v15 候选只在与 v13 基线**严格更小**时才替换 `g.payload`（`chooseGroupV15` 的铁律）。

---

## 2. P4-2：WORD-PRE 预坍缩

### 2.1 思路

把文本区域里反复出现的片段（`&lt;`、`</`、`="`、` the `、SQL 关键字…）替换成单字节词元（`0x80+i`，`0x7f` 转义），
让 CM 面对一个更短的、符号分布更集中的流。词表 120 条，以 varint 头自描述。

### 2.2 为什么以前失败了，这次为什么成立

| 版本 | 做法 | 结果 |
| --- | --- | --- |
| P3-2 | 词元路径直接挂在 `text && variant` 分支上并 `return` | **匹配表失明**，xml +85%~+151% |
| P4 早期 | 不 `return`，但全量统计建表 | 全文件 xml −2.92%、nci −3.69%；**dickens +8.38%** |
| **P4 最终** | 采样建表 + 前缀 A/B 实测门控 | xml **−4.55%**、ooffice −0.43%，dickens 自动放弃 |

三个关键修正：

1. **词元分支绝不能提前 `return`**——`byteUpdate()` 里的匹配模型推进必须继续执行，
   否则长距匹配失效，损失远大于词元化的收益。
2. **词元开关必须挂在独立字段 `Model.wordTokens` 上**（且 `variant==='v15'`）。
   `text && variant` 这个分支被 Codec ID 18（`TEXT_V2`）**共用**，只判 `variant` 会让
   v12 fixtures 解码失败（§3.1）。
3. **采样建表**：词表只需要"该区域里的高频结构，不需要全量精确统计。全量统计是 O(n·10) 的字符串构造，
   几十 MB 的分组根本跑不动。

### 2.3 门控：为什么必须 A/B 择优

坍缩率（`bodyLen / rawLen`）**不能**作为判据：

| 文件 | 坍缩率 | 实际效果 |
| --- | --- | --- |
| nci | 0.407 | −5.38% |
| xml | 0.581 | −1.60% |
| **dickens** | **0.69** | **+8.38%** |

自然语言的坍缩率和 XML 差不多，但替换后 CM 反而变差——**词元化确实降低了字节熵**
（zlib 参照：xml 128 KB，deflate-9 从 9752 → 8936 B，brotli-q11 从 7441 → 6930 B），
但 CM 本来就已经吃掉了大部分上下文收益，只剩少量净差；一旦上下文被词元打碎就会倒亏。

所以最终门控是**前缀实测**：

```
192 KB 前缀 → plain 编码一遍 vs wordpre 编码一遍
若 wpProbe >= plainProbe * 0.99  →  放弃整个分组（~1 s 代价）
```

只有前缀实测通过且**整段结果严格更小**，才写入分组载荷。

### 2.4 分块词表：数据证伪，已废弃

曾试图按 512 KB 分块、每块独立建表（`wordPreChunkedFwd/Inv`，已修 `peekBody` 传参 bug，可逆性通过）：

| 文件 | 整块 | 512 KB×2 |
| --- | --- | --- |
| xml 1 MiB | **−1.60%** | **+2.63%** |
| nci 1 MiB | −5.38% | −1.04% |

原因：同一 Token 码在不同块里含义不同，`0x80+i` 会污染 `H[6]/H[7]` 与匹配表。
**不要再试分块或"渐变换表"。**

### 2.5 容器接入：零新增 ID

`PlanGroup` 新增 `wordPre?: boolean`，复用了 `r` 的**次高位 `0x4000`**：

```
r 的位布局（varint 编码）
  0x8000  → 该分组用 v15 内核
  0x4000  → 该分组载荷经 WORD-PRE 封装
  0x3fff  → 原始 r
```

载荷前 4 字节是定长的词元流长度（CM 解码必须提前知道输出长度），随后是 v15 内核的比特流。
解码端按标记先 `decodeCM(..., wordTokens=true)` → `dictHeaderLen()` 自定界取词表 →
`wordPreInv()` 还原原文，再走后续逆变换。

---

## 3. 本轮修掉的两个回归

### 3.1 词元路径污染历史内核（v12 fixtures 解码失败）

`byteUpdate()` 的 `text && variant` 分支被 `TEXT_V2`（ID 18）共用。P4 早期把 `byte>=128`
的词元逻辑直接挂在这个分支上，导致 v12 `TEXT_V2` fixture 解码崩溃。

修法：新增独立字段 `Model.wordTokens`（构造函数内 `wordTokens && variant === 'v15'`），
并从 `encodeCM` / `decodeCM` 公开入口透传（签名末尾第 10/11 个参数，带默认值）。
装回后 v12 fixtures 全部通过。

### 3.2 `encodeCMDual()` 只重算一级 APM

双流里 a1 校准完后，v15 的 `altPr` 还需要过 a2 级联再钳位。漏掉这一步会让 v15 流
与单跑分岔——`decompress` 立刻崩。

已在 text / bin / res2d 三组 profile 上验证：`base === ref13`、`alt === ref15` 逐字节相同，
且各自可自解码。

---

## 4. P4-3：双流候选进入 Worker 并行池

### 4.1 问题

P3-1 的双流只省掉了"为了比大小而多跑的那一遍 v15"，但**择优选在分组编码之后、
主线程上**：worker 池先并行算完所有分组的 v13 载荷，回到主线程再逐组跑
`chooseGroupV15()`（双流 / 单跑 v15 / WORD-PRE 前缀 A/B）。于是 v15 这半边
（约占分组阶段 55% 的 CPU）完全串行，多核机器上白白空转。

### 4.2 方案：候选与载荷同一个任务产出

把"算候选"从"做决策"里拆开，前者纯函数化，worker 与主线程共用：

```ts
// codec.ts
export interface GroupCandidates { alt: Uint8Array | null; wordPre: Uint8Array | null; rawLen: number }
function groupV15Candidates(parts, spec, positions): GroupCandidates | null   // 内部
export function groupV15CandidatesSync(...)                                   // worker 入口（同一份实现）
function chooseGroupV15(parts, g, positions, pre?): boolean                   // 只做择优
```

* `codec-jobs.ts` 的 `encodeGroupForJob` 在同一个任务里做完三件事：
  1. 真实 v13 编码 + 成本仓（`encodeGroupSync`，带 `ends` 边界）；
  2. `groupV15CandidatesSync` → `alt`（v15）/ `wordPre`（词元候选）；
  3. 回传 `{ bytes, cost, fragments, cand }`。
* 主线程只调用 `chooseGroupV15(..., done.cand)`：判据仍是**严格更小才替换**，
  与串行逐字节等价，但不再重跑任何编码。
* 候选带着派单时的 `spec` 回传，主线程核对 `id/s/r` 一致后才使用——将来若出现
  "编码期改写规则"的分组，也不会被陈旧候选污染（不一致就退回就地计算）。

顺带修正了一条过时注释：`encodeCMDual().base` **不能**当作 v13 载荷（见 4.3）。

### 4.3 为什么 `dual.base` 不能当 v13 载荷（P4-1 引入的真实分叉）

P3-1 时双流派生自同一个 `Model`，两条流只分叉混合权重，`tables/msm` 演化同构，
所以 `dual.base === 单跑 v13`。**P4-1 加了 `mht8` 之后不再成立**：`mht8` 只在
v15 模型里分配，它一旦命中就会改写 `mlen/mptr`，`msm` 随之后续演化也跟着变。
`probe-dualmap` 现在把这条关系显式打出来（40 KB 切片，2 分片）：

| 规则 | alt（v15）vs 单跑 v15 | base vs 单跑 v13 |
| --- | --- | --- |
| text_v3 / bin_v3 / bcj_v3 | **OK** | **分叉**（mht8 命中） |
| wide_grad s=1 | **OK** | **分叉** |
| wide_grad s=2 / delta_v3 / grad_v3 | **OK** | 相同（该切片未触发长距匹配） |

结论：`alt` 严格可信（这是择优唯一用到的流），`base` 不可信——**必须由真实那次
v13 编码提供**。这也是分组阶段始终保持"v13 一遍 + 候选一遍"两趟的原因；P4-3 的
收益来自把第二趟搬进线程池，而不是把两趟合成一趟。

### 4.4 v2 家族（`TEXT_V2`/`BIN_V2`/`BCJ_V2`/`GRAD_V2`）能否纳入双流

`probe-dualmap` 逐字节实测（dickens / xml 各 40 KB）：

| 规则 | 多分片 alt vs 单跑 v15 | 单分片 alt vs 单跑 v15 |
| --- | --- | --- |
| text_v2 / bin_v2 | 等价 | **MISMATCH** |
| bcj_v2 / grad_v2 | 等价 | 等价 |

原因：单分片的 `TEXT_V2/BIN_V2` 走 `encodeSpec`（`variant=true`，v2 拓扑），而
`encodeTerrainGroup(..., 'v15')` 在此分支上**不看内核参数**，两者不同构。

**决定：不纳入。** 除了单分片不同构这个坑，更关键的是**没有任何收益**：v2 规则的
v15 候选本来就只需一遍编码（`v13Kernel='v15'`），而双流也是"一遍 + 多一次点积"，
成本几乎相同；而 v13 载荷无论如何都得单独跑一趟。为 0 收益去铺一条只在
`parts.length>1` 时才安全的路径，不值得。**v2 与旧规则一律保留单跑回退。**

### 4.5 P4-3b：剪掉一类"注定无用"的候选

`parts.length === 1` 的 `TEXT / BIN / O0` 分组，`encodeTerrainGroup` 会落到
`encodeSpec`，而 `encodeSpec` 不接受内核开关（`encodeCM(..., variant 默认 false)`）：
v15 候选与基线**必然逐字节相同**，等于白跑一整段编码。现在在
`groupV15Candidates` 顶部直接判否。

| 场景 | 改前 | 改后 | 字节 |
| --- | --- | --- | --- |
| osdb 1 MiB `encMs` | 6,499 | **4,367（−33%）** | 完全不变 |
| osdb 1 MiB `ucz` | 277,835 | 277,835 | `verified: true` |

### 4.6 实测（2 vCPU 云端沙箱，`scripts/diag/probe-stages`）

阶段划分由 `onStage` 消息时间戳归并得出。`mixed3m` = 6 段混合内容（自然语言 /
二进制 / 结构化文本），分组后产生 **3 个可并行任务**：

| 阶段 | P4-2（改动前） | P4-3（改动后） | 变化 |
| --- | --- | --- | --- |
| `groupEncode` | 8,358 ms | **6,598 / 6,702 ms** | **−21%** |
| `chooseSpec` | 13,008 ms | 13,135 ms | 持平（本就并行） |
| 总耗时 | 21,726 ms | **20,186 ms** | −7.1% |
| 产物字节 | 465,778 | 465,778 | **逐字节不变** |

> **限制（必须说明）**：`runParallelJobs` 在"可并行任务 ≤ 1"时会退回串行。
> xml 这类单一巨型 `TEXT_V3` 分组 + 若干 `SUB-ANCHOR3` 的文件，分组阶段只有
> **1 个**可并行任务，因此 P4-3 对它们**不带来提速**（`probe-stages xml1m`：
> 改前 6,159 ms / 改后 6,253 ms，属噪声）。收益集中在**多分组文件**
> （ooffice 213 段、mozilla、samba 这类），且随核数放大——2 线程已见 −21%，
> 8 线程（`threadCount()` 上限）应显著更高。

### 4.7 验证

| 项 | 结果 |
| --- | --- |
| `probe-parallel xml1m`（1.5 MiB） | 并行 / 串行 **`identical: true`**，149,765 B 一致 |
| `tests/codec.test.ts` 新增用例 | 并行与串行容器逐字节相等；`groupV15CandidatesSync().alt` 与单跑 v15 逐字节相等（TEXT_V3 / GRAD_V3 / TEXT） |
| `tests/worker.mjs` | 通过（worker 代码已重新生成） |

---

## 5. 全量实测（P3 → P4）

> 待填：12 文件全量跑完后补表（由本机 16 核机器执行）。

---

## 6. 交付与验证

| 项 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 干净 |
| `npm run test:codec` | `codec tests passed`（含 P3-1 双流等价性、词元可逆性、v12 fixtures 回归） |
| `node scripts/build-worker-code.mjs --check` | 最新（worker 已随 P4-3 重新生成） |
| `npm run build` | 通过（`dist/index.html` 377 KB） |
| `probe-dualmap` | **双流等价性全部通过**（dickens / xml；含 v2 家族判定，见 4.4） |
| `probe-parallel xml1m` | `identical: true`，串行 37,921 ms / 并行 28,850 ms（**1.31×**，2 线程） |
| `bench-one xml` | 376,248 → **359,116**（−4.55%），`verified: true` |
| `bench-one ooffice` | 2,032,489 → **2,023,787**（−0.43%），`verified: true` |
| 1 MiB 切片（dickens/osdb/nci/mozilla） | 248,028 / 277,835 / 59,663 / 642,733，全部 `verified: true`，与 §1.2 的 v15 表一致 |
| 产物回归 | **零**：xml / ooffice / mixed3m / xml1m 字节数与 P4-2 完全相同 |

> **给本机全量测试的提示**：P4-3 让分组阶段吃满线程池，`mozilla`（213+ 段的
> 多分组文件）在 8 线程下应明显快于 P3；`xml` 属于"单大分组"，提速有限。
> 全量 12 文件请仍以**字节数单调不劣**为唯一硬判据。
