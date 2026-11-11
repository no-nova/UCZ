# P11交付：24位分档、短匹配表扩容与精确去重

> 历史P11交付记录（147b778），以下策略/“尚无本机结果”描述的是当时状态。后续用户本机报告41,813,622 B、9项过线/3项回退，见[audits/LOCAL_147B778.md](audits/LOCAL_147B778.md)；当前P11.1改为固定mht4=20、低档v18、显式高档策略，见[P11_1_HANDOFF.md](P11_1_HANDOFF.md)。旧门禁证据未覆盖。

## 起点与范围

用户报告P10 `d4bf4d8` 本地16核、12/12无损/指纹/逐文件零回退，总量 **42,038,648 B /19.8353%**。相对P9减少329,375 B；这些值已经成为新的12项bestUcz及总量硬上限。原JSON未上传，非Arena复测，完整逐文件表见 [LOCAL_D4BF4D8.md](audits/LOCAL_D4BF4D8.md)。

列出的编码时间实际合计1298.4 s（汇总取整1298 s），相比1333.0 s减少34.6 s；按逐行值为10个更快、2个更慢，而不是11个更快。samba +3.1 s，mozilla +44.3 s。它们是编码时间之和，不是整集墙钟。

没有新增大文件/语料/长切片测试。新增P11输入最大32 KiB；请求中的完整既有codec门禁另含原有较大合成用例。**尚无P11全量字节或提速结果，不把24位的收益预测写成已实现结果。**

## 已实现

### 1. 新硬基线

`baseline.json` 的12项 `bestUcz` 和 `total.bestUcz` 锁为42,038,648 B。原有v14字段不重写。检查器继续要求逐文件不增加1 B，别处收益不能抵消；`--all`同时校验覆盖与总量。8项元数据测试只是检查器测试，不是虚构的语料测量。

### 2. v19与实际大表

v18的0x08已经占用，因此按授权选独立 **v19**，配置头为uint16 LE，新增 `0x100=CM24`、`0x200=match23`，不重解释旧位/旧版本。仅最终选中载荷的实际表宽参与头部。

| 原始组/块大小 | CM | mht4 | mht8 |
|---|---:|---:|---:|
| `<512 KiB` | <=21 | <=20 | <=20 |
| `[512 KiB,4 MiB)` | 22 | **21** | 21 |
| `[4 MiB,8 MiB)` | 23 | **22** | 22 |
| `>=8 MiB` | **24** | **22** | **23** |

TG、SUB、WORD-PRE继承正确的原始组/块大小；所有探索性编码用显式probe域强制<=21/20，含chooseSpec的512 KiB复核。配置头多出的1 B也计入真实成本。详见 [UCZ_V19.md](UCZ_V19.md)。

### 3. 孤儿上限64

最多64个**不同规则组**，仍严格 `<2 MiB AND <20%`，排除FILL，一次批量完整重编码/比较，不改成逐孤儿循环。`orphanGroups`与`rewrittenSegments`分别记录组数、片段数。

重要区别：分组键是 `(id,s,r)`，29个相同STORE片段会先聚为1组，不能仅凭“29个STORE段”认定原24组上限曾截断它们。64的作用要用实际不同规则组数确认；已实现所要求的放宽，不夸大其收益。

### 4. 残余完整编码去重——不猜测赢家

P10已把符合条件的孤儿/必试宏合成同一个worker批次；并不是所有情况都还在串行跑两次。仅“宏必试且规则不变”也**不能证明孤儿必输**。

本次消除的是可证明重复的工作：

- 同族归一完整统一base即使被拒绝也保留，连同精确成本仓。
- 后续孤儿/宏按同输入、规则、原始有序范围/位置、成本边界及模型配置精确命中；不重新编码该base。
- 已有base的组可只派发v15/WORD-PRE候选；原base/成本留在主线程，不传大载荷副本。候选仍与完整任务字节一致。
- worker失败或工作量不足回退原串行路径；已有base仍复用。不会对非重入池并发调用两次批次API。
- 完整GroupCache继续避免“孤儿失败后相同宏候选”重新编码。接受顺序仍是baseline→孤儿→宏；宏比较的是**实际post-orphan容器**，相等或更大保留当前方案。
- 没有新增采样接受启发式，也没有为了抢先猜宏赢家而把原本并行的两个完整候选改成串行。

新增 `guardStats.familyTrials / rejectedFamilyTrials / reusedTrialBases / candidateOnlyJobs`。`--no-reuse-guard-bases`仅关闭这组去重/候选-only调度，不改变模型或其它worker默认，供本机受控A/B。`--no-batch-guards`仍单独控制P10合批。

## 小型实测，不是语料收益

### 精确缓存：32,768 B拒绝归一用例

