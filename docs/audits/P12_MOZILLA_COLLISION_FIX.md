# P12 后续：Mozilla 规则冲突与诊断修复

> **最新用户本机验收：** `d9b84df` 完整十二文件已报告 12/12 PASS，锁定基线更新为 **40,297,869 B**。见 [P12 本机验收报告](P12_LOCAL_VALIDATION.md)。下文保留当时的历史状态与证据，不改写旧凭证。

日期：2026-11-07。固定分支：`arena/1220f47e-test`。修复父提交：`eb71c5c748aced5f8081af9c6e56f9f65e9fe2fd`。

## 结论与验收状态

**用户本机的新一轮结果是 11/12，Mozilla 失败；不是 P12 全量通过。** 此次修复了可用 4,133 B 输入复现的编码期规则冲突，并通过有界回归、实际 worker、缓存、历史解码和诊断测试。**尚未在修复后跑完整 Mozilla 或完整十二文件，也未完成完整 `test:codec`。** 不外推完整文件字节、速度、RSS 或最终分组。

锁定基线仍为用户本机 P11.1 的 **41,814,147 B / 12 PASS**；`baseline.json` 与严格 `check-baseline.mjs` 均未修改。任何文件回退 1 B 都不允许用其它文件收益抵消。

## 1. 根因与修复

合法初始计划可以同时有独立的 `TG(id=10,s=4,r=1)` 和 `2D(id=22,s=4,r=1)` 分组。原编码器逐组比较完整转置候选后，允许前者晚期改为后者的规则，直到 `planHeader` 才发现两个独立字节流占用了相同字典键，并抛出 `自动转置产生重复的方案规则`。

这不是应当吞掉的异常，亦不能将两个已编码的流拼接成一个流，或简单给载荷换规则标签。

本次改动：

- 在最终分组编码前，为所有初始 `(id,s,r)` 键建立组对象所有权；初始键持续保留，获选的新键立即登记。
- `encodePlanTranspose` 只编码并比较未被其它组占用的 2D/TG3 候选，保留真正编码得到的旧 TG 流作为回退。未占用时原来的严格完整成本比较不变。
- 同一约束应用于 `evaluatePlan`、普通转置升级、≥1 MiB 的 TG→TG3/v15/v20 升级入口，以及缓存别名的恢复。缓存目标冲突时不复用该项，而非接受冲突后再修补头部；不受影响的缓存仍可复用。
- 保留最终字典唯一性断言和解码器对重复字典的拒绝；没有修改容器格式、旧解码语义或 CM 参数。
- 原大套件曾把“合法初始计划晚期冲突”写成预期抛错，现改为成功求值；真正的重复-wire 负例保留。

**边界：** 小型用例证明这个缺陷无需 Node 26 或 `xargs -P 2` 即可发生。用户 Mozilla 的最终分组目录未提供，因此不能认定它实际冲突的 stride 恰为 4、规则恰为 10→22；此处具体规则仅属于合成复现。≥1 MiB 分支检查了共享所有权谓词与调用位置，未进行大输入重编码测试。

## 2. 不可覆盖的修复前后凭证

入口：`scripts/diag/p12-fix/probe.ts`、`run.mjs`。数据为固定 xorshift 种子生成的 4,096 B、stride-4 行相关主体，加 37 B 尾段；串行显式计划，不执行完整 adaptive 选路，不读取 Silesia。

输入 SHA-256：`4ad3071a2d54f526889b12f5978ba11d879db4cf181b18994357df7dc77357cd`。

| 凭证 | 源码 | 状态 | 结果 | 凭证耗时 |
|---|---|---|---|---:|
| `collision-eb71.json` | 不可变 `eb71c5c` | **FAIL，退出 1（预期复现）** | 原重复规则异常；未生成可验证容器 | 1,071 ms |
| `collision-fixed.json` | 初步修复工作树 | PASS | 791 B，完整 roundtrip | 964 ms |
| `collision-final.json` | 含缓存诊断入口的最终修复源码 | PASS | 同为 791 B，相同容器 SHA | 1,796 ms |

三次不冲突的单组控制均为 **574 B**，容器 SHA 相同；保留可行升级。修复后冲突用例的最终键为 `TG3(30,4,1)` 与原有 `2D(22,4,1)`，容器 SHA 为 `953066fa0396cf5d611068e1bf5123cc906692e09e821be6015ef2d18ced40b8`。

