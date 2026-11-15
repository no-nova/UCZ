# P7 变更报告：流水线全链路整顿（铁门禁 + 追回 4.6 KB + 候选对齐 + 多维候选 + 孤儿组坍缩）

> 基线：P6 全量 12 文件 **43,077,263 B（20.33%）**。
> 本轮全部改动仍在 v15 分支（`r | 0x8000`）或**计划层**（不改比特流语义），v13 一字节未动，
> v12 fixture 通过。新增的 5 个 `planTuning` 类开关默认全开，仅供 A/B 复核。

---

## 一、结论速览

| 项 | 状态 | 实测 |
|---|---|---|
| P7-0.1 辅混洗只给 `bin` | ✅ | text 文件回到 P5 水平（webster/dickens/reymont 共 −2,914 B）；xml 少了 577 B，但被 P7-2/3 补回并反超（358,525 < P6 358,539） |
| P7-0.2 `a2` 按 spec.id 精确门控 | ✅ | `xray2m` 881,756 **不变**；mozilla 2 MiB −35 B、ooffice 2 MiB −5 B（'res' 族开始吃到 a2） |
| P7-0.3 v1 `STORE` 长度校验 | ✅ | 截短载荷 → `corrupt v1 store payload`；`decodeSpec` 也加了同样的兜底 |
| P7-0.4 测试铁门禁 | ✅ | bench-one 校验失败即 `exit 1`；check-baseline 强制 verified + size + sha256 + 无回退 + 全量覆盖 |
| P7-1 候选专属相位对齐 | ✅（0 B，但消除了系统性偏置） | xml 359,116→359,116、sao 3,748,341→3,748,341（结论相同、口径正确） |
| P7-2 多维特征候选 | ✅ | mozilla 2 MiB **−637 B**；samba 0；其余 0 |
| P7-3 孤儿组坍缩吸收 | ✅ | **samba 2 MiB −7,683 B（−1.84%）**、mozilla −305 B、xml −188 B；其余 0 |

沙箱 `bench-one`（`--no-bench --no-single`，全部 `verified: true`、`ver 15`）：

| 文件 | P6 | **P7** | Δ |
|---|---:|---:|---:|
| xml | 358,539 | **358,525** | −14 |
| ooffice | 2,016,691 | **2,016,272** | −419 |
| mr | 2,048,404 | 2,048,404 | 0 |
| x-ray | 3,664,677 | 3,664,677 | 0 |
| sao | 3,748,341 | 3,748,341 | 0 |

---

## 二、P7-0：追回 4,636 B + 铁门禁

### 1. `weights2` 收紧到 `bin`

P6 在 text 上也有增益，但只在 1~2 MiB 切片成立（−0.10%~−0.17%）；到全文件规模是轻微
过拟合（webster +1,551 / dickens +899 / reymont +464 = +2,914 B）。原因：text 的 `mctx2`
只有"前字节类别 × c0 低 2 位 × 匹配标志"6 位，看不到词一级结构，样本一多就把 5,120 个
权重学成了噪声。收紧后 bin 的 −76.1 KB 全部保留。

沙箱可验证的副作用：xml（CM-TEXT 为主）从 358,539 回到 359,116；但 P7-2/P7-3 在 xml 上
又拿回 591 B，最终 **358,525**，反而比 P6 更小。

### 2. `a2` 的门控：profile + **spec.id** 双层

`x-ray` 的规则是 `D16(s=1)` / `WIDE_GRAD(s=1)`，内层 CM 参数是 `('res', 2, 1)`——与
mozilla 的 `DELTA_V3(s=2)` **完全同形**，只看 profile 无法区分（P6 就是卡在这里）。

改法：

* `a2Eligible(profile)`：`text / bin / res` 开，`res2d / o0` 关；
* 新增 `a2Suppress` 计数器，在 codec 层的 `encodeTerrainGroup` / `decodeTerrainGroup` /
  `encodeGroupDual` 三个入口按 `sp.id ∈ {D16, WIDE_GRAD}` 置位。

因为**编解码两侧都从同一个 `sp` 推导**，天然对称，不需要任何标记位，也不碰 v13。
单测锁死四条：`res2d` 关、`res/text/bin` 开、`D16` 关、`WIDE_GRAD` 关。

沙箱实测（`probe-p7a2`，2 MiB 切片，端到端）：

| 文件 | P6（a2=text\|bin） | P7（a2=+res） | Δ |
|---|---:|---:|---:|
| mozilla | 1,588,342 | 1,588,307 | −35 |
| ooffice | 762,205 | 762,200 | −5 |
| samba / osdb / x-ray / mr / xml / nci | — | — | 0 |

`x-ray`（`xray2m` 881,756）与 `mr`（`mr2m` 408,321）逐字节不变——抑制生效。

### 3. v1 `STORE` 长度校验

