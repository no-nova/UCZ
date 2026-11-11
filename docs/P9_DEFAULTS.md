# P9 默认策略交付 / 本地验收交接

> P9 历史交付（e24b1b1）。用户本地验收已报告42,368,023 B /12 PASS，见 [LOCAL_E24B1B1.md](audits/LOCAL_E24B1B1.md)。当前 P10 交付请看 [P10_HANDOFF.md](P10_HANDOFF.md)；不要把本页旧指纹/门禁当作P10门禁。

## 执行口径

用户要求直接落地指定默认值，不再在 Arena 继续 2/4 MiB 矩阵、五个完整文件或 3a/3b 组合长测。允许一次完整 codec 单元套件（含已有较大合成夹具），其余只做小型正确性检查。整套 12 文件验收由用户在本机运行。

本次是**用户决策的默认策略提升**，不是以新沙箱整集数据证明该组合收益。旧 `f2de6fb` 本地报告单独保存在 [LOCAL_F2DE6FB.md](audits/LOCAL_F2DE6FB.md)。

## 已落实

| 项目 | 默认 / 判据 |
|---|---|
| 版本与配置 | 只对最终选中载荷的实际非 P7 语义写 v17；无用旋钮/被拒绝候选不增加配置字节 |
| text a2 | raw text 开；仅 WORD-PRE 关；显式 `textOn=false` 仍关闭所有 text |
| CM / match | 实际 CM 流 ≥512 KiB 才扩至 CM≤22、mht8≤21；mht4≤20；小流保留 21/20 |
| 单分片 | `v15SinglePlain=true` |
| TG 候选 | `candidateTgV3=false` |
| 孤儿范围 | 非 FILL；包括 STORE/RLE/O0；单组 **<2 MiB 且 <20% 输入**；最多 24 个 |
| 孤儿采用 | 有界候选批次完整重编码；**总载荷严格变小且完整容器严格变小**才采用；否则保留原容器及元数据 |
| 宏组 | `macroUniformGate=true`；多组且文件≤25 MiB **或**按字节计主导地形为 text，直接提主导规则，不经过小窗筛选；text 用 TEXT_V3 并尝试 WORD-PRE |
| 大二进制宏组 | >25 MiB、非 text 主导时保留原采样筛选；采样不能授权采用；最后完整容器严格比较 |
| 候选精简 | `dropZeroHitIds=true`；`dropLegacyV12Ids=false` |
| 选择成本 | `realHeaderCosts=true`；使用生产头部序列化器的真实 varint/配置/标记字节，不使用经验乘数作为默认评分 |
| 采样 | floor=8192；≤4 段时，**每个自身≥1 MiB 的段**用 65536，短段不随整文件大小一起升级 |

### 实现边界

- 512 KiB 阈值按实际 CM 输入计；WORD-PRE 按字典+词元流长度，子通道按各 CM 子流长度。编码/解码完全一致，详见 [UCZ_V17.md](UCZ_V17.md)。
- 新 v17 位 `0x10` 表示 WORD-PRE-only a2-off；`0x20` 表示大小流/mht8-only 扩表策略。旧 flags 0–15 的意义不变，不占 r=8192。
- 孤儿候选一次批量提出，避免最多 24 次重复编码主力大组。它不是逐个孤儿的全局最优搜索；批次不改善则整批保留原方案，绝不从前缀外推接受。
- 宏组基线是**同次调用、相同旋钮下实际选定的 post-orphan 容器**。正确性保证不是“相对旧 P7 必不回退”；候选精简、采样及新模型本身仍须本地整集验收。
- 未改动的组可在该次调用内复用最终载荷及成本仓；key 包含规则、原始顺序/边界、模型配置及相关选择策略。不跨文件、跨调用缓存，也不把 partial probe 当全组。
- 头成本计算是实际格式字节宽度；采样载荷率仍是估计，不把局部评分宣称为全局最优。完整重编码兜底用于 orphan/macro。
- 旧 `neutralPenalties` 仅在显式关闭 `realHeaderCosts` 后保留作历史诊断；`orphanSliceProbe` 仅兼容旧脚本，已不参与孤儿接受判据。
- 默认并发按每 worker 256 MiB 预算估算线程数；这是并发估算，不是 RSS 硬上限。显式 `UCZ_THREADS=8` 不受此默认估算改写。

## 最终验证结果

实现检查点 `6b86000`，历史选择器夹具修正 `79e370c`。四项门禁与最终交付的生产源码指纹相同：

`2979a4956e72487bd5c5a9f88f8ae2f6756163c4b62fe3dcf9f21d5d7e9fb878`

