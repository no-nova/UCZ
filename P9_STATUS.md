# P9 — 当前交付与检查点

> P9已完成，后续本地结果已收到。当前阶段为 [P10_STATUS.md](P10_STATUS.md)，本页保留P9历史交付口径。

## 当前交付

按用户最新决定直接落实 P9 默认值与正确性修正；**本轮不再跑旧的沙箱长测矩阵**。12 个完整 Silesia 文件由用户本地验收。用户明确允许一次完整 codec 单元套件，包含既有较大合成夹具；其它仅小型检查。

- 活动分支固定 `arena/1220f47e-test`，之前完整阶段已交付 `f2de6fb`。
- 新策略/实现边界及本地命令：[docs/P9_DEFAULTS.md](docs/P9_DEFAULTS.md)。
- 格式/兼容性：[docs/UCZ_V17.md](docs/UCZ_V17.md)。
- 用户 f2de6fb 本地 12 文件报告：43,041,893 B；原 JSON 未上传，只作为用户报告，不冒充本轮验证：[LOCAL_F2DE6FB.md](docs/audits/LOCAL_F2DE6FB.md)。

## 已实现

- 由实际选中载荷决定 v17 flags；无关 a2、未使用的大表、被丢弃的候选不多写配置字节。
- raw-text a2 默认开；WORD-PRE-only 默认关；显式 textOn=false 仍是全局覆盖。
- 实际 CM 流 ≥512 KiB 默认 CM≤22 / mht8≤21；mht4≤20。新增 flags 0x10/0x20，旧 v1–15、v16、原 v17 语义保留。
- singlePlain=true；TG candidates=false；3a=true、3b=false。
- 孤儿含 STORE/RLE/O0、排除 FILL，严格 <2 MiB 且 <20%，最多24个。完整重编码的载荷和完整容器均严格变小才接受，不用前缀外推。
- macro=true；多组且 ≤25 MiB 或 text 主导，直接试主导规则；大二进制保留筛选。最终严格比较容器，不接受相等或更大。
- 真实头部字节计费；floor8192、≤4段中的每个≥1MiB段用65536；串并行预算一致。
- 重建 worker；显式跨线程传输载荷 flags；新增 check:worker；bench-one 保存实际 flags/配置/结构比较/源码身份。

## 本次门禁状态

当前源码指纹 `2979a4956e72487bd5c5a9f88f8ae2f6756163c4b62fe3dcf9f21d5d7e9fb878`，实现 `6b86000`。

- worker/tsc/build 门禁已 PASS，分别推送 `cb7ecc1` / `bf4c851` / `7c97771`。
- 完整 codec 第一次尝试在 63,605 ms 提前失败：旧 MICRO 用例要求默认选择已被 3a 剔除的候选。格式72、宏14、默认策略14均已通过；不能把此次整体记为 PASS。失败收据保留 `gates/codec-p9-defaults.{json,log}`（`ed3f54e`）。
- 已将8个有明确历史赢家要求的 selector 夹具改为显式旧选择配置；保留全部断言。一般往返、新默认策略及两组串并行集成仍用新默认。生产代码未变。修正后完整 `npm run test:codec` 已 PASS：165,245 ms，收据 `gates/codec-p9-defaults-complete.{json,log}`（`7416ae7`），原 codec 主体与独立 worker 脚本均已结束成功。四项门禁均 sourceUnchanged=true、无超时。

- 完整套件包含格式72、宏14、默认策略14；另有恢复11、摘要3通过，以及19个解码函数体的历史比对。
- 合成 CLI 4192→125 B，v7/flags0，往返及源码校验成功；4 B 头部陷阱的17 B候选和16 B相等候选均被拒绝。不是 Silesia 收益数据。
- 交付清单：[defaults-delivery.json](scripts/diag/p9-results/checks/defaults-delivery.json)。源码与日志哈希、测试树身份已核验；详细门禁和小型字节表见交接文档。

尚未在 Arena 运行本次新默认的整集性能验收。尚未声明相对旧 P7/f2de6fb 全部无回退，也未声明 200–400 KB 或30%目标完成。

## 历史与续接

旧恢复记录、旧已完成门禁、osdb/mozilla 原始结果及被取代的实验排程完整保存在 [P9_STATUS_F2DE6FB.md](docs/audits/P9_STATUS_F2DE6FB.md)。旧宏门阶段全部完成，不要重跑或当作当前待办。

本次生产门禁已经完成，无仍在运行的 codec 进程。后续以四份本次 PASS 收据和保留的失败收据区分状态，不重复启动已完成的整套测试。下一步为用户本地12文件验收；不要继续旧的 2/4 MiB 或全文件沙箱矩阵。
