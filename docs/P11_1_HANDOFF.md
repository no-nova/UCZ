# P11.1 交付：固定 mht4、紧凑配置头与 P10 小文件路径

## 本轮结果与范围

实现已完成，**四项门禁均重新执行并通过**。源码/测试检查点：`72d8873c737191df5ae898745e0af98e1b82f365`，在 `arena/1220f47e-test` 直接推送。

- 源码指纹：`d84c81f239b2f32aeaf29167db9000a527c5aff66a461b3969757b2ab3f8e07b`。
- 测试树：`b8ce3fe1c4c2eef43552c1e0fa1f9db584d82094`。
- 交付清单：`scripts/diag/p11-results/checks/delivery-p11-1.json`，绑定本轮四份日志/收据、小样本结果、历史参考及测试树。不覆盖原P11的 `delivery.json`。

**没有在 Arena 跑语料、全文件/切片性能测量，未新增 >256 KiB 输入。** 新增实际输入最大48 KiB；按请求运行的既有完整 codec 套件仍包含原有较大的合成用例。

## 改动

### 1. 所有默认生产档 mht4<=20

| 原始组/独立块大小 | CM上限 | mht4上限 | mht8上限 |
|---|---:|---:|---:|
| `<512 KiB` | 21 | **20** | 20 |
| `[512 KiB,4 MiB)` | 22 | **20** | 21 |
| `[4 MiB,8 MiB)` | 23 | **20** | 22 |
| `>=8 MiB` | 24 | **20** | 23 |

CM24/mht8=23保留，TG/SUB/WORD-PRE的原始组/块尺寸继承保留。旧流解码继续使用各自的历史模型，不把新默认套到旧流。

### 2. 低档恢复 P10 头，高档显式标明 mht4 策略

- 实际选中载荷没有 CM24/mht8=23：需要配置时写 **v18 uint8**；不需要配置时仍按P10写v7–v15，不凭空增加头。
- 实际需要24/23：写 **v19 uint16 LE**，新增原先空闲的 `0x400` 明示 mht4固定20。此位必须伴随 `0x100` 或 `0x200`。
- 旧 v19 没有 `0x400`：保留 P11 的扩展mht4解码。新解码器通过独立旧提交生成的真实raw-CM参考验证，不只是新编码器自往返。
- v18所有旧位、v17旧解释以及合法行宽8192的 `0x2000` 不改。旧P11解码器会拒绝新高档标志，须升级；不会静默按错误模型解码。
- `planHeader`同时用于最终写入、真实成本及元数据测试，只计最终选中载荷，不把被拒绝的高档/WORD-PRE候选标志带入头。

详见 [UCZ_V19.md](UCZ_V19.md)。

### 3. 为 P10 字节路径恢复必要的选择策略

仅改mht4与第二flags字节并不足够：P11还修改过完整 `chooseSpec` 探针域、孤儿cap24→64。

- **整输入 <8 MiB**：恢复P10的512 KiB复核/完整候选比较及孤儿cap24。
- **整输入 >=8 MiB**：保留P11有界 `chooseSpec` 探针与孤儿cap64。
- 主线程与worker均传递**整输入长度**，不按局部小区域误分支。
- 其它有界小窗在默认P10/P11.1下有相同有效表几何；默认小文件的宏仍直接完整比较。
- 孤儿仍是 `<2 MiB AND <20%`、排除FILL、单批真实重编码；完整容器严格更小才采用，持平/更大回退。
- 保留P11精确拒绝base/cost复用、candidate-only worker及候选合批；没有添加预测赢家的跳过启发式。

这明确取代P11的“所有 chooseSpec 复核强制<=21”要求，优先满足本轮P10字节身份目标；不是未经说明地宣称两种策略等价。

## 独立旧源码小样本验证

`freeze-p111-references.mjs` 从固定 `d4bf4d8`、`147b778` 读取原始Git blobs，在忽略目录里独立打包；不切换分支、不改历史源码、拒绝覆盖既有参考。参考记录历史源码逐文件SHA，测试比对完整容器字节，而不只比大小或做自往返。

| 用例 | 输入 B | P10 B | P11.1 B | 差 B / 差% | 实际容器版本 |
|---|---:|---:|---:|---:|---:|
| adaptive-prose | 49,152 | 156 | 156 | 0 / 0% | 7 |
| adaptive-periodic | 32,768 | 182 | 182 | 0 / 0% | 13 |
| adaptive-mixed | 40,960 | 16,547 | 16,547 | 0 / 0% | 7 |
| guarded-orphans | 32,768 | 249 | 249 | 0 / 0% | 13 |
| guarded-many-rules | 16,480 | 420 | 420 | 0 / 0% | 13 |
| guarded-wordpre | 49,152 | 111 | 111 | 0 / 0% | 13 |

前三项跑真实自适应入口；后三项是显式人工计划的完整严格回退路径，不冒充自然语料规划结果。其中两种多组用例还与4批真实worker比较容器及成本数组；many-rules的24组吸收范围/中间字节数也与P10一致。

