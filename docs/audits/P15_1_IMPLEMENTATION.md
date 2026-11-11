# P15.1 生产实现与有界验证

## 状态与约束

本次在 P14.1 用户本机 12 文件基线 **40,075,423 B**（源码提交 `18f497d`）上实现 P15.1。阶段性提交 `bdcd6d7` 已推送；本报告对应最终生产源码 SHA-256 指纹 `5834590acb58b56f8259f30917929fc20f65d6b8c9d7582ff813dda554328e1b`（`src/lib/*.ts` 文件名及散列的 JSON 指纹）。运行用户本机完整 12 / 16 文件前，以下都是有界证据，**不代表全文件收益、吞吐或逐文件零回退已经验收**。不得因为一个文件变小抵消其他文件 1 B 增大。旧基线未更改；全量总量、RSS 和 16 文件 AITDCC 均未在 Arena 测得。

用户目录中一些数字 ID 与本仓库的实际枚举有冲突，不能按描述重新解释旧格式：1=FILL、2=RLE、9=TRANSPOSE、10=TRANSPOSE-G、11=BCJ、20=BCJ2、22=TRANSPOSE-2D、26=GRAD3、28=SUB-TRANSPOSE3。下文按**代码实际 ID** 实现对应名称。P15.0 中 TEXT −226 / −90 / −892 B 是 **256 KiB** 窗口的实验数据，不是每 64 KiB。

## 实现

1. `text-sparse5` 占 v21 组上下文码 5，限已选 raw TEXT 4/18/23 且不使用 WORD-PRE；H8 精确 `hh(b1,b3,g(5))`，字母词状态及 H0–H7 不变。原有 P13.1 WP admission 不变。对已胜出的 segmented 或 macro 结果做后处理，至少 256 KiB 时先用头/中/尾合计至多 192 KiB 筛选（现有 0.15% 预筛），再对实际组和完整序列化容器同时严格缩小才替换。缓存的 v20 全组 control 直接复用。
2. TG3 id30 的码 1 只应用于子流 BIN/TG word-delta 的 H8，保留原几何 H0–H7、相位、子组布局和 APM 抑制；STORE/O0/DELTA 子流不使用它。组的 s/r、group 模式、member seams 与编解码一致；r 从带标记 `rRaw` 正确掩出。相同候选接入 serial 和 worker，旧 id30 无上下文的解码不变。实际存在可序列化的 context CM 子流才可成为候选，否则不采用。
3. 对最终已选且未使用 v20 的实际 DELTA 6/27、TRANSPOSE 9、TRANSPOSE-G 10、SUB-TRANSPOSE 15/28、TRANSPOSE-2D 22、GRAD3 26 提供 v20 CM 后处理候选；>=256 KiB 使用 192 KiB 头/中/尾门，仅 group payload 和全容器都严格变小时采用。保留原变换和各子流 profile，r 字段在标记位解析后处理；旧流不改变。老选择器本已尝试部分 DELTA/TG 的 v20，本阶段只重新审视最终 retained 组。若变换子流不包含实际 v20 CM，则不标记或采纳；错误保留旧容器。此后处理目前串行执行，未测完整 Mozilla 额外耗时。
4. `encodeCMContextDual` 仅对 H8 差异的 identity BIN stride4、WP token3、raw TEXT sparse5 使用：共享 H0–H7 和 match 输入表，但独立 H8、mixer、APM 与算术码；先计算两路预测再共同学习。探针需要同时算 control 和 candidate 时使用；全组若 control 已缓存则只算 candidate。无缓存且单个兼容候选时同时计算两路。TG3 内部 geometry 与 WIDE、WP merge 不使用此共享路径。真正 worker 使用同一个候选逻辑。
5. REC2 id32 是 v21 新格式，要求容器 0x4000、0x0800、0x1000 与组 APM/v20；不占用任何 group context code。编码前 len≥16384 且首 2048 B 的 H0>7.5，搜索 1≤a<b≤63 的 1953 对与五种运算；训练、非重叠尾部各 2048 B 的残差均要求 `(zeroOneRatio>0.80 || H0<5)`。仅实际完整 UCZ 比现有完整容器小才采用，否则原容器不变。变换流是 `[op,a,b, seed[0..b-1], residual[b..n-1]]`，长度恰好 **n+3**；整个流由 BIN v20 CM 编码，解码长度由 UCZ 的 n 确定，无需猜 b。解码检查 op 0..4、`1<=a<b<=63`、种子长度、n+3 及 MAX_OUTPUT_BYTES。该结构检查不是 CRC，也不保证任意损坏都可检测。检测固定约 2000 万残差运算；通过 H0 前不做搜索。

