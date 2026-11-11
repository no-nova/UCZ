# P11 — 实现与四项门禁完成

> 历史P11交付记录（147b778），以下策略/“尚无本机结果”描述的是当时状态。后续用户本机报告41,813,622 B、9项过线/3项回退，见[docs/audits/LOCAL_147B778.md](docs/audits/LOCAL_147B778.md)；当前P11.1改为固定mht4=20、低档v18、显式高档策略，见[docs/P11_1_HANDOFF.md](docs/P11_1_HANDOFF.md)。旧门禁证据未覆盖。

- 起点d4bf4d8；用户本地P10总量42,038,648 B/12 PASS，原始JSON未上传，见docs/audits/LOCAL_D4BF4D8.md。
- 本轮基线锁定为该12项实测值，逐文件1 B也不放行。
- 采用独立UCZ v19：v18的0x08已用于匹配表，不重解释；v19用明确的扩展配置头。
- 已实现默认24位、>=8 MiB档，mht4按21/22/22扩容；显式同步probe作用域强制<=21/20；孤儿上限64，仍单批与完整容器严格兜底。
- 检查可证明重复的完整base/候选；仅“宏必定尝试”不能证明孤儿必输，不按猜测删除可能获胜的中间候选。
- 新增测试输入不超过256 KiB，不下载/运行语料。最后另执行请求的完整既有codec套件及worker/tsc/build门禁。
- v19使用uint16 LE配置；新增0x100 CM24、0x200 match23；不重解释v18。默认内存预算1024 MiB/worker，显式UCZ_THREADS保留。
- 同族归一的完整统一base即使被拒绝也保留；后续孤儿/宏精确命中复用。已有base的组可只把alt/WP交给worker。新增实际命中/候选-only任务计数及--no-reuse-guard-bases受控对照。
- 新增P11九项小检查PASS，实际输入<=32 KiB；128 B raw-CM实际分配24/22/23位并对称解码。32 KiB拒绝归一用例完整base调用3→2、容器相同28748 B；宏仅赢1 B也保留严格语义。
- 新增反例：同一32 KiB人工计划中，孤儿22641 B、必试且不变的宏26427 B。盲删孤儿会损失3786 B，故不做这种无依据跳过。
- 更新后的P10小检查12项、P9默认14项及基线元数据8项已通过；一次旧默认测试因配置头由1→2字节的期待值未更新而失败，已按真实头成本修正并通过，未删断言。
- 四项最终门禁真实PASS：worker 246 ms；完整codec（含独立worker和8项基线检查）262933 ms；tsc 4209 ms；build 2649 ms。本轮完整套件一次通过，每项已分别保存并推送。
- 源码检查点5d51696；源码指纹5227170a7cd2a9f8070fca63454d68fb28510641e68daa2ef7dfbed89c238b74；测试树beb2deeb23e6c67dfc2beda4cd6c3065062a7d2e。收据、日志、小型JSON与测试身份由scripts/diag/p11-results/checks/delivery.json绑定。
- 交付和本机命令见[docs/P11_HANDOFF.md](docs/P11_HANDOFF.md)，格式见[docs/UCZ_V19.md](docs/UCZ_V19.md)。尚无P11整集压缩或提速测量，待用户本机12文件验收。