另外：

- 128 B raw-CM、虚拟512 KiB与8 MiB−1原始组：新编码与独立P10字节相同，几何分别22/20/21、23/20/22。
- 固定P11旧源码的128 B、虚拟8 MiB raw-CM / flags `0x310`：新解码器仍分配24/22/23并正确解码。虚拟尺寸不是大文件编码测量。
- P11既有小测试现验证新24/20/23真实表分配、flags `0x700`及对称解码；精确缓存/候选-only/孤儿赢家反例继续通过。
- 元数据测试覆盖生产写头函数的低位v18与高位v19。实际WORD-PRE候选经该函数得到 **342 B / v18 / flags64**，与归档e24低档payload加明确的v17→v18位映射一致；它是候选分支测试，**不是**上表自适应/严格择优选中的111 B结果。
- P11.1共13项检查。初次跨输入的自定义worker诊断未按逐文件关闭共享池而失败，已修正测试runner生命周期；生产池未修改、断言未删除。

小样本证据：`scripts/diag/p11-results/checks/small-smoke-p11-1.json`。复现到新文件：

```sh
npm run test:p111
node scripts/diag/run.mjs probe-p111-smoke .diag-data/p111-smoke-local.json
# 可选：从固定旧源码独立重建历史参考到新位置，禁止覆盖提交内的参考。
node scripts/diag/freeze-p111-references.mjs .diag-data/p111-reference-local.json
node scripts/diag/freeze-p111-references.mjs .diag-data/p111-wordpre-local.json guarded-wordpre
```

## 本轮四项最终门禁

| 命令 | 结果 | 门禁墙钟 | PASS检查点 |
|---|---|---:|---|
| `npm run check:worker` | PASS | 275 ms | `b91cc8b` |
| `npm run test:codec` | PASS | 289,537 ms | `02c8b62` |
| `npx tsc --noEmit` | PASS | 4,443 ms | `e38bd1f` |
| `npm run build` | PASS | 2,888 ms | `52dff5b` |

每项独立保存并推送，收据名为 `{worker,codec,tsc,build}-p11-1.{json,log}`，源码指纹相同且运行期间未变。完整codec含72格式、14宏、14默认、12 P10、9 P11、13 P11.1检查、原有主套件、独立worker及8项严格基线元数据测试。**门禁墙钟不是压缩性能A/B。**

## 本机待验：不将目标写成实测

用户P11本机报告总量 **41,813,622 B**、相比P10减少225,026 B，但有3个单文件回退，总体逐文件零回退验收未过。来源与12项表已归档 [LOCAL_147B778.md](audits/LOCAL_147B778.md)，原JSON未上传，非Arena复测。

| 重点文件 | P10/P11.1目标 B | 用户P11 B | 用户P11回退 B | P11.1全文件实测 |
|---|---:|---:|---:|---|
| xml | **349,873** | 349,881 | +8 | 本机待验 |
| reymont | **1,092,321** | 1,092,333 | +12 | 本机待验 |
| ooffice | **1,973,904** | 1,973,919 | +15 | 本机待验 |

严格基线仍为P10 **42,038,648 B**；逐文件1 B也不放行，没有把P11的三个回退值写入基线。所有默认 `<8 MiB` 恢复P10路径，包括sao；不承诺保留它在P11的−8 B变化。小样本证明不能代替所有语料逐字节验收，大小一致也不等价于压缩流完全相同。

沿用本机命令，使用新目录且保留旧结果：

```sh
set -eu
cd universal-adaptive-compression-system
npm ci
npm run check:worker
REV=$(git rev-parse --short HEAD)
OUT="$PWD/.diag-data/p111-$REV"
mkdir -p "$OUT"
export OUT
printf '%s\n' mozilla samba ooffice webster nci reymont xml osdb mr x-ray sao dickens |
  xargs -P 2 -I '{}' sh -c 'UCZ_THREADS=8 node scripts/diag/run.mjs bench-one "/home/user/Downloads/silesia/$1" --no-single --no-bench > "$OUT/$1.json"' sh '{}'
node scripts/diag/check-baseline.mjs "$OUT" 0.5 --all
node scripts/diag/summary.mjs "$OUT"
```

`check-baseline`核验输入SHA/长度、往返和输出大小，不声称比较旧压缩流字节。若验证严格字节身份，应保留P10 `.ucz` 并逐字节 `cmp`，或用独立P10源码对同一输入重编码比较；不要只根据bench的输入SHA认定压缩流相同。

新24位bin/v15模型的表体576+4+32=**612 MiB**，相较P11少12 MiB/live model，非无条件每worker少24 MiB。默认仍预算1024 MiB/worker并保留1024 MiB余量；显式8线程不改。两文件×8worker需要相应内存余量，观察maxRSS并在同配置下比较时间。P11.1全量大小、速度、RSS均未在Arena测量。
