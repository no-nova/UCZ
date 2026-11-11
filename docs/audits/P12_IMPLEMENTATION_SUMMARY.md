# P12 三阶段实现与验收摘要

> **最新用户本机验收：** `d9b84df` 完整十二文件已报告 12/12 PASS，锁定基线更新为 **40,297,869 B**。见 [P12 本机验收报告](P12_LOCAL_VALIDATION.md)。下文保留当时的历史状态与证据，不改写旧凭证。

> **后续状态更新（2026-11-07）：** 用户本机全文件运行只有 **11/12**，Mozilla 在最终规则字典处失败，不能视为本实现全量通过。下面保留三阶段历史检查点证据；规则冲突修复、修复前后凭证、正确基线口径和新的本机命令见 [Mozilla 后续修复报告](P12_MOZILLA_COLLISION_FIX.md)。修复后的完整文件验收仍待本机执行，锁定基线未改。

固定分支：`arena/1220f47e-test`。

| 阶段 | 检查点 | 内容 |
|---|---|---|
| P12.0 | `f19e4d5` | 兼容的多片 kernel 路由、WORD-PRE v1、BCJ 家族与候选门、选择性孤儿策略 |
| P12.1 | `c97b6d3` | 独立版本化的 LE16/WIDE、BCJ25、TG3 长窗口及带进位差分 |
| P12.2 | `eb71c5c`，父提交 `c97b6d3` | 明确区分的新 CM 内核、逐组旧候选保留、序列化 recovery、worker 集成与有界验证 |

**锁定基线仍为用户本机 P11.1 的 41,814,147 B / 12 PASS。** 本次没有在 Arena 编码完整 Silesia 文件，也没有新的全量总字节、吞吐量、RSS 或最终全文件分组结论。每个文件哪怕回退 1 B 都必须 FAIL，不能用别的文件收益抵消。

## 1. 每阶段实测切片

下列都是 SHA 固定的 **262,144 B 窗口**，计入真实 UCZ 头的完整容器字节；不是完整文件，不是所有行都经过完整 adaptive 选路。不同规则/阶段的收益不可相加。

### P12.0：真实 base/v15/WORD-PRE 比价

对照为 `837250f`。

| 窗口 / 指定组 | 对照 B | P12.0 B | 差值 B | 差值 % |
|---|---:|---:|---:|---:|
| xml-mid / TEXT3 | 5,576 | 4,849 | -727 | -13.038 |
| nci-mid / TEXT3 | 13,795 | 12,717 | -1,078 | -7.814 |
| ooffice-code / BCJ3 | 101,991 | 101,991 | 0 | 0 |
| mozilla-code / BIN3 | 76,382 | 76,382 | 0 | 0 |

### P12.1：变换比较

对照为 P12.0。WIDE 是枚举实测的最佳模式，不代表完整文件上的采样器一定选择相同模式。

| 窗口 / 比较 | 对照 B | 新结果 B | 差值 B | 差值 % |
|---|---:|---:|---:|---:|
| mr-mid / 旧 WIDE 最优 → s6 | 55,850 | 49,259 | -6,591 | -11.801 |
| x-ray-mid / 旧 WIDE 最优 → s7 | 119,804 | 115,234 | -4,570 | -3.815 |
| ooffice-code / BCJ3 s1 → s2 | 101,991 | 100,314 | -1,677 | -1.644 |
| sao-mid-256 / TG3 stride 4，v15 | 163,182 | 159,438 | -3,744 | -2.294 |

**sao 限制：** 旧的 stride-28 在相邻的 262,136 B 对齐窗口为 139,912 B，小于新 stride-4 的 159,431 B。因此不能把 stride-4 的同规则改善说成 sao 最佳规则或完整文件获益。新 stride-28 的长窗口规划没有在沙箱测量；也未把这个结果归因于已证明被选中的 LE32/64 模式。

### P12.2：明确指定新旧 CM

对照均为不可变的 `c97b6d3`。BIN 使用恢复开启后的默认配置；TEXT 是原始文本，不是 WORD-PRE。

| 窗口 / profile | legacy-v15 B | v20 B | 差值 B | 差值 % |
|---|---:|---:|---:|---:|
| mozilla-code / BIN | 76,382 | 72,080 | -4,302 | -5.632 |
| ooffice-code / BIN | 114,659 | 111,755 | -2,904 | -2.533 |
| osdb-mid / BIN | 74,288 | 72,729 | -1,559 | -2.099 |
| dickens-mid / TEXT | 70,389 | 69,566 | -823 | -1.169 |
| webster-mid / TEXT | 57,284 | 56,466 | -818 | -1.428 |
| samba-c / TEXT | 32,691 | 32,224 | -467 | -1.429 |
| xml-mid / TEXT | 6,066 | 5,871 | -195 | -3.215 |
| nci-mid / TEXT | 13,795 | 13,278 | -517 | -3.748 |
| reymont-mid / TEXT | 48,387 | 47,380 | -1,007 | -2.081 |

恢复开关的**增量** A/B 已包含 fixM2、H4/H8、四档主混合器及 mht8<32：

| BIN 窗口 | recovery off B | on B | 额外减少 B |
|---|---:|---:|---:|
| mozilla-code | 73,180 | 72,080 | 1,100 |
| ooffice-code | 112,979 | 111,755 | 1,224 |
| osdb-mid | 72,797 | 72,729 | 68 |