最终 `src/lib/*.ts` 指纹：`b6db9d1acdd4ce83c239b17aa98e25b1e79bda82e0634e3fe83bc0582123f636`。算法为按文件名排序的“文件名→SHA-256”对象的 JSON 字符串 SHA；不同于包含更多路径的 bench-one 源码指纹。工作树凭证明确记录 `workingSource=true`：其中 `sourceCommit=eb71…` 是测量时 HEAD，不把未提交修改冒充成该提交。最终字节身份由逐文件哈希绑定。

只读核对（不编码任何语料）：

```bash
timeout --signal=KILL 19s node scripts/diag/p12-fix/verify.mjs --current
# 原有 63 份 P12 凭证保持历史身份；此处不要加 --current。
timeout --signal=KILL 19s node scripts/diag/p12-impl/verify.mjs
```

复现需有 Git 历史，且使用新的标签，绝不覆盖旧凭证：

```bash
# 以下第一条必须退出 1，表示旧缺陷被复现，不是测试通过。
timeout --signal=KILL 19s node scripts/diag/p12-fix/run.mjs repro-old-NEW eb71c5c748aced5f8081af9c6e56f9f65e9fe2fd
# 单独执行；不要用 && 把它接在预期失败命令后。
timeout --signal=KILL 19s node scripts/diag/p12-fix/run.mjs repro-current-NEW
```

## 3. 有界回归与尚未验证项

以下命令均实际执行，并以 `timeout --signal=KILL 19s` 限时；P12 shard 内部另有 17.5 秒子进程上限。耗时是工具测得的检查时长，不是压缩性能比较。

| 检查 | 本次结果/工具耗时 |
|---|---|
| `node tests/run-p12.mjs collision`：正反组顺序、两个目标均占用、真实旧载荷回退、成本、求值器、实际 worker | PASS / 4,565 ms |
| `node tests/run-p12.mjs cache-collision`：同一输入的三套计划，2D/TG3 缓存目标依次被占用；冷缓存与 worker 对照 | PASS / 5,416 ms |
| `reservations` + `mixed`，同一限时命令 | PASS / 2,781 ms；含重复-wire 拒绝及 14 个独立冻结的 P12.1 容器 |
| `history`：独立历史容器、v18/旧 v19、WORD-PRE | PASS / 3,493 ms |
| `worker-plan`：恢复开/关、未知孤儿成本不得触发投机 prefetch | PASS / 3,266 ms |
| `worker-v20` + `unit`，同一限时命令 | PASS / 2,440 ms |
| `family`：家族归一化、绝对位置 roundtrip | PASS / 3,822 ms |
| `node tests/run-p9-defaults.mjs` | 14 checks PASS / 4,506 ms |
| `node --test tests/p122-diagnostics.test.mjs` + `tests/p10-baseline.test.mjs`，同一限时命令 | 7+8 tests PASS / 5,112 ms |
| `npx tsc --noEmit` | PASS / 4,855 ms |
| `npx tsc --noEmit -p tests/tsconfig.p12.json` | PASS / 4,964 ms |
| `npm run build`，含 worker freshness | PASS / 6,937 ms |
| 两套凭证核对、`bash -n`、`git diff --check`，同一限时命令 | PASS / 385 ms |

缓存测试使用 **4,193 B** 合成输入和生产 `encodePreparedPlan` 的真实缓存，未捏造压缩字节。实际 worker 是注入的单个 Node worker，用来验证字节、flags 和成本恢复；**不是 16-worker 吞吐量测量**。TG 的晚期候选选择仍在生产主线程，测试包含它与 worker 返回的其它组载荷的组合。

单独扩展 P12 测试的严格类型检查曾发现旧 worker 测试两处 nullable candidate 访问；增加实际候选存在断言后通过。未降低解码/字节断言。

**没有执行：** 修复后完整 Mozilla、完整十二文件、完整 `npm run test:codec`、新的 ≥1 MiB 编码验证。此前 `history-write adaptive-periodic` 超时仍未解决，不能用本次短测试替代。没有把部分检查描述为完整 suite PASS。

## 4. Git 来源与汇总修正

- `gitHead` 显式捕获 stdout/stderr，3 秒上限；非 Git 源码归档返回 `null`，不再泄漏重复的 `fatal: not a git repository`。
- `bench-one.source` 保留真实源码 SHA，新增 `gitAvailable`；无 Git 时 `commit=null, gitAvailable=false`，不填入猜测的提交。
- 已从无 `.git` 的源码归档、异于项目根的 cwd，实际执行 `run.mjs bench-one` 的 **64 B** 输入。验证了空 stderr、完整 roundtrip、源码 SHA、`sourceUnchanged=true` 和空 commit。临时 `/tmp/terrazip-diag-*` bundle 本身是正常设计，不能据此断言 Git 根定位错误。
- `summary.mjs` 默认对比锁定 **P11.1 `bestUcz`**；`--v14` 才使用历史 `ucz`，并明确标注“不是锁定 bestUcz”。不再把旧 v14 时长标作 P11.1 时长。
- 支持显式 JSON 文件路径；非法/重复/未验证/输入 size 或 SHA 不符/运行时源码变化的结果不计入有效小计。
- 缺项明确显示有效覆盖数及“子集小计”；混合或缺失源码 SHA 明确警告。`--all` 要求十二项有效、唯一、同一源码。一个文件多 1 B 仍失败，不因其它文件获益或 `--v14` 而放宽。
- 汇总是只读展示，不改基线；正式检查仍要运行严格 checker，另配 `summary --all` 的源码一致性检查。

