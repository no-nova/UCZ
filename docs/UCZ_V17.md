# UCZ v17：显式模型配置与按实际载荷写头

> 历史格式说明：P10 已改用独立的 **v18** 位定义与分组尺寸策略，详见 [UCZ_V18.md](UCZ_V18.md)。本文保留 v17 的旧意义，不描述当前编码默认。

## 兼容性原则

改变概率模型不能继续冒充旧 v15。v1–v15 固定读取 P7 的模型语义；原有 v17 的四个配置位也不重新解释。新策略使用此前保留的两个配置位，不占 `Spec.r=0x2000`（合法行宽 8192）。

```
55 43 5a 11 <modelFlags:u8> <rawLen:varint> <segmentCount:varint>
<groupCount:varint> <原有规则字典 / 段长 / 分组位图 / 载荷>
```

`11` 是十六进制，即版本 17。仅在实际选中的载荷需要非 P7 语义时写 v17 和这一字节。否则仍写适用的 v7–v15；有 v15 内核时写 v15。

## 配置位

| 位 | 含义 |
|---|---|
| `0x01` | CM 表上限 22；否则 21 |
| `0x02` | **所有 text** 禁用 a2；否则保留 P7 的 raw-text 行为 |
| `0x04` | 匹配表上限 21；作用范围见 `0x20`；否则 20 |
| `0x08` | res 禁用 a2；原有按规则抑制的约束继续生效 |
| `0x10` | **仅 WORD-PRE text** 禁用 a2；非词元 text 不受影响 |
| `0x20` | 新的大流策略：CM 流长度 ≥512 KiB 才允许 `0x01`/`0x04` 扩表；且 `0x04` **只扩 mht8**，mht4 保持上限 20 |
| `0xc0` | 保留，必须为 0；解码拒绝 |

**没有 `0x20` 时**，`0x01` 与 `0x04` 完全保留原 v17 的全局含义：按原长度公式分配 CM 表，mht4/mht8 都可取上限 21。旧文件不会被新默认的 512 KiB 门槛或 mht8-only 策略改变。

`0x02` 优先于 `0x10`：显式 `a2Tuning.textOn=false` 仍关闭全部 text。默认是 `textOn=true, wordPreTextOff=true`。`Spec.r & 0x4000` 继续标记 WORD-PRE，编码/解码均把它传到模型的 `wordTokens`；只在相应 v17 配置启用时抑制 a2。

### 阈值的精确定义

512 KiB 指**送入某个实际 CM 模型的字节数**，不是整文件长度或该规则覆盖的原始字节数：

- 普通共享 CM 组：合并后的变换流长度。
- WORD-PRE：字典头加词元流长度，由现有 4 字节长度前缀确定。
- 转置/剥离/锚点：各实际 CM 子流的长度。

同一容器内可同时有小流与大流。解码端已知这些长度，以相同公式重建表，不额外写每组尺寸标记。新策略下大流为 CM≤22、mht8≤21、mht4≤20；小流仍为 CM≤21、匹配≤20。

## 写入：追踪被选中的语义，而不是看全局旋钮

`Model.requiredFlags` 只记录该流实际采用的扩表或 a2 改变。`payload-model.ts` 的编码侧弱映射随实际序列化的子载荷传递；ByteWriter、WORD-PRE 前缀、MICRO、转置和剥离封装都保留它。worker 通过显式数字字段传回 flags，主线程恢复标记。

`planHeader` 仅对**最终选中的组载荷**做 flags 并集：

- 全局配置为 22/21，但实际流未扩表：不因此写 v17。
- BIN、O0、res2d 或已被规则抑制 a2 的行预测：不因 `textOn=false` 或“有 v15 组”多写一字节。
- WORD-PRE 或大表候选被丢弃：它们的 flags 不污染胜出载荷。
- 实际使用大表、WORD-PRE-only textOff 或全局 textOff/resOff：必须写明 v17，不能为复现旧字节数谎写 v15。

`encodingModelFlags()` 是配置校验/缓存身份，不是最终文件头。未定义表宽或 raw-model 强制覆盖在容器编码入口报错。

## 旧格式与作用域

- v1–v15：CM≤21、匹配≤20、text/res a2 开；保留已有的 D16/WIDE_GRAD、res2d、转置内层等抑制规则。WORD-PRE 不采用新增的默认抑制。
- v16：只保留旧试验的固定组合，CM≤22、匹配≤20、全局 textOff、resOn；不应用新门槛。
- 原 v17（flags 0–15）：含义逐位不变。
- 解码只从容器建立 `ContainerModel`，不受当前编码侧 `modelTuning`、`a2Tuning` 或 raw-model override 影响。异常及嵌套解码用 `finally` 恢复。
- P7 读取器拒绝 v17；早期 v17 读取器拒绝新增的保留位，不会静默误解新策略。

早期未标记 textOff 的 v15，以及任意非固定组合的实验 v16，仍不能仅凭版本猜测恢复；这不涉及真正 P7 文件。

## 验证与并行

- `tests/p7-v15-fixtures.json` 来自真实 P7 `cb99b15`，不是新实现自生成替代物。
- `tests/legacy-wordpre-fixtures.json` 在改动前从 `f2de6fb` 冻结，覆盖 v15 WORD-PRE/a2-on 和原 v17 全局 textOff。
- 格式测试覆盖旧 16 种配置、旧表宽差异、同容器大小流混合、mht4/mht8 的真实分配、r=8192、异常/嵌套恢复、真 worker。
- 默认策略测试覆盖 selective a2、丢弃候选不污染 flags、孤儿严格界限/真实回退、真实头成本、macro 直接提案及 worker 的 WORD-PRE flags。
- `npm run check:worker` 校验生成文件；完整 `npm run test:codec` 同时运行上述测试和原 codec/worker 套件。
- 非默认动态旋钮仍明确走串行。默认内存预算改为每 worker 256 MiB，以容纳 144 MiB 的大上下文表等；显式 `UCZ_THREADS` 仍覆盖默认并发。

本页说明格式正确性，不是新默认组合的 Silesia 体积/速度验收。当前交付状态见 [P9_DEFAULTS.md](P9_DEFAULTS.md)。