三项分别获益后才启用默认恢复。六项 TEXT 的结果是整个新内核的比较，不能归因于单独一个 mixer2 开关，更不能外推到完整文本文件。生产仍保留旧 CM 和旧 WORD-PRE 候选、严格比较完整成本；例如 XML/nci 的旧 WORD-PRE 可能比表中的 raw-v20 更小。

## 2. 兼容性、证据与未完成门禁

- 新 CM 使用 v20 容器旗标 `0x1000`；恢复为容器旗标 `0x2000`。组字典额外使用 `rRaw 0x10000` 区分新 CM；合法 `r=8192` 没有被挪用。P12.1 的 `0x0800` 仅授权变换，不隐式切换 CM。
- 历史 v18、旧 v19 和 WORD-PRE-off 解码验证通过；14 份冻结的 P12.1 v20/legacy-CM 容器也通过，未重新生成这些参考字节。
- 新旧混合组、WORD-PRE v20、dual.alt、几何/哈希索引、ms2 范围、恢复距离、真实 worker 克隆元数据和主线程最终容器一致性均有有界测试。
- 完整基线逐文件检查器的 8 项测试通过。TypeScript、生产构建及 worker freshness 通过；P12 有界 shards、P9 defaults 通过。
- 63 份实现凭证全部记录 PASS，其中 P12.2 为 33 份（含对照和复跑）。P12.2 最长凭证 7,445 ms；三阶段最长 15,638 ms。最终九份源码复跑与之前容器 SHA/字节一致。
- **未宣称完整 `npm run test:codec` PASS。** 完整 suite 留给本机；`history-write adaptive-periodic` 的当前写入测试达到 17.5 秒内部上限，仍未通过。之前完整 P11.1 的 19 秒超时也不是 PASS。其它五个当前历史写入 fixture 有独立通过结果。详见阶段报告中的超时、批次截断和临时 bundle 冲突记录。
- 续接时仅恢复了本地 Git 元数据：远端 P12.1 检查点经核对，508 个检查点文件不变、15 个 P12.2 修改文件及全部新凭证保留，未覆盖工作文件。

无编码的历史证据核对命令（`--current` 只适用于原 `eb71c5c` 源码；后续修复不重写旧凭证）：

```sh
timeout --signal=KILL 19s node scripts/diag/p12-impl/verify.mjs
# 当前修复源码使用自己的凭证：
timeout --signal=KILL 19s node scripts/diag/p12-fix/verify.mjs --current
```

阶段报告：[P12.0](P12_0_IMPLEMENTATION.md)、[P12.1](P12_1_IMPLEMENTATION.md)、[P12.2](P12_2_IMPLEMENTATION.md)。固定窗口来源与 SHA、控制源码、执行入口和结果均在 `scripts/diag/p12-impl-results/`。

## 3. 本机完整验收：16-worker、全部 12 文件

**以下仅供用户本机执行，不在 Arena 沙箱执行。** 需在本分支的最终 P12.2 提交上，保持源码不变。先完成完整 codec suite；不能把上面的有界测试当作它的替代。

```bash
# 从仓库根目录开始；需要 Bash、项目支持的 Node/npm。
cd universal-adaptive-compression-system
set -euo pipefail

npm ci
npm run check:worker
npm run test:codec
npx tsc --noEmit
npm run build

# 如果语料在其它目录，先 export CORPUS=/绝对路径/Silesia。
CORPUS="${CORPUS:-$PWD/.diag-data/corpus}"
FILES=(xml dickens ooffice mr osdb x-ray sao reymont nci samba webster mozilla)
for f in "${FILES[@]}"; do test -f "$CORPUS/$f"; done

mkdir -p .diag-data
OUT=".diag-data/p12-full-$(git rev-parse --short HEAD)-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$OUT"
printf 'Results: %s\n' "$OUT"

# 逐文件执行；文件内部请求 16 workers，不同时启动 12 个全文件进程。
# 每项完成即保存 JSON；中断留下的 .tmp 不会作为完成结果被接受。
for f in "${FILES[@]}"; do
  printf 'Encoding %s\n' "$f"
  UCZ_THREADS=16 node scripts/diag/run.mjs bench-one "$CORPUS/$f" \
    --no-single --no-bench > "$OUT/$f.json.tmp"
  mv "$OUT/$f.json.tmp" "$OUT/$f.json"
done

# 必须恰好覆盖 12 文件、输入 size/SHA 一致、verified=true、逐文件不回退。
node scripts/diag/check-baseline.mjs "$OUT" --all
```

命令已对照实际 CLI：`bench-one` 读取传入的**完整文件**，没有切片长度参数；`--no-single --no-bench` 只关闭额外单模型/外部基准，并不关闭完整解压校验。`UCZ_THREADS=16` 请求内部并行，实际同时运行的 worker 数取决于独立任务数；该环境变量覆盖默认内存保护，请确保本机内存足够。`probe-p9-ab` 当前硬编码 `serial:true`，所以不能用它冒充 16-worker 的全量命令。

每个结果包含源码身份、真实输入 SHA、大小、校验结果和实际选择的容器旗标。最终 `--all` 是硬门禁；没有新测量之前，**41,814,147 B / 12 PASS** 不变。