```bash
node scripts/diag/summary.mjs /tmp/p4                # 旧目录只作历史/部分结果解读
node scripts/diag/summary.mjs /path/to/xml.json      # 明确单文件也能读取
node scripts/diag/summary.mjs /tmp/p4 --v14          # 显式历史对照
```

## 5. 保留用户提供的十一项证据

以下只转录用户日志，不是 Arena 新测量，也没有用户上传的原始 JSON/source SHA 可独立核对。其实际提交身份未知。归档：`scripts/diag/p12-fix-results/user-local-partial.json`，特意不是伪造的 bench-one PASS 文件。

| 文件 | 用户报告 B | 锁定 P11.1 B | 差值 B |
|---|---:|---:|---:|
| xml | 339,516 | 349,873 | -10,357 |
| dickens | 2,214,517 | 2,248,669 | -34,152 |
| ooffice | 1,955,064 | 1,973,904 | -18,840 |
| mr | 1,798,884 | 2,039,355 | -240,471 |
| osdb | 2,277,558 | 2,318,027 | -40,469 |
| x-ray | 3,548,450 | 3,662,990 | -114,540 |
| sao | 3,132,317 | 3,747,789 | -615,472 |
| reymont | 1,064,930 | 1,092,321 | -27,391 |
| nci | 1,217,746 | 1,309,875 | -92,129 |
| samba | 3,349,194 | 3,407,921 | -58,727 |
| webster | 6,276,863 | 6,405,652 | -128,789 |
| **上述十一项小计** | **27,175,039** | **28,556,376** | **-1,381,337（-4.837%）** |
| mozilla | **失败，无字节结果** | 13,257,771 | 未知 |

旧汇总的 **30,511,646 B / -10.94%** 是这十一项对 **v14** 的比较，不是对锁定 P11.1 的比较，更不是十二文件总量。用户日志中 1,581 s 对 1,244 s 同样混有 v14/缺项口径，并使用两个并发文件进程，不能据此与先前单次 16-core 的十二项基线给出等价吞吐量结论。

## 6. 用户本机复验（不在 Arena 执行）

新增 `scripts/diag/p12-fix/local-validate.sh`。每次创建全新 `.diag-data/p12-fix-…` 目录，不覆盖 `/tmp/p4`；逐文件运行、内部请求 16 workers，每项通过完整解压及源码一致性验证后才将 `.json.tmp` 原子改名为 `.json`。错误保留 `.stderr.log` 与临时 stdout。每项随即走逐文件严格基线检查。

脚本也支持无 `.git` 的源码归档；用源码 SHA 固定本次运行，不伪造提交名。`--verbose-segs` 保存真实最终区域诊断。脚本在 Arena **只做过 `bash -n` 语法检查**，未执行完整文件。

```bash
# 从更新后的项目目录运行；先 npm ci（若依赖未安装）。
# 不要在旧进程仍运行时覆盖其源码。
cd universal-adaptive-compression-system
npm run check:worker

# 先单独确认 Mozilla：完整输入、完整解压、逐文件 <= 13,257,771 B。
UCZ_THREADS=16 bash scripts/diag/p12-fix/local-validate.sh mozilla /绝对路径/Silesia

# 最终验收还需完整 suite；仅供本机，无沙箱时限替代。
npm run test:codec
npx tsc --noEmit
npm run build

# 要形成新版本的完整验收，必须同一源码重跑齐十二项。
# all 模式先跑 Mozilla，尽早暴露失败；不把旧十一项复制进来凑数。
UCZ_THREADS=16 bash scripts/diag/p12-fix/local-validate.sh all /绝对路径/Silesia
```

`UCZ_THREADS=16` 是请求值，实际并行取决于独立任务数；覆盖默认内存保护，需确保本机内存充足。Mozilla-only 即使通过，也不能把旧源码的十一项与它混拼成同版本 12 PASS。**在完整同源码验收完成之前，锁定基线不变。**