| 路径 | 完整容器 B | 容器/原文 | 全长base调用 |
|---|---:|---:|---:|
| 去重关闭、串行 | 28,748 | 87.7319% | 3 |
| 去重开启、串行 | 28,748 | 87.7319% | 2 |
| 去重开启、真实worker | 28,748 | 87.7319% | 同一base复用；2个candidate-only任务 |

容器SHA与成本数组相同，byte差0 B/0%。调用计数包含覆盖全部32 KiB的family小探针；消除的是后续孤儿阶段重复的完整base，不是拿小探针冒充大组最终载荷。该用例确实走了“完整同族归一被拒绝→孤儿拒绝→宏采用”，宏最后只省 **1 B**，未放宽任何比较。

worker调度记录中单任务批次可能因原有阈值返回null；已完成任务数量以 `guardStats` 为准，不把提交尝试当成实际worker执行。

### 为什么不能直接删掉中间孤儿：另一个32,768 B反例

| 阶段 | 完整容器 B | 容器/原文 | 结果 |
|---|---:|---:|---|
| baseline | 25,726 | 78.5095% | 比较起点 |
| 孤儿候选 | **22,641** | **69.0948%** | 接受 |
| 必试且规则不变的宏 | 26,427 | 80.6488% | 拒绝 |

直接用宏替代孤儿会损失3,786 B；即使拿宏与原baseline比较后回退，也只能得到25,726 B，仍比正确结果多3,085 B。因此保留真正不同的孤儿候选，并用精确缓存删除重复编码，而非删除可能获胜的方案。串行与真实worker结果一致。

原始证据：`scripts/diag/p11-results/checks/small-smoke.json`。复现到新位置以保留交付收据：

```sh
node scripts/diag/run.mjs probe-p11-smoke .diag-data/p11-small-smoke-local.json
```

## 四项最终门禁

本轮四项均实际执行通过，并分别保存日志/收据、commit及push：

| 命令 | 结果 | 门禁墙钟 | PASS检查点 |
|---|---|---:|---|
| `npm run check:worker` | PASS | 246 ms | `1df0bc3` |
| `npm run test:codec` | PASS | 262,933 ms | `5e73553` |
| `npx tsc --noEmit` | PASS | 4,209 ms | `b77ee59` |
| `npm run build` | PASS | 2,649 ms | `b775c4f` |

完整codec本轮一次通过，含72格式、14宏、14默认、12 P10、9 P11检查、原有主套件、独立worker及8项基线元数据测试。门禁墙钟**不是编码性能A/B**。

`delivery.json`绑定四项收据与日志SHA、小型结果、相同源码指纹及测试树；不拿历史P10门禁替代本次结果。

门禁目录：`scripts/diag/p11-results/checks/gates/`。
源码检查点：`5d51696a71157ffa0dc30fd54ac16a02315c7c5e`。
源码指纹：`5227170a7cd2a9f8070fca63454d68fb28510641e68daa2ef7dfbed89c238b74`。
测试树：`beb2deeb23e6c67dfc2beda4cd6c3065062a7d2e`。

## 用户本机12文件验收

**先确认内存**：24位9上下文表本身576 MiB，mht4+mht8另48 MiB；默认调度按1024 MiB/worker估算，但显式8线程不被暗改。两文件×8worker约16 GiB预算，主线程、输入/候选及GC另计，绝不是RSS硬上限。内存不足请降低并发并记录配置，时间对比需用同配置。

保留P10原JSON，使用当前提交专用的新目录：

```sh
set -eu
cd universal-adaptive-compression-system
npm ci
npm run check:worker
REV=$(git rev-parse --short HEAD)
OUT="$PWD/.diag-data/p11-$REV"
mkdir -p "$OUT"
export OUT
printf '%s\n' mozilla samba ooffice webster nci reymont xml osdb mr x-ray sao dickens |
  xargs -P 2 -I '{}' sh -c 'UCZ_THREADS=8 node scripts/diag/run.mjs bench-one "/home/user/Downloads/silesia/$1" --no-single --no-bench > "$OUT/$1.json"' sh '{}'
node scripts/diag/check-baseline.mjs "$OUT" 0.5 --all
node scripts/diag/summary.mjs "$OUT"
```

重点检查：

- 12项无损/指纹及新bestUcz硬门禁；总字节对42,038,648 B，不使用v14容差放宽。
- 新版配置从两个字节读取；`modelFlags & 0x100`表示实际CM24，`&0x200`表示实际mht8=23；不同规则的实际flags见 `codecs`。
- 对samba/mozilla记录孤儿组数、实际post-orphan基线、family完整拒绝/复用、candidate-only任务、宏预编码命中。不能仅由总耗时倒推出哪阶段重复。
- 如需隔离去重效果，在相同线程/输入/24位配置下另存 `--no-reuse-guard-bases` 记录。默认全量验收不需要另跑这组A/B。
- 编码时间之和与整集墙钟分开；不要用Arena测试门禁耗时推算编码提速。