组 WORD-PRE 0x4000、APM 0x8000、CM 0x10000、v21 上下文 17..19 位与旧 r=8192 保留；容器的 0x2000 与组字段不同。没有修改 WIDE 模型或强制 x-ray BE16。

## 有界实测：完整容器与往返

以下 `forced` 是同一窗口、指定一个 TEXT3 组的真实 UCZ 完整容器，并非自适应最终规则；数字不能按窗口外推。

| 256 KiB 固定窗口 | v20 raw TEXT UCZ | sparse5 UCZ | 差值 |
|---|---:|---:|---:|
| Webster mid | 56,466 | 56,376 | −90 B |
| Reymont mid | 47,380 | 47,154 | −226 B |
| Samba mid | 13,709 | 12,817 | −892 B |
| Dickens mid | 69,566 | 69,556 | −10 B |
| Mozilla code | 80,478 | 80,428 | −50 B |
| ooffice code | 119,322 | 119,238 | −84 B |

真实自适应 64 KiB：Webster **16,107→16,064 B**；Reymont **13,220→13,143 B**；Dickens candidate 19,652 B 高于旧 19,649 B，保留 **19,649 B**。三者往返正确；前两者实际复用 v20 control。Webster 256 KiB **自适应测试超时 17s**，未得结果、未原样重试；强制窗口测试不是该超时的替代结果。

TG3 32 KiB 双成员强制完整容器：Mozilla resources 4045→3990 B（payload 4021→3966）；ooffice code 14927→14839（payload 14903→14815）；两者真实 worker 和 serial 候选一致，解码往返。不是其全文件目录的实测。16 KiB Mozilla resources 强制 legacy 对照包括 TRANSPOSE 3355→3407 B、TRANSPOSE-2D 2965→2857、SUB3 3709→3649、GRAD3 5813→5951、DELTA 4087→3775、DELTA3 3694→3775、TG 2964→2856；亏损说明不能无条件升级。32 KiB explicit-plan SUB 实际后处理 5898→5832，亏损的 TRANSPOSE explicit-plan 3354→3354 原容器逐字节保留；这两项不是自然自适应分组证明。

REC2：256 KiB glibc seed=1 的每次 `rand()` 返回低字节（P15.0 已与本机 glibc 2.36 逐字节比对）真实 `compressAdaptive` 容器 **262,162→22,909 B**，比率 8.739%，v21 id32 往返；与 P15.0 的 26,862 B 实验 P15R+O0 框架不是同一格式/模型。64 KiB plus/minus/xor 真实完整容器分别 65554→6779 / 6779 / 6780 B；共享合成噪声，不是独立统计样本。256 KiB random 和前缀递推、尾段随机 adversarial 都严格保留原 262162 B 容器。80 个五运算、滞后边界和畸形参数/长度的变换测试及编码后畸形 UCZ、旧版本拒绝测试通过。12 个 Silesia 文件的前 16 KiB（合计只读 196608 B）首 2 KiB H0 均≤7.5，全部跳过搜索；单次 JS 测量约 0.07–0.58 ms，并非用户假设的 <0.01 ms。不是所有高熵数据零误报的证明。

## 验证记录与限制

