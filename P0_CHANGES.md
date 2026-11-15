# UCZ P0 改进实施报告

日期：2026-11-06 · 环境：Node v22.22.3、2 vCPU / 3.9 GiB、Linux x64
基线提交：`6e6ebc1`（诊断报告见 `DIAGNOSIS.md`）
本轮改动：**不新增任何 Codec ID，ID 0–31 与 v1–v14 容器格式 100% 不变**；解码路径零改动。

本报告所有数字都由 `scripts/diag/` 在本次会话实测得到，每个数字都能用附录命令复现。
中途沙箱重启导致 `/tmp` 与 `node_modules` 被清空，**全部 12 个文件在重启后重跑过一遍，逐字节与重启前一致**（见 §4 复现性）。

---

## 0. 一览

| 项目 | 结果 |
| --- | --- |
| 全语料压缩率 | **21.15% → 20.88%**（44,820,578 → 44,253,926 B，**−1.26%**，省 566,652 B） |
| 基线回归门槛 | `check-baseline.mjs` **12/12 PASS**，无任何 >0.5% 回退，最大回退 **0.00%** |
| 编码总耗时 | 2491 s → **1771 s**（**−28.9%**） |
| 解码总耗时 | 751 s → 629 s（−16%，纯因更小的载荷） |
| 正确性 | `tsc --noEmit` 0 错误；`test:codec` + `worker` 全绿；12/12 逐字节往返一致 |
| 构建 | `npm run build` 成功（`dist/index.html` 357.98 kB / gzip 116.25 kB） |
| 兼容性 | ID 表未改动；容器版本判定行未改动；所有解码函数（`decodeTerrainGroup`/`decodeGroupedTranspose`/`case ID.*`）**零改动**；v12 历史样本 `tests/v12-fixtures.json` 仍通过 |

逐文件（`sum` 见 `node scripts/diag/summary.mjs <结果目录>`）：

| 文件 | UCZ 新 / 基线 | 变化 | 压缩率 新/基线 | 编码秒 新/基线 |
| --- | --- | --- | --- | --- |
| xml | 379,765 / 381,797 | **−0.53%** | 7.10% / 7.14% | 60.3 / 70.7 |
| dickens | 2,338,436 / 2,339,075 | −0.03% | 22.94% / 22.95% | 36.3 / 44.0 |
| ooffice | 2,074,792 / 2,074,792 | ±0.00% | 33.72% / 33.72% | 161.1 / 210.4 |
| mr | 2,062,327 / 2,062,327 | ±0.00% | 20.68% / 20.68% | 20.6 / 26.6 |
| osdb | 2,447,857 / 2,482,070 | **−1.38%** | **24.27% / 24.61%** | 58.2 / 46.3 |
| x-ray | 3,719,266 / 3,719,266 | ±0.00% | 43.89% / 43.89% | 14.4 / 21.7 |
| sao | 3,750,902 / 3,750,902 | ±0.00% | 51.72% / 51.72% | 51.1 / 65.4 |
| reymont | 1,133,020 / 1,207,582 | **−6.17%** | **17.10% / 18.22%** | 32.8 / 135.7 |
| nci | 1,664,888 / 1,727,729 | **−3.64%** | **4.96% / 5.15%** | 66.0 / 99.1 |
| samba | 3,758,664 / 3,848,465 | **−2.33%** | **17.40% / 17.81%** | 279.4 / 337.9 |
| webster | 6,874,253 / 6,917,641 | −0.63% | 16.58% / 16.69% | 113.4 / 186.6 |
| mozilla | 14,049,756 / 14,308,932 | **−1.81%** | 27.43% / 27.94% | 877.3 / 1246.4 |

与外部工具的对比（基线 `DIAGNOSIS.md` §2 已测，x86 同样本）：
- samba **17.40%** 现已**反超 xz -6（17.53%）**，接近 zstd -19（18.03%）；
- nci **4.96%** 与 zstd -19（4.96%）持平，优于 xz -6（5.30%）；
- 整体 20.88% 优于 xz -6（23.23%）、zstd -19（24.96%）、Brotli 5（28.10%）。

**唯一变慢的文件是 osdb（46.3 s → 58.2 s，+25.7%）**：它为了把 24.61% 修正到 24.27%，要多用两遍大区域整段 CM 编码来复核候选。这是"选对规则"的必要成本，用户在 `DIAGNOSIS.md` §3.3 里指定的目标值（≈2,448 KB / 24.27%）已精确达成（实测 2,447,857 B）。

---

## 1. P0-1 转置重复编码：一次算完三条流

