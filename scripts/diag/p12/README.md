# P12 短切片审计复现

生产参考 `a3b6c3d`。所有变体只在诊断bundle或脚本内实现，不改 `src/`。四个审计单元不是四个真实调度的模型Subagent。

## 数据与原始收据

- `../p12-results/slices.json`：30个固定连续窗口的偏移、长度、源文件/窗口SHA、GitHub来源blob、PE/ECOFF节区元数据。
- `../p12-results/agent1..4/`：158份原始短进程收据，151次codec往返、7次只读统计；每个原始输入64–256KiB。统计记录不算压缩往返。
- `tool-sources/`：每份收据引用的诊断工具按内容hash保存。编译期若改coder副本，另记编译前后hash及具体补丁版本。
- `validation/replay-xml-mid-pool-repack-v1.json`：增加可重复运行命名空间后的独立256KiB复现，完整UCZ 4,930B、SHA与原始记录一致。
- 原始语料、切片、bundle、临时复现输出均ignored；不把它们加进Git。

在项目根目录恢复数据（下载/校验不等于全文件编码）：

```sh
npm ci
node scripts/diag/fetch-corpus.mjs xml dickens ooffice mr osdb x-ray sao reymont nci samba webster mozilla
python3 scripts/diag/p12/prepare-slices.py
```

prepare严格验证标准原文SHA。manifest可以追加新窗口，但已存在条目不可改变；没有压缩调用。

## 单case硬限时与不覆盖复现

原命令不指定tag时写入已归档目录，**已存在文件会拒绝覆盖**。复现使用一个新的 `P12_RUN_TAG`；输出到 `.diag-state/p12/replays/<tag>/<agent>/`。tag只允许字母/数字/短横线，每次再次复现用新tag，无需删除原始证据。

```sh
P12_RUN_TAG=check-01 timeout --signal=KILL 19s node scripts/diag/p12/run.mjs agent1 mozilla-code gap-distance
P12_RUN_TAG=check-01 timeout --signal=KILL 19s node scripts/diag/p12/run.mjs agent2 mr-mid med16
P12_RUN_TAG=check-01 timeout --signal=KILL 19s node scripts/diag/p12/run.mjs agent3 ooffice-code bcj-jcc
P12_RUN_TAG=check-01 timeout --signal=KILL 19s node scripts/diag/p12/run.mjs agent4 xml-mid pool-repack-v1
```

每条命令是**一个**输入窗口、一个变体、一个全新进程，不是批量长测。runner将编码子进程预算设为17.5s减去已经用掉的构建/准备时间，超时SIGKILL；外层19s同时保护构建阶段。可选最后参数65536/131072等限制原始前缀，但仍须>=64KiB且<=既定窗口长度。sao原生窗口262,136B用于28B记录对齐。

不要运行旧 `probe-wordpre*` / `probe-moz-groups` 的默认全文件/大切片入口，也不要用 `npm test` 代替P12证据核验。P12没有授权全codec或>=1MiB多文件编码实验。

## 结果口径

- Agent1：raw-CM，字节差、预测bit差、相关性分开；相关性不是可加的特征收益。
- Agent2：TG组头计入；新字段mask/拆流长度单列；真16bit MED尚未有生产变换ID。
- Agent3：已知架构节区的实际编码；已有TG的局部优势不等于当前基线漏掉的增量。
- Agent4：v1/整词/有效词表候选包含生产单组UCZ头且用生产decoder验证；v2仅为研究封装，未接生产codec。不要把两者的 `bytes` 直接当同口径完整容器。
- `top5.json` 是**算术推算，不是benchmark**。只按两位置观察到的字节节约率套到明确声明的覆盖范围；不是置信区间、上界或收益承诺，不可跨候选相加。

## 只读验证/现有容器目录

```sh
python3 scripts/diag/p12/verify.py
node scripts/diag/p12/check-container-inspector.mjs
node --test tests/p10-baseline.test.mjs
node scripts/diag/p12/inspect-container.mjs /path/to/existing/mozilla.ucz --baseline mozilla > mozilla-p111-groups.json
```

前三条分别检查证据/输入/源码/工具hash、已有小容器的头解析、基线元数据；**不调用压缩器**。verify只读输入/原收据，重建派生 `top5.json` / `verification.json`；不伪称独立重跑全部codec。

最后一条不编码、不解码，只读**已有**容器头并给出真实组/成员/offset。没有该容器就明确缺证据，不启动全文件压缩来补齐。现有P11.1大小报告仍不能替代目录。
