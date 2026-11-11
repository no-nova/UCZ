# P10交付：v18大组表、严格基线与完整候选合批

> P10历史交付d4bf4d8；用户本地12文件验收已完成，结果见[LOCAL_D4BF4D8.md](audits/LOCAL_D4BF4D8.md)。当前阶段见[P11_HANDOFF.md](P11_HANDOFF.md)，以下待验收描述保留当时口径。

## 本次范围

用户已在本地报告 e24b1b1 的12文件无损通过、42,368,023 B /19.99%，并授权P10直接落地。原始JSON未上传，详见 [LOCAL_E24B1B1.md](audits/LOCAL_E24B1B1.md)。这些数值已写入基线，不冒充Arena复测。

本轮不下载/测试新的整文件或 >256 KiB长切片。新增正确性检查实际输入最大48 KiB；请求中的一次完整既有codec套件包含原有较大合成用例。预计节省150 KB+、sao 15–25 KB、编码200–300秒均仍待用户本机验证。

## 1. 硬门禁

- 12个 `files[].bestUcz` 与 `total.bestUcz` 更新为用户报告，合计 **42,368,023 B**。
- `check-baseline.mjs` 原来只打印bestUcz回退。现在逐文件严格检查：**增加1 B也失败**，其它文件收益不能抵消；全量同时检查总和。
- `verified===true`、标准输入size/SHA、输出大小与v14阈值检查保留；重复行、无效字节数、缺失全量记录拒绝通过。
- 参数 `0.5` 只用于旧v14比较，绝不放宽bestUcz。原有 `ucz/pct/timing` 字段继续表示v14历史，不改写为P9数值。

## 2. TG/SUB与23位表

按用户随后确认，采用独立 **UCZ v18**，而不是在旧v17重用位：`0x02=22位CM`、`0x04=23位CM`。旧版本按版本分流；没有新语义时仍不多写配置字节。

默认上限23/22，按完整组或独立SUB块原始尺寸的512 KiB /4 MiB边界定档；mht4保持20。TG最终通道继承整个转置组尺寸，SUB继承最多8 MiB块，WORD-PRE继承原始组尺寸。小窗搜索明确隔离，避免小探针反复分配大表。

TG v15候选不再重复编码base/内部回退后误标内核；ID30升级路径使用正确V3布局。详见 [UCZ_V18.md](UCZ_V18.md)。

## 3. 删除重复工作，保留完整容器回退

**已存在，不冒充新优化：** P9孤儿候选本就是最多24组的一次批量提案；孤儿范围仍严格 `<2 MiB AND <20%`，排除FILL。单一组或规则/成员不变的宏候选已有跳过逻辑。没有增加逐个孤儿反复重编码。

P10新增：

1. 同族归一时已编码的独立base，在归一未采用时也复用；保存精确成本仓，避免最终阶段再完整编码一次。已采用的共享base也保存成本。
2. 通用v15候选只生成可用的alt，不再额外生成不可序列化为旧v13的dual base；双流实现留作独立等价探针。
3. 无孤儿且规则确定时，必需的直接宏候选与原多组方案合为一批worker任务。
4. 有孤儿时，**只有无论接受/拒绝都必定需要同一宏候选**，才把它与孤儿重编码任务合批。可能坍缩成无需宏组的单组、宏规则改变、需要大二进制采样筛选或worker不支持的规则，均不预编码。
5. 同一池一次派发，不对共享SAB/监听器并发调用两次批次接口；沿用LPT负载分配。池活到完整选择结束后关闭，异常也关闭。
6. 返回的完整base/alt/WP及成本仓按精确键缓存，宏阶段取回后仍真实序列化整个候选容器。宏比较基线是**实际被选中的post-orphan容器**；严格更小才采用，相等/更大/候选失败保留基线。孤儿还要求总载荷严格下降。
7. 线程不足、工作量不足或worker失败仍走原串行流程，不为了预计算而串行多跑一个宏候选。

上述保证是同次调用、同配置下的完整比较，**不是对e24全量字节数的未经测量保证**。23位模型/布局的整集表现由新bestUcz硬门禁检查。

## 4. 可复核字段与检查

`bench-one`记录源码提交/指纹、完整旋钮、实际版本/flags、每规则flags、orphan/macro比较，以及 `guardStats`：孤儿/宏试验次数、已合批的宏任务、实际缓存复用、worker任务与失败数、复用的组/同族base。

`--no-batch-guards` 只关闭候选合批，不改变模型或其它worker默认，可在本机做受控调度A/B。默认不需要该参数。