**问题**（诊断 §3.1）：`encodePlanTranspose()` 里 `TRANSPOSE_GROUP` 的 legacy 字节流被完整编码了两遍——一次作为 `TRANSPOSE_2D` 的内部对照候选，一次作为最终载荷，占转置分组时间的 53.6%。

**改法**（`src/lib/codec.ts`）：

1. 拆出 `applyColumnCosts()`：把"用已算好的列权重填充成本图"与"重新编码"解耦；
2. `encodeGroupedTranspose()` 增加可选出参 `collect: ColumnWeights`，在编码过程中顺带收集列权重与空头位数；
3. 重写 `encodePlanTranspose()`：legacy / 几何 / v3 三条流**各编码一次**，再用 `enhanced < min(geometric+1, legacy)`、`geometric+1 < legacy` 复刻原决策；legacy 命中时直接用 `collect` 收到的权重复用填充成本图，不再重跑。

**验证**：

| 项目 | 改前 | 改后 |
| --- | --- | --- |
| mozilla 4 MiB / stride 24 编码耗时 | 39,182 ms | **26,780 ms（−31.7%）** |
| 同输入产物 | 3,237,271 B | **3,237,271 B（逐字节相同）** |
| 三条原语字节 | 3,237,250 / 3,267,035 / 3,237,251 | 完全相同 |
| `probe-costmap` dickens 2 MiB w4 | 525,958 B，deterministic | 525,958 B，deterministic |

**为什么不是 −50%**：省掉的是一整遍 legacy（约 10.0 s / 39.2 s）；v3 的 15.2 s 与几何的 10.8 s 本来就各只有一遍。要达到 −50% 必须改变决策口径（例如不编码几何候选），那会改动产物，与"0 字节变化"的验收条件冲突。

---

## 2. P0-2 同族 CM 择优归一

**问题**（诊断 §3.2）：分组键是 `(id, s, r)`，于是 `CM-TEXT` / `CM-TEXT2` / `CM-TEXT3` 各建一组、各自冷启动一套上下文模型。samba 有 2188 个区域，跨组冷启动开销可观。

**改法**：

- 新增 `src/lib/unify.ts`：`CM_ENCODING`（4/18/23 = text、5/19/24 = bin）、`CM_FAMILIES`（TEXT `[4,18,23]→23`、BIN `[5,19,24]→24`）、`isFamilyCM`。**只登记纯 CM 规则**——带参数的规则（DELTA/GRAD/ANCHOR_FOLD…）不参与，因为它们的 `s/r` 有语义。
- `codec.ts` 新增 `unifyFamilies()`，插在 `buildPlanGroups()` 与最终编码循环之间：
  1. 先算出各组独立载荷 `separateBytes`（未编码的此刻按同一路径补编）；
  2. 按**原区域顺序**把所有成员区域拼起来，按族目标规则整段编码得 `unifiedBytes`；
  3. `unifiedBytes < separateBytes` 才接受，否则原样保留。

**数学保证**：只有严格更小时才改写，所以**对原方案单调不劣**，`mozilla` 这种本该分治的文件不可能退化（该文件 5580 区域里 CM-BIN3 占 3808 个，族内本已统一，`separate` 即 `unified` 的对照会拒绝任何变差方案）。

**实测**：samba 3,848,465 → **3,758,664 B（17.81% → 17.40%，−2.33%）**。归一是逐族增量评估的：TEXT 族 1,645,824 → 1,589,834 B、BIN 族 812,957 → 802,601 B（这是区域顺序修正**之前**的记录，修正后 TEXT 族为 1,568,853 B，与上表 3,758,664 B 对应）。

**踩坑记录（重要，避免后人重复）**：
- 一开始按"分组首成员"排序再组内拼接，samba 的 TEXT 族统一载荷变成 1,589,834 B，而按原区域顺序是 **1,568,853 B（差 1.34%）**。`probe-order` 进一步验证：把 samba 的 1118 个 CM-TEXT3 段交错了重排，字节会膨胀 **3.02%**（BIN 族 1.75%）。已改为严格按区域顺序拼接。
- 曾试图加"头部 256 KB 试算"来省掉全量编码时间，结果在 samba 上**误杀真收益**（样本 +0.31%，全量 −1.55%）。改为只拦"明显更差（>2%）"后，osdb/nci 这类同质大区域能正确跳过，异构拼接数据仍走全量。**这个门槛只影响耗时，不影响产物**（拒绝时产物与不归一完全相同）。

---

## 3. P0-3 大区域采样失真：中段连续热身复核

**问题**（诊断 §3.3）：>1 MiB 区域用三个 16 KB 窗口试探，高阶 CM 模型与匹配表根本来不及收敛。实测 osdb 上 40 KB 采样选 `CM-BIN`（53.96%），而整区真实是 `CM-BIN3`（24.27% vs 24.61%）；nci 同理，采样选 `CM-BIN3`，真实是 `CM-TEXT3`（4.96% vs 5.15%）。