旧 v1 分支、以及 `decodeSpec` 的 `STORE` 分支都会在载荷被截短时**静默**返回更短的数组
（调用方 `set()` 于是留下零字节），这种"看起来解压成功"的损坏比抛错危险得多。
现在两处都强制校验，新增单测（手工拼 v1 容器）+ `probe-v1store` 最小复现：

```
ok   [ 1, 2, 3, 4 ]
throw corrupt v1 store payload
```

### 4. 测试铁门禁

`scripts/diag/bench-one.ts`：`verified` 为 false 时立刻
`console.error('[FATAL] 无损校验失败 ...')` 并 `process.exitCode = 1`；同时输出
`sha256` 供指纹比对。

`scripts/diag/check-baseline.mjs` 重写，任一不满足即 FAIL + 非 0 退出：

1. `row.verified === true`（失败/缺失绝不算 PASS）
2. `row.size === ref.size`（原始输入字节数必须一致）
3. `row.sha256 === ref.sha256`（12 个 Silesia 输入的指纹已写进 `baseline.json`）
4. `row.ucz <= row.size`
5. `row.pct` 不高于 v14 基线 + 阈值
6. 覆盖度：结果目录 ≥12 个 JSON 却对不上 12 项 → FAIL；`--all` / `EXPECT_ALL=1` 强制 12 项

并逐文件打印 **vs v14** 与 **vs bestUcz（历史最优）** 的字节增减。实测：

```
PASS mr:      2048404 B / 20.54% | vs v14 -13923 B (-0.68%) | vs bestUcz 0 B
PASS ooffice: 2016272 B / 32.77% | vs v14 -58520 B (-2.82%) | vs bestUcz -419 B
PASS sao:     3748341 B / 51.69% | vs v14  -2561 B (-0.06%) | vs bestUcz 0 B
PASS x-ray:   3664677 B / 43.24% | vs v14 -54589 B (-1.48%) | vs bestUcz 0 B
PASS xml:      358525 B /  6.71% | vs v14 -23272 B (-6.02%) | vs bestUcz -14 B
NOTE 本次只覆盖 5/12 个标准文件 ...；全量校验请加 --all
[5/12] 全部 5 项通过（verified + size + sha256 + 无回退）
```

篡改验证：把一条记录的 `verified` 改 false、把另一条的 `size` 加 1，两条都 FAIL 且进程
退出码 1。`--all` 在只有 5 个结果时也正确 FAIL。

---

## 三、P7-1：大区域复核的候选专属相位对齐

`chooseSpecImpl` 的 40 KB 初筛本来就按 `candidateAlignment(sp, bestS)` 给每个候选对齐采样
窗口；但 ≥64 KiB（实为 >1 MiB）的复核阶段只调一次 `largerProbe(seg, bestS)`，把同一份
缓冲区喂给所有候选——`TRANSPOSE(28)` / `GRAD(r=3800)` / `D16(2s)` / `SUB_ANCHOR` 这些
步长与 `bestS` 不同的候选因此相位错位。

改法：

* 按 `candidateAlignment(t.spec, bestS)` 分桶缓存探针（`Map<align, probe>`），每个候选都在
  自己严格对齐、且相对 `seg` 起点同相位的连续缓冲区上测；
* 不同桶长度可能差几个字节，优劣一律用**归一化字节率 `size / sample.length`** 比较
  （`Trial.probeRate`），不再比绝对字节数。

实测（`probe-planab`）：xml、sao 以及 7 个 2 MiB 切片上结论**完全不变**（0 B）。也就是说
这条修复消除的是一个潜在偏置，而不是当前语料上的收益——但它让"复核"这件事的
口径正确，后续扩候选池时不会再被它带偏。

---

## 四、P7-2：多维特征驱动的候选池

`analyze` 的 `kind` 是互斥标签，`candidatesFor` 却拿它当候选开关：被判 `'noise'` 的区域
只有 `O0` 一个候选（`BIN/DELTA/D16` 全被封杀），`'text'` 区域则拿不到行预测族。

改法（`planTuning.featureCandidates`）：新增 `segFeatures()`（在 `lagSample` 上算 `h0`、
差分熵 `hd`、相等邻接率 `rep`），把 `kind` 降级为**展示标签 + 便宜门槛**，候选按特征并集生成：

* `noise`：只有真正的纯白噪声（`h0 > 7.92 && hd > 7.92 && rep < 0.01`）才独尊 `O0`；
  其余把 `BIN` 放进池子，`hd < h0 - 0.15` 时再加 `DELTA` 族。**且要求区域 ≥64 KiB**——
  短噪声区的 40 KB 采样几乎等于全段，改投 CM-BIN 反而会打散共享 BIN 组。
* `text`：`bestS > 1` **且** `hd < h0 - 0.15`（步长差分确有收益）时把 `GRAD` 族放进来。

实测（`probe-terrain-ab`，2 MiB 切片，旧 vs 新）：

| 文件 | 旧 | 新 | Δ | 规则命中变化 |
|---|---:|---:|---:|---:|
| mozilla | 1,588,307 | 1,587,670 | **−637** | 2 |
| samba | 417,290 | 417,290 | 0 | 0（收紧门槛前是 +447） |
| ooffice / osdb / sao / xml / mr / nci | — | — | 0 | 0 |