- 小型P10正确性12项：新位编号、边界、sao虚拟列、真实大表分配、旧v17版本分流、纯v15、dual-alt等价、真实worker批次/缓存/失败回退等。
- 基线元数据8项：仅虚构JSON测检查器，不是语料测量。
- P9默认14、快速宏13、恢复11、摘要3已快速通过。

### 最终门禁（本次真实执行）

| 命令 | 结果 | 门禁墙钟 | PASS检查点 |
|---|---|---:|---|
| `npm run check:worker` | PASS | 240 ms | `6c6e6ac` |
| `npm run test:codec` | PASS | 277,447 ms | `973c062` |
| `npx tsc --noEmit` | PASS | 4,898 ms | `4289bdc` |
| `npm run build` | PASS | 3,588 ms | `7e200e7` |

完整codec包含72格式、14宏、14默认、12 P10检查、原有主套件、独立worker，以及8项基线元数据检查；本轮一次完整门禁通过。上述耗时是测试/构建墙钟，**不是压缩提速或退化数据**，不可与旧套件耗时当作编码A/B。

四项收据、worker生成内容和小型证据使用同一源码指纹：
`bacb57caaffd55d88fb8d43d1673df6c3198d803736a23701e1cda095b34829c`。
源码检查点为 `9f693b274fa0b7bd2ea33ad28a029516868918ba`（核心实现 `6b0c533`）；测试树为 `c0df416b3d1ab2a9a0ebbd3c591a2e06cf56d0ff`。
交付清单 `scripts/diag/p10-results/checks/delivery.json` 另外绑定每份收据、日志、小型结果及测试树；后续交付文档提交不改变被测源码。

### 小型实际字节结果（不是语料收益）

固定32,768 B显式计划，以下三条路径的完整容器SHA-256相同；串行与合批成本数组也逐项相同。

| 路径 | 容器 B | 容器/原文 | 对串行差值 |
|---|---:|---:|---:|
| 串行完整择优 | 249 | 0.7599% | — |
| 真实worker合批/复用 | 249 | 0.7599% | 0 B /0% |
| 注入worker失败后回退 | 249 | 0.7599% | 0 B /0% |

该人工计划的baseline为5,965 B，孤儿完整候选713 B，随后宏完整候选249 B；macro记录的比较基线确为713 B，不是5,965 B。实际观察一次孤儿试验、一次宏试验、一次宏预编码和一次缓存命中。该用例只验证调度/完整容器门及无损，不代表默认规划器在真实文件上的收益。


门禁写入 `scripts/diag/p10-results/checks/gates/`；小型原始证据由下列可重复命令生成：

```sh
node scripts/diag/run.mjs probe-p10-smoke .diag-data/p10-small-smoke-local.json
```

其中sao尺寸/边界为无分配策略数据，worker权重人为放大以触发真实小输入并发，绝不是大输入吞吐结果。

## 用户本地12文件验收

保留e24原JSON。新建当前提交专用目录，继续16核、2文件并行×每文件8线程：

```sh
set -eu
cd universal-adaptive-compression-system
npm ci
npm run check:worker
REV=$(git rev-parse --short HEAD)
OUT="$PWD/.diag-data/p10-$REV"
mkdir -p "$OUT"
export OUT
printf '%s\n' mozilla samba ooffice webster nci reymont xml osdb mr x-ray sao dickens |
  xargs -P 2 -I '{}' sh -c 'UCZ_THREADS=8 node scripts/diag/run.mjs bench-one "/home/user/Downloads/silesia/$1" --no-single --no-bench > "$OUT/$1.json"' sh '{}'
node scripts/diag/check-baseline.mjs "$OUT" 0.5 --all
node scripts/diag/summary.mjs "$OUT"
```

重点核对：

- 12份 `verified=true`，新硬门禁零回退；总字节对42,368,023 B。
- sao是否为v18，`modelFlags & 0x04` 是否非零，`codecs` 中TG3的实际flags；不通过旧r位猜表宽。
- samba/mozilla的 `guardStats` 是否出现同族base复用/宏预编码复用，macro比较基线是否为实际post-orphan。
- 编码耗时与整集墙钟分开，运行环境、并行数和Node版本保持一致。
- 23位表使内存预算翻倍。每文件8worker的估算约4 GiB，两文件约8 GiB，另有主线程/共享输入/GC；**不是RSS上限保证**。显式8线程不会被默认内存估算暗改，请观察 `maxRSSMiB`。