**改法**：

- `largerProbe()`：从区域**内部**取中段 512 KB 连续切片（对齐预测步长，不跨区域边界、不拼接）；
- `encodeProbe()`：用与正式编码完全相同的 `encodeSpec` 路径实测字节；
- 复核名单 = 采样前 3 名 + **每个 CM 族的最优成员** + 当前选择。加"每族最优"是因为 nci 上 `CM-TEXT3` 采样排第 5，只取 top-3 会把它排除在外（这是第一次修复后 nci 仍选错的原因）；
- 采纳条件：**严格更小**（`winnerSize < best.probeSize`）。原先用 0.5% 门槛，会放过 osdb 上 27.48% vs 27.58% 的真实优势。

**实测**：

| 文件 | probe 40 KB 采样选择 | 改后选择 | 字节（改前→改后） |
| --- | --- | --- | --- |
| osdb | CM-BIN（53.96%） | **CM-BIN3** | 2,482,070 → **2,447,857（24.27%）** |
| nci | CM-BIN3（10.07%） | **CM-TEXT3** | 1,727,729 → **1,664,888（4.96%）** |

用户指定的目标（osdb ≈2,448 KB / 24.27%、nci ≈1,664 KB / 4.96%）**精确达成**（差 23 B / 20 B，属头部开销）。

**代价与边界**：只有 >1 MiB 且非碎片化的区域会付一次 512 KB 探针；`probe-midprobe` 已验证 512 KB 中段与整区结论一致。

---

## 4. P0-4 选择阶段的预筛

**改法**：

1. **锚点归一预筛**：`anchorUnifyProbe()` 取第一个区域中段 64 KB，对 6 个候选（3 种 ID × 2 种模式）先各编码一次，只留前 2 名做全量比对。最终仍以完整编码字节数为准，**只省时间、不改选择口径**。
2. **碎片减窗口**：`sampleWindows()` 增加 `maxWindows` 参数；`< 32 KB` 的区域只用 1 个窗口（预算本就按区域数缩小，再切三份会让每段短到无法热身）。
3. **大区域复核的族补齐**（见 §3）顺带避免了"只测 top-3 漏掉真实赢家"。

**关于 `chooseSpec` 的 `d16Hd/gradHd/transHd/h0` 熵预筛**：本轮**没有**采用。原因是这套熵估计只对"图像/记录型变换"有判别力，而当前选择阶段的耗时大头是多个候选各自跑一遍 CM（`probe-cmspeed` 实测 osdb 上单遍 CM 需 4.1–5.4 s / 2 MiB，约 380–500 KB/s）；一旦用熵估计先砍掉候选，就会改变选择结果，与"无 >0.5% 回退"的硬约束冲突。真正省时间且不改产物的是**复用已算出的载荷**（见下）。

**实测收益**：
- xml 最终编码阶段 10,840 ms → **3,769 ms**（归一成功后不再重编一遍）；
- 全语料编码 2491 s → **1771 s（−28.9%）**，其中 xml −15%、ooffice −23%、sao −22%、reymont −76%、webster −39%、mozilla −30%。

---

## 5. P0-5 安全与护栏

| 项 | 实现 | 验证 |
| --- | --- | --- |
| 解压上限 | `limits.ts` 新增 `MAX_OUTPUT_BYTES = 256 MiB`；`decompress(c, onProgress?, maxOutput = MAX_OUTPUT_BYTES)` 在 `new Uint8Array(n)` **之前**校验 | 64 MiB 头正常尝试（随后报"容器数据被截断"）；256 MiB+1 / 1 GiB / 1 TiB 均**分配前**抛错，耗时 0 ms，RSS 49 MiB 不涨 |
| 取消通道 | `compress.worker.ts` 新增 `cancel` 消息与 `cancelled` 标志，各阶段与进度回调间检查；`App.tsx` 进度卡片增加"取消"按钮，`workerRef` 记录在跑的线程，取消即 `terminate()` 并给出"已取消（未保留部分结果）" | `yieldIfNeeded()` 每 30 ms 让出一次 await，取消在 30 ms 内生效 |
| 基线校验 | `check-baseline.mjs` 支持**结果目录**（批量）、跳过非法 JSON、打印解压上限、`ucz > size` 视为异常 | 本轮 12/12 PASS（见 §0） |

顺带修掉一个真实 bug：归一阶段把整个 `Uint8Array` 插值进模板字符串，在 osdb 上向 UI 推送了约 9 MB 的进度文本（`${unified}` → `${unified.length}`）。