调参过程中测到的反例（已写进注释）：不加 64 KiB 门槛时 mozilla −2,114 但 samba **+447**；
只看 `bestS > 1` 给 text 加行预测族同样让 samba +447。两处收紧后 samba 归零、mozilla 保留。

候选池平均规模几乎不变（10.0 → 10.1 个/区域），耗时在噪声范围内
（mozilla −6.5%、samba +4.2%）。

---

## 五、P7-3：孤儿分组坍缩吸收

### 诊断（`probe-groups`）

分组分布（2 MiB 切片，旧口径）：

| 文件 | 段数 | 组数 | 主力组占比 | <128 KiB 孤儿组 | 孤儿字节 |
|---|---:|---:|---:|---:|---:|
| mozilla | 74 | 10 | 66.7% | 7 | 70 KB |
| samba | 230 | 4 | 80.4% | 1 | 89 KB |
| ooffice | 44 | 9 | 97.0% | 8 | 62 KB |
| osdb | 2 | 1 | 100% | 0 | 0 |
| xml | 15 | 3 | 55.2% | 1 | 3 KB |
| nci | 1 | 1 | 100% | 0 | 0 |
| mr | 9 | 6 | 95.1% | 5 | 100 KB |
| webster / dickens / reymont | 1 | 1 | 100% | 0 | 0 |

### 实现

`consolidateOrphans(data, merged)` 在建组**之前**跑：

1. 主力组只在"纯 CM 规则"里选（`BIN/TEXT/O0` 的 v1/v2/v3），因为它们的正向变换是恒等，
   任何段的原始字节都能直接并进去；要求主力 ≥256 KiB。
2. 候选孤儿：其它分组、总字节 <128 KiB、非 `FILL/STORE/RLE`，按体积从小到大最多 6 个。
3. 用"主力组热模型前缀 (256 KB) + 真实编码"做 A/B：

   ```
   separate = encode(前缀, 主力规则) + encode(孤儿段, 孤儿规则)
   merged   = encode(前缀 ⧺ 孤儿段, 主力规则)
   ```

   前缀成本在两侧相同、自动抵消，差值就是"孤儿数据在热模型里 vs 自己冷启动"的真实字节差。
4. **只有 `merged + 6 < separate`（严格更小，6 字节规则头）才吸收**；吸收只改 `spec`，
   段的物理顺序完全不动，随后由 `buildPlanGroups` 自然合并。

### 实测（`probe-groups`，2 MiB 切片）

| 文件 | 旧 | 新 | Δ | 组数 |
|---|---:|---:|---:|---:|
| **samba** | 417,290 | **409,607** | **−7,683（−1.84%）** | 4 → 3 |
| mozilla | 1,587,670 | 1,587,365 | −305 | 10 → 9 |
| xml | 169,750 | 169,562 | −188 | 3 → 2 |
| ooffice / osdb / nci / mr | — | — | 0 | 不变 |
| webster / dickens / reymont | — | — | 0 | 1 → 1 |

samba 是典型受益者：2188 个段、230 段在 2 MiB 切片里，孤儿组一旦并进主力 CM-BIN3，
就吃到了主力的热上下文，一步拿到 1.84%。

---

## 六、门禁

```
node scripts/build-worker-code.mjs          # 69.9 KB
node scripts/build-worker-code.mjs --check  # 最新
npx tsc --noEmit                            # 0 错
npm run test:codec                          # codec tests passed / worker test passed
npm run build                               # 382.65 kB
node scripts/diag/run.mjs probe-dualmap     # 双流等价性全部通过
node scripts/diag/check-baseline.mjs /tmp/p7out        # 5/12 全部 PASS（带指纹与 bestUcz 对比）
node scripts/diag/check-baseline.mjs /tmp/p7bad        # 篡改 verified/size → FAIL，退出码 1
```

新增探针：`probe-p7a2`、`probe-planab`、`probe-terrain-ab`、`probe-groups`、`probe-noise`、
`probe-v1store`。

## 七、遗留

1. `text` 的辅混洗：不是"过拟合"这么简单——2 MiB 上它确实是正收益，41 MB 上才转负。
   正确的形态是**按区域长度自适应学习率**（短区域 lr2=2、长区域 lr2≤1）或干脆做成
   双流候选让它自己选，而不是全局一刀切。
2. `a2` 在 `'res'` 上的收益本机全量才能真正体现（沙箱 2 MiB 切片只有 −35 B 量级）。
3. 孤儿吸收目前只吸 ≤6 个/文件、只吸进"纯 CM 主力组"；如果主力组是
   `BIN_V3 + WORD-PRE` 这类封装组，吸收后还能再省一层。
4. `probe-terrain-ab` 只跑了 2 MiB 切片，全量上 `noise → BIN` 与 `text → GRAD` 的真实
   收益请以本机 12 文件结果为准。