| 实际命令 | 结果 | 命令耗时 | 收据提交 |
|---|---|---:|---|
| `npm run check:worker` | PASS | 156 ms | `cb7ecc1` |
| `npm run test:codec` | **完整 PASS** | 165,245 ms | `7416ae7` |
| `npx tsc --noEmit` | PASS | 3,021 ms | `bf4c851` |
| `npm run build` | PASS | 1,991 ms | `7c97771` |

完整 codec 包含 **72 项格式、14 项宏组、14 项默认策略检查、原 codec 主体及独立 worker 脚本**。命令耗时来自门禁 JSON 的 `wallMs`，不是受控性能 A/B。四项均 `sourceUnchanged=true`、无超时；JSON/log 与日志校验值位于 [`checks/gates/`](../scripts/diag/p9-results/checks/gates/)，汇总见 [`defaults-delivery.json`](../scripts/diag/p9-results/checks/defaults-delivery.json)。

**失败历史不抹除：** 首次 codec 调用在 63,605 ms 因旧 MICRO 选择断言提前失败（`ed3f54e`）；当时 72/14/14 项已通过，但独立 worker 尚未运行。该旧断言与 3a 默认剔除 MICRO 冲突。随后将 8 个要求历史候选获胜的夹具显式置于旧选择策略，保留所有断言；一般往返、新默认测试、串并行集成仍用新默认。仅改测试，没有回退生产默认。修正后的完整调用才是上表的 PASS；没有把首次失败算成通过，也没有覆盖其收据。

补充检查：19 个已审计解码函数体与 f2de6fb 相同；冻结 P7/f2 码流兼容性由格式套件覆盖。恢复检查 11 项及摘要检查 3 项另已通过。

### 小型合成证据（非语料收益）

| 检查 | 实测字节 | 判据 / 结果 |
|---|---:|---|
| 默认 CLI 往返，完整 recovery fixture | 输入 4,192 → 容器 **125 B**（头14+载荷111；2.98%） | v7、flags=0、verified/sourceUnchanged=true；不加无关 v17 配置 |
| 4 B 宏组头部陷阱，payload-only 诊断评分 | 基线16；候选17（载荷3+头14） | 虽载荷减少1 B，容器增加1 B；拒绝并保留基线 |
| 同一陷阱，默认真实头部评分 | 基线16；候选16（载荷4+头12） | 相等亦拒绝并保留基线 |

后两行分别在 textOn=true/false 下验证，四次均往返成功。证据为 [`defaults-small-smoke.json`](../scripts/diag/p9-results/checks/defaults-small-smoke.json) 和 [`macro-header-cost-defaults.json`](../scripts/diag/p9-results/checks/macro-header-cost-defaults.json)。CLI 初次后处理误把完整夹具当作旧探针的 4096 B 前缀；现已按实际 4192 B 与输入 SHA 校验并保存既有成功编码，没有重复编码或修改测量值。

本轮没有在 Arena 运行新的 Silesia 整集或大切片性能矩阵。没有宣称新增 200–400 KB 或 30% 提速达成，也未从门禁耗时推出压缩提速。

## 用户本地验收

保留 `/tmp/p4` 的 f2de6fb 原 JSON，使用新的输出目录；不要把新旧记录覆盖混在一起。继续相同 16 核、2 文件并行 × 每文件 `UCZ_THREADS=8` 的配置。比较受控的编码耗时，不把汇总编码秒数当墙钟时间。

```sh
set -eu
cd universal-adaptive-compression-system
npm ci
npm run check:worker
REV=$(git rev-parse --short HEAD)
OUT="$PWD/.diag-data/local-$REV"
mkdir -p "$OUT"
export OUT
printf '%s\n' mozilla samba ooffice webster nci reymont xml sao osdb dickens mr x-ray |
  xargs -P 2 -I '{}' sh -c 'UCZ_THREADS=8 node scripts/diag/run.mjs bench-one "/home/user/Downloads/silesia/$1" --no-single --no-bench > "$OUT/$1.json"' sh '{}'
node scripts/diag/check-baseline.mjs "$OUT" 0.5
node scripts/diag/summary.mjs "$OUT"
```

`bench-one` 现在同时保存源码指纹/提交、全配置、实际 `modelFlags`、orphan/macro 完整比较与 `sourceUnchanged`。`check-baseline` 的 PASS 应按脚本本身阈值解释，不能代替与 f2de6fb 原 JSON 的逐文件字节对照。

特别关注：nci 的 raw-text a2 恢复、mr/x-ray 的旧参考字节数、3a 精简对各文件的影响、扩表内存，以及结构性复核新增的时间。**实际使用大表时仍必须写 v17**，不能为了 mr/x-ray 旧参考值强制标成 v15。