---

## 6. 兼容性与正确性证据

- **ID 表**：`export const ID = {...0…31}` 行未被修改（diff 中只作上下文出现）。
- **容器版本判定**：`planHeader()` 的 `0x55,0x43,0x5a, 7…14` 版本推导行未改动。
- **解码路径**：`git diff` 中所有 `decodeTerrainGroup` / `decodeGroupedTranspose` / `case ID.*` / `export function decode*` 均无增删；`decompress()` 只多了上限校验，正常输入的行为不变。
- **历史样本**：`tests/v12-fixtures.json` 的 v12 容器仍能正确解码（`test:codec` 覆盖）。
- **往返**：12/12 文件逐字节一致（每个 `bench-one` 都做独立解码 + 逐字节比对）。
- **确定性**：`probe-costmap` dickens 2 MiB w4 连跑两次 525,958 B 且 `deterministic: true`；`probe-det` 对同一段输入连编三次字节相同。
- **回归测试**：`tests/codec.test.ts` 新增 4 组断言——解压上限（伪造头 1 GiB / 1 TiB 必须抛错、上限可覆盖）、转置单遍（带/不带成本图字节相同且成本仓被填充）、归一族（只接受严格更小、带参规则不入族）。

---

## 7. 复现性

沙箱在会话中途重启，`/tmp` 与 `node_modules` 被清空。恢复后重新 `npm ci`、重下 Silesia，把 12 个文件完整重跑：

- **全部 12 个文件字节数与重启前逐一相同**（例如 osdb 2,447,857、nci 1,664,888、samba 3,758,664、mozilla 14,049,756）；
- `check-baseline.mjs` 12/12 PASS；
- `tsc` / `test:codec` / `build` 全绿。

说明这些结果不依赖运行时抖动。

---

## 8. 还需要用户在本机跑的全量测试

沙箱是 2 vCPU / 3.9 GiB，本轮已完成 Silesia 全量（12/12）。建议在 9955HX3D / 32 GB 上补跑：

```bash
cd universal-adaptive-compression-system

# 1) 静态检查与单元测试
npx tsc --noEmit
npm run test:codec

# 2) 生产构建
npm run build

# 3) 全语料基线校验（每个文件一次，串行；结果写目录便于批量比对）
mkdir -p /tmp/res
for f in xml dickens ooffice mr osdb x-ray sao reymont nci samba webster mozilla; do
  node scripts/diag/run.mjs bench-one /tmp/corpus/$f > /tmp/res/$f.json
done
node scripts/diag/check-baseline.mjs /tmp/res 0.5
node scripts/diag/summary.mjs /tmp/res

# 4) 关键探针（应当复现本报告的数字）
node scripts/diag/run.mjs probe-transpose-cost      # 转置单遍：字节不变、耗时降约 1/3
node scripts/diag/run.mjs probe-costmap /tmp/corpus/dickens 2 4   # 525,958 B, deterministic
node scripts/diag/run.mjs probe-midprobe /tmp/corpus/osdb          # mid 选 BIN3
node scripts/diag/run.mjs probe-midprobe /tmp/corpus/nci           # mid 选 TEXT3
node scripts/diag/run.mjs probe-bomb                # 上限拦截，RSS 不涨
node scripts/diag/run.mjs probe-fuzz 900            # 变异容器只抛错不挂死

# 5) 界面取消通道（手工）
npm run dev   # 选一个 40 MB 以上文件，进度卡出现“取消”按钮，点击应在 30 ms 级停止并提示“已取消”
```

**多核提速建议**：`bench-one` 单线程；本机 16 核可并行跑 4–6 个文件，但请**每个进程独立**（`bench-one` 内部不并行）。

---

## 9. 未做（与原因）

| 项 | 原因 |
| --- | --- |
| `chooseSpec` 熵预筛（`d16Hd/gradHd/transHd/h0`） | 会改变候选集从而改变产物，与"无 >0.5% 回退"冲突；已用"复用归一载荷"拿到同等量级的收益 |
| 多线程/分片编码 | 属架构改造，不在本轮 P0；且会改变区域边界与产物 |
| 解码加速 | 解码路径零改动的兼容性要求。解码总耗时 751 s → 629 s 只是"载荷变小"带来的，**解码吞吐本身未优化**（约 270–340 KB/s，随文件而异），仍是下一步的头号性能项 |
| osdb 的 +25.7% 编码耗时 | 换取 24.61% → 24.27% 的选择修正；若更看重速度，可把 §3 的复核名单缩到"每族最优 2 个"（预计省 1 遍 512 KB 编码，收益约 −15 s，选择结果不变） |