- 单次命令均用 `timeout --signal=KILL 19s`，每个 codec 输入≤256 KiB。`scripts/diag/p151/run.mjs` 单独构建并运行每个测试，17s 内层超时、不可覆盖收据、记录输入哈希、完整源码/测试哈希；`scripts/diag/p151/history/` 保存对应源码。`node scripts/diag/p151/verify.mjs` 检查收据和归档身份，**不重跑实验**：42 条收据 41 PASS / 1 FAIL；其中 41 条早于 codec.ts 一处仅注释更正，验证器逐字节核对该唯一差异（Webster 256 KiB 超时）。
- dual：三模式、a2 text on/off，0、1、2、3、4、7、8、11、12、15、16、31、32、63、127、255、1024 B 共 102 个组合及 64 KiB 6 组，两路与独立编码逐字节/flag 完全相同、解码正确；生产 Webster 192 KiB screen 两路结果与独立编码一致，完整 control 复用。XML 256 KiB WP screen 和完整候选往返通过。P15.0 对两独立编码的计时减少仅 2.47%–19.62%，本次没有全文件速度或 RSS 数据。
- 旧文件：10 个独立旧自适应容器（v13/v15/v20）与 4 个冻结 v15/v17 容器解码通过；独立归档的 v18/v19 **raw CM 模型**也在对应模型范围下解码通过，包含历史 v19 行为。旧 v21 wire、r=8192、模式拒绝、strict equality、WP 的 textOn/历史 off 策略和 WIDE 子平面测试通过。另外用 `18f497d` 旧 coder 产生 payload 并构造 v14/v16 完整容器，各 4096 B 往返通过；不是独立归档的实际历史容器。重跑前以 `git archive 18f497d src/lib | tar -x -C .diag-state/p151-old/lib --strip-components=2` 提取旧源码（先创建目标目录）。因此不能声称完整覆盖 v14–v20 的所有历史容器；应补充用户本机遗留样本。一次新 wire 测试因 `Buffer` 和 `Uint8Array` 类型不同而失败，修正断言类型后通过；另有一个误传 `wp` 的 screen 命令实际测试 BIN，正确 `wp-token3` 测试单独收据保留。
- `npm run check:worker`、`npx tsc --noEmit`、`npm run build` 均通过；22 个 baseline/diagnostics metadata 测试、14 个 UI 测试通过。完整 legacy `test:codec` 未运行或宣称通过。收据中的完整源码指纹是修改未提交时计算，最终提交应与该指纹一致。

## 用户本机验证（不要在 Arena 执行）

1. 使用本分支最终提交，先 `npm ci`（或现有锁文件一致的依赖）、`npm run check:worker`、`npx tsc --noEmit`、`npm run build`。备份并测试真实 v14/v16/其他遗留容器，特别是带 r=8192、WP、旧 v19 不带 0x400 的文件；失败即停止。
2. 在项目根目录运行 `UCZ_THREADS=16 bash scripts/diag/p13/local-validate.sh all /absolute/path/to/Silesia`。脚本按文件顺序运行，保存原始 JSON、stderr、源码 SHA 和环境，且逐文件以锁定的 P14.1 bestUcz 严格检查；不要仅报告总和。该旧包装最后还运行历史 P13 timing/40M 检查，失败不能自动等同于逐文件或往返失败，查看各项原始输出。
3. 对本地 AITDCC 的 16 个明确文件分别使用 `UCZ_THREADS=16 node scripts/diag/run.mjs bench-one /absolute/path/to/file --no-single --no-bench --verbose-segs`，保留每份 JSON、stderr、输入 size/SHA、运行源码 SHA、总耗时及环境，与用户已有 16 文件基线逐文件比较。仓库没有本次用户 AITDCC 的 16 项基线或文件清单，不能在此伪造 16/16 验收。任何往返/SHA 失败或 1 B 回退均阻止推广。
4. 仅在上述完整验证后计算实际总量、Mozilla 总时间与每文件变化；严格 `<40,058,000` 需从基线再降 17,424 B，严格 `<40,000,000` 需再降 75,424 B。历史 P13 checker 的 2137.2s 基准和用户另报 2137.5s 不可混用。
