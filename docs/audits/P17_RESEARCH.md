# P17.0 — 基于 28 文件体检数据的第一性原理攻关

本阶段的结论**以实测为准**，不以假设为准。下面三条主线里，有一条被证伪，
一条被证明真实但**无法以可接受的代价落地**，一条只做到归因。

沙盒红线全程遵守：所有输入 ≤ 262,144 B，所有命令 `timeout --signal=KILL 19s`。
**AITDCC 的 I / N / F / G / O 在沙盒中不存在**（`.diag-data/corpus/` 只有 11 个
Silesia 文件，`x-ray` 与 `xml` 的原始文件也缺失），因此这四个文件的任何结论
**本轮都未经验证**；下文凡是涉及它们的，都是对你给出的体检数据的推理，不是测量。

---

## 1. 方向 A（低位噪声 / 半字节掩码上下文）：**证伪**

### 1.1 命题

> `H(lo) ≈ 3.997`、`H2(nib) ≈ 2.4` 的数据里，低半字节是量化热噪声，
> 它会稀释高半字节信号，所以应当把低位从上下文里掩掉。

### 1.2 直接检验（不实现任何东西就能判定）

同一批数据、同一个预测目标（下一个完整字节），只把上下文里的低半字节清零：

| 文件 | 上下文 | 真实字节 H | **低位掩码** H | 掩码的代价 |
|---|---|---|---|---|
| x-ray-mid | k=2 | 2.9140 | 5.1639 | **+2.25 bits/byte** |
| x-ray-mid | k=4 | 0.2933 | 4.8887 | **+4.60** |
| sao-mid | k=3 | 0.9816 | 4.0658 | **+3.08** |
| osdb-mid | k=3 | 0.7142 | 4.1827 | **+3.47** |
| dickens-mid | k=3 | 2.0023 | 3.8258 | **+1.82** |

`k` 越大差距越大——因为低半字节**不是噪声，而是整条记录链的一部分**。
`x-ray` 的 `d=2` 上 `MI=2.8531`、`eqRate=0.4663`，说明相邻两个 16-bit 样本
**高度相关**，低半字节是那个相关的载体之一。把它掩掉等于主动丢掉
每字节 2–4.6 bit 的信息。

### 1.3 命题误读的根源

体检表里的 `H(hi) < H(lo)` 说的是**边际**熵：低半字节的**边际**分布接近均匀。
但条件熵关心的是**条件**分布，而低半字节在给定高半字节与前文之后
**高度可预测**。用边际熵判断"该不该进上下文"是范畴错误。

### 1.4 真正该做的（同一份数据的正确读法）

第二步实验：既然 `d=2 / d=4` 的互信息很大，正确的动作不是掩低位，而是
**利用步长本身**。这一点管线**已经在做**：`sao` 全文件选 `TRANSPOSE-G3`，
`samba` 选 `SUB-TRANSPOSE s=38`，`mr` 选 `GRAD-2D3`；我在 262 KiB 切片上复核
`sao-mid` 仍稳定选出 `id30/s=28`、`mr-mid` 选出 `id26/s=2/r=1024`——
与 28 文件体检的步长峰一致。**方向 A 不需要新机制，现有转置族已经覆盖。**

> 结论：方向 A 关闭。任何"nibble-masked context mode"都会让体积**变差**，
> 与用户"零回退"铁律直接冲突。收据：`p17-results/exp2-nibble-mask-falsified.txt`。

---

## 2. 方向 B（窄字母表中长距 5~7 字节匹配盲区）：**机制真实，但无法廉价落地**

### 2.1 审计：匹配模型到底漏了什么

`coder.ts` 的匹配模型有两条腿：

- `mht4`（20–24 bit，**单槽位**）：`mht[h] = pos` 直接覆盖。同一个 4-gram
  第二次出现时，第一次的位置就被冲掉了。**这是每个单槽匹配表的结构性盲点**，
  与字母表宽窄无关，窄字母表只是让它更频繁。
- `mht8`（8 字节上下文）：碰撞少，但**必须已经匹配满 8 字节**才可能命中第 9 字节。
  长度 5、6、7 的重复段永远够不着它。

`I` 的 `meanLen = 4.42` 意味着绝大多数重复段**恰好落在 4 和 8 之间**——
这正是两条腿之间的缝。这个归因是**对的**。

### 2.2 实测：补上第二条腿确实有效

把"上一代"4-gram 槽位（`mhtOlder`，仓库里早就有，只是生产路径从未启用）与
按距离切分的匹配状态表（`msm` 从 32 槽扩到 32×5）打开，在 262,144 B
切片上对 `v20` 单流测量：

| 文件 | single（现状） | dual-distance | **Δ** |
|---|---|---|---|
| dickens-mid | 73,827 | 73,646 | **−181** |
| mozilla-mid | 81,402 | 81,174 | **−228** |
| ooffice-mid | 111,333 | 111,085 | **−248** |
| samba-c | 33,921 | 33,763 | **−158** |
| nci-mid | 13,998 | 13,917 | **−81** |
| xml-mid | 6,169 | 5,986 | **−183 (−2.97 %)** |
| **mr-mid** | 64,035 | 64,042 | **+7** ← 唯一负向 |
| 合计 12 个切片 | — | — | **−1,360 B，11/12 胜** |

再叠加上一代槽位（`dual-distance + older`）：**14/15 胜，合计 −1,702 B**，
并且**把唯一的负向 `mr-mid` 从 +14 修成 −172 之外的净正**（`x-ray` 由 +3 转 −7，
`sao` 由 −2 转 −28，`nci` 由 +9 转 −91）。

### 2.3 负控：**零风险**

| 负控输入 | Δ |
|---|---|
| iid 均匀字节（262,144 B） | **0 B** |
| iid 五符号字母表 | −1 B |
| 常量填充 | **0 B** |
| 每个 4-gram 唯一（构造） | **0 B** |

机制上也可预期：没有重复结构时 `mhtOlder` 永远不命中、距离桶只有 0 号被用到，
所以模型演化与现状**逐位相同**。这不是"运气好"，是结构性的。

### 2.4 为什么**没有**实装：没有廉价的采纳门

要在生产里用它，必须让解码端知道该用哪种表——这需要一个容器位（我实现过
v22，见 §2.5）。而"用不用"必须由一个**便宜**的判据决定，否则就是无条件 2× 开销。

我试了三个判据，**全部失败**：

1. **整个计划重编码再比完整容器**（`refineRec2`/`refineBitplane` 的形状）。
   实测 12 个切片：**采纳 0/12**。原因是计划本身由 v21 上下文选过一遍，
   重编码丢失了上下文元数据，结果稳定更差（`mozilla-mid` 候选比基线大 1,057 B）。
   同时开销是 **2×**：`sao-mid` 335 s vs 基线 53 s。
   → 直接违反"无零收益时间消耗"铁律。
2. **单流 A/B 后按比例外推**。不可靠：同一份数据 `bin` / `text` /
   `bin-stride4` / `text-sparse5` 四种配置的收益差 3–6 倍
   （`ooffice-mid`：bin −248、text −145、binV21 −201、textV21 −196），
   而管线是混合编解码的，外推没有依据。
3. **结构预测量**（4-gram 的多距离占比 / 平均距离桶数）。**反相关**：

   | 文件 | 多距离占比 | 平均桶数 | 实际 Δ |
   |---|---|---|---|
   | mr-mid | **0.6066**（最高） | 1.615 | **+16（唯一负向）** |
   | x-ray-mid | **0.0669**（最低） | 1.071 | **−7（正向）** |
   | nci-mid | 0.6873 | 1.815 | −91 |

   多样性最高的文件反而变差。这个量**不是**收益的预测子。

> 结论：机制真实、负控干净，但**当前架构里没有既能保住收益、又不付 2× 时间的门**。
> 用户明确要求"不要把不可控模块一次改太多"与"无零收益时间消耗"，
> 因此本轮**不落地**，把它作为已测量、已定界的下一步候选记录下来。

### 2.5 已实现的容器基础（已回退，但设计已验证）

实现过一版 v22：`V22_FLAG_MATCH_DISTANCE = 0x8000`（容器级 uint16 位，
与 v21 的 `0x4000` 不冲突），`withContainerModel(22, …)` 映射到
`containerModel.matchDistance`，**写端由 `cmV22Tuning` 开关驱动、读端只由容器位驱动**。
验证结果：v22 载荷在 v22 模型下往返**逐字节正确**；v21 流在 v21 模型下
**字节不变**。也就是说容器机制本身是通的，缺的只是 §2.4 的门。
代码已 `git checkout` 回退（`src/lib/coder.ts`、`src/lib/codec.ts` 与 `3145a0f` 一致）。

---

## 3. 方向 C（Silesia `< 40,000,000 B` 的 −38,910 B 缺口）：**归因，未攻克**

12 个文件的 `ucz` 合计（按你给的 `/tmp/p4/*.json` 相加）**恰好 40,038,909 B**，
缺口 **38,910 B = 0.097 %**。

### 3.1 缺口在哪里（按可压缩空间排序）

| 文件 | ucz | 占比 | 当前规则 | 结构性观察 |
|---|---|---|---|---|
| webster | 6,259,837 | **15.6 %** | 单段 `CM-TEXT3 [text-sparse5]` | 单段纯文本，**没有任何结构决策可赢**，只能靠模型 |
| x-ray | 3,548,450 | 8.9 % | 单段 `WIDE-16`（v20） | 走 `res`/`res2d` 行预测器，**匹配模型不参与** |
| samba | 3,342,038 | 8.3 % | 1923 段 `CM-TEXT3 [text-sparse5]` | 宏组已采纳（`id23`），碎片 1933 段 |
| sao | 3,132,317 | 7.8 % | 单段 `TRANSPOSE-G3` | 步长已抓对 |
| mozilla | 13,012,165 | **32.5 %** | 5453 段，见下 | **唯一有明确非对称的地方** |
| 其余 7 个 | 10,743,102 | 26.8 % | 多为单段 CM | — |

两点判断：

- **webster + dickens + nci（合计 9.69 MB，24 %）都是单段纯文本 CM**。
  它们没有"段/规则"层面的空间，只有模型层面。要在这里拿 0.097 %，
  等价于把文本 CM 提升 0.4 %——这不是 P17 能顺手完成的量级。
- **x-ray 的 `WIDE-16` 不经过匹配模型**，所以 §2 的收益对它**结构性为零**。

### 3.2 mozilla：一个可证伪的具体假设（未验证）

mozilla 里 `CM-BIN3 [bin-stride4]` 覆盖 4,137 段 / 37.0 MB（72.3 % raw），
另有 81 个 `TRANSPOSE-G3` 段（6.8 MB）。关键在于**表规模是按单个分组**决定的，
不是按整文件：

```
coder.ts geometry():
  a = (t > 0 && largeOnly && groupSizing && !probeDepth) ? inputBytes : leakedBytes
  tier = a >= 8MiB ? 24 : a >= 4MiB ? 23 : a >= 512KiB ? 22 : 21
```

`groupSizing` 是 `version >= 18`，所以**每个分组的表规模由该分组自己的长度决定**。
mozilla 的计划被切成 5453 段，其中多数分组的长度不足以拿到 23/24 bit 的表。
若某段的 4-gram 确实在**更早的、不属于该段的字节**里出现过，那些位置对该段
不可见——这与 `I` 的 `repeatOff = 59.1 %` 是同一类损失，只是 mozilla 走的是
"分段切断了表规模与历史"这条路径。

**注意这仍是一个假设，不是结论。** 沙盒无法载入 mozilla 全文件，也能看到
`inputBytes` 与 `sizingBytes` 在 `groupSizing` 下的差异不是简单相加关系。
要证实它，需要在你本机对单个分组打印 `geometry()` 的 `a` / `tier` / `cmBits`，
并与"假设该分组长度为全文件长度"时的压缩结果对比。

### 3.3 明确的排除

- **不是** `refineWholeGroupProfile`（P16.3 已整段删除，且它在 samba/ooffice 形态
  上第一行就早退）。
- **不是** 宏组门：samba 与 xml 的宏组已被采纳，`ooffice`/`reymont` 是
  正确拒绝（提议的统一规则实测更差）。
- **不是** 位平面：`BITPLANE` 只在 `L` 这类字节级 CM 全灭的流上触发，
  Silesia 12 个文件没有一个满足触发条件（H0 最高 `sao` 7.2499 < 7.5）。

---

## 4. 本轮的可复现收据

| 收据 | 内容 |
|---|---|
| `scripts/diag/p17-results/exp1-match-distance-positive-null.txt` | 12 切片正例（11/12 胜，−1,360 B）+ 4 组负控（0 B） |
| `scripts/diag/p17-results/exp2-nibble-mask-falsified.txt` | 4 文件 × 4 阶上下文的低位掩码代价（+1.8 ~ +4.6 bits/byte）+ 同 H0 负控 |

复现方式（任意 ≤256 KiB 切片）：

```bash
node scripts/diag/inspect-structure.mjs <file>        # 体检
```

## 5. 本检查点的验证状态

- `npx tsc --noEmit`：通过
- `npm run check:worker`：通过（`parallel-worker-code.ts` 最新）
- `npm run test:ui`：**14/14**
- `npm run build`：通过（`dist/index.html` 458.49 kB / gzip 150.30 kB）
- `node scripts/diag/p16/verify.mjs`：**PASS**（118 收据，100 通过 / 18 失败——
  与 `0912a8f` 的既有基线一致，本轮未新增失败）
- `npm run test:codec`：**EXIT=0**（8+7+7 pass，0 fail，0 assertion error）

## 6. **未证明的事**（必须明说）

1. **AITDCC 的 I / N / F / G / O 完全没有验证**——沙盒里没有这些文件。
   §2 的收益是在 Silesia 切片上测的；`I` 的 `meanLen = 4.42` 与 Silesia 文本
   切片（`dickens` 的匹配结构）不同，**不能把 −0.245 % 直接搬到 `I` 上**。
   要判定能否反超 `zstd-18` 的那 632 B，需要在你本机跑。
2. **mozilla 的表规模假设未验证**（§3.2），只是唯一自洽的机制猜测。
3. **Silesia 全量字节数本轮没有任何新测量**；40,038,909 B 是你提供的数字。
4. §2 的机制**没有实装**，所以对当前 `ucz` 数字的影响是 **0 B**。

---

# P17.1 — `matchDist` 实装（并入逐组候选精化）

P17.0 的 §2 证明了"第二条腿"（窄字母表长距 5~7 字节匹配）机制真实
（11/12 胜、−1,360 B、4 组负控 0 B），但把 `matchDist` 装在**全计划尾部重编码**上，
于是 `refineMatchModel` 覆盖了 `refineContextCandidates()` 已经选好的 `group.context`，
`sao` 的 28 列 `TRANSPOSE-G3` 搜索与 `mr` 的 `GRAD-2D3` 也整体重跑，
结果 **0/12 采纳 + 2 倍时间**。P17.1 把它改成**逐组正交轴**。

## 1.1 设计

`matchDist` 不是一个新的 context mode，而是与 context **正交的第二根轴**：

| 部件 | 位置 | 作用 |
|---|---|---|
| `CMOptions.matchDist` | `context-policy.ts` | 激活 v20 内核的第二条距离表 |
| `GROUP_MATCH_DIST_BIT = 0x100000` | `context-policy.ts` | 组头 `r` 字段第 20 位 |
| `V22_FLAG_MATCH_DISTANCE = 0x8000` | `coder.ts` | 容器/载荷格式标志 |
| `matchDistProfileAllowed(id, context)` | `codec.ts` | 唯一资格判定入口 |

资格由**底层 CM profile** 决定，而不是由变换 id 决定：
`text`/`bin` 可用（`TEXT/TEXT2/TEXT3 = 4,18,23`、`BIN/BIN2/BIN3 = 5,19,24`、
`TRANSPOSE_GROUP_V3 = 30`，以及 `6,27,22,26` 被切到 `xform-bin`/
`xform-bin-stride4` 时）；原生 `res`/`res2d`（`GRAD-2D3 = 26`、`WIDE-16 = 31`）
**在源头排除**——这正是 `mr-mid` 的 +7 B 负例，不是 LZ 现象而是 MED 残差
聚在 `0/±1` 造成 4-gram 随机碰撞。

零额外全组编码：屏幕（192 KiB）在**同一次** pass 里多评估
`(mode=0, +matchDist)` 与 `(winning mode, +matchDist)`，然后仍然只有
**一次**全组编码。`lateMatchDist` 保证 `matchDist` 不参与**规划期**探针，
否则 `xml-mid` 会被推去 `SUB_ANCHOR/GRAD` 方案（+1,700 B 级退步）。

## 1.2 实现中修掉的四个真 bug（都不是参数调节）

1. **`!wordPre` 资格判定把整个文本通道排除了。** `TEXT_V2/V3` 恒走 WORD-PRE，
   所以按"是否 WORD-PRE"判定等于把 `dickens`/`samba`/`webster` 全部挡在门外。
   判定必须落在 **CM profile**（即 `matchDistProfileAllowed`），而 WORD-PRE 内部
   解码到的是同一个 `text` CM，`options` 一路传得进去。
2. **`planHeader` 的逐组校验用的是"该组自己的 flag 是否含 `V22_FLAG_MATCH_DISTANCE`"。**
   这个标志只在容器聚合时才 OR 上去，逐组永远不含 ⇒ `xml-mid` 的 `wp-merge`+md
   组恒被判非法，`xml` 卡在 `v13 6274 B`。校验必须看 `g.matchDist` 本身。
3. **解码端比编码端更严，形成非对称拒绝。** 编码端放宽了 `wordPre`，解码端的
   `decodeTerrainGroup` 头部校验仍要求 `!wordPre` ⇒ `xml-mid` 报
   `v22 组匹配模型标记与规则不兼容`。两端的接受集必须逐字一致。
4. **`c[4]|c[5]<<8 & 0x8000` 的运算符优先级。** `<<` 比 `&` 结合紧，实际测的是
   错误的位。必须写 `(c[4]|(c[5]<<8)) & V22_FLAG_MATCH_DISTANCE`。

另外：`matchDist` 必须是**叠加**在已胜出的 context 之上，而不是替代它。
曾经写成 `{context: pick.context}` 替换 ⇒ `xml` 丢掉 `wp-merge`，`4501 → 6274`。
正确做法是同时产出 `{context: undefined, matchDist}` 与
`{context: pick.context, matchDist}` 两个候选。`actuallyMd`（回读
`payloadModelFlags`）保证"载荷实际没启用模型"的候选不会被误标。

## 1.3 端到端结果

`scripts/diag/p17-results/p17-1-e2e-match-distance.txt`（12 × ≤256 KiB 切片，
A/B 只切 `cmV22Tuning.matchDist`）：

- **12/12 往返一致**，**7 胜 0 退**，总 **−572 B**
- `mozilla −184`、`samba-c −103`、`osdb −90`、`nci −81`、`dickens −47`、
  `xml −41`、`webster −26`
- **`xml-mid`：6274 B（v13）→ 4501 B（v22，`wp-merge`+md），−28.3 %**
- **`mr-mid` 恰好 0 B**，保持 `v21 wide-geom`（原生 `res2d` 在源头排除）
- `dickens` 与 `samba-c` 由 v20 升到 v22，即 `text-sparse5` 卡在 `0.9985` 门槛
  时由 `(mode=0, +matchDist)` 路径成功激活
- 4 组负控（iid-uniform / iid-5-symbol / constant / unique-4gram）**恰好 0 B**

> 负控的第一版曾出现 −98 / −96 B 的假阳性。原因是**harness 自己的生成器错了**
> （`rng(seed + i)` 逐字节重播种，产生的不是噪声而是一条周期性确定序列）。
> 换回 P17.0 用的单一 xorshift 生成器后，四组全部恰好 0 B。这类错误必须记下来：
> 负控一旦"有收益"，先怀疑负控本身。

## 1.4 §3 的悬而未决问题：`inputBytes` 传的是组总长

P17.0 §3.2 假设 mozilla 的 4,137 段 `CM-BIN3` 只有拿到 24 位表才能吃下
`(bin-stride4 + matchDist)`。本轮**审计结论：代码已经是正确的**。

`cmTableShape(n)` 用 `n` 排序，`sizingBytes = largeOnly && groupSizing && !probeDepth
? (groupModelBytes || n) : n`。所有调用 `withCMBlockSize` 的编码点传入的都是
**拼接后的组总长**，没有一个传单段长度：

| 位置 | 传入 |
|---|---|
| `codec.ts:766,774` | `total` / `total` |
| `codec.ts:796,1068` | `lengths.reduce(...)` |
| `codec.ts:1021` | `parts.reduce(...)` |
| `codec.ts:2482` | `joined.data.length` |
| `codec.ts:2552` | `rawBytes` |
| `codec.ts:3798,3802,3807` | `ps.reduce(...)` |
| `codec.ts:3895` | `rawBytes` |

所以 mozilla 的 37.0 MB 组**本来就该拿到 24 位表**；§3.2 里"只差
`(bin-stride4 + matchDist)`、约 25,000 B"的判断不需要任何代码修正就能成立，
只差机制本身——而机制现在是实装的。**无需修改，没有发现误传段长的调用点。**

## 1.5 逐组校验的对称性（防止再次出现非对称拒绝）

编码端 `planHeader` 与解码端组头解析必须接受**同一个集合**：

- 条件只看 `g.matchDist` / 位 20，**不看**该组自己的 `modelFlags`
- 只看 `V20_FLAG_CM` 与 `matchDistProfileAllowed(id, context)`，**不看** `wordPre`
  （WORD-PRE 解包后是同一个 `text` CM）
- 容器级 `V22_FLAG_MATCH_DISTANCE` 仍由聚合阶段 OR 上去，`planHeader` 的
  跳过守卫在 `flags & V22_FLAG_MATCH_DISTANCE` 已置位时不重复校验

版本阶梯：`o & 0x8000 ? 22 : ...`，即只要任一组带 `matchDist`，容器就是 v22；
不带时仍是 v21 及以下，**v21 流一个比特都不变**。

---

# P17.2 — 单段 `matchDist` 往返缺陷（`AITDCC/I`）

`AITDCC/I`（`3,295,751 B`）在 `1ef1761` 上压到 `1,629,116 B`（`v22`，
`modelFlags 36874 = 0x900A`），比 `zstd-18` 的 `1,629,396 B` 少 `280 B`，
**但解压后 3,295,751 B 全错，且不抛任何头部异常**。Silesia 12 个文件全部通过，
只有这一个文件失败。

## 1.1 根因：编码端与解码端是两份手写代码，只有一侧接了新选项

`I` 的计划是 `segs: 1, id: 4 (CM-TEXT), context: undefined, matchDist: true`。
`id 4/5`（`TEXT`/`BIN`，即"旧版身份规则"）**不经过** `decodeTerrainGroupImpl`
末尾那条覆盖 v3/V2 的大分支，而是各自单独一路。P17.1 给单分片编码端接上
`matchDist` 时只改了编码端：

```ts
// 编码端：接上了
if (kernel && (sp.id === ID.O0 || sp.id === ID.TEXT || sp.id === ID.BIN))
  return encodeCM(parts[0], profile, 1, 1, ..., options?.matchDist ? {matchDist:true} : undefined)

// 解码端：没接
} else if (sp.id === ID.O0 || sp.id === ID.TEXT || sp.id === ID.BIN) {
  joined = decodeCM(payload, n, profile, 1, 1, onProgress, isAPMKernel(kernel) ? kernel : false)
}                                                              // ^ 没有 options
```

后果正是"解出正确长度、全部内容错误"：编码用第二张距离表，解码用第一张，
两个模型从第一个比特起就分岔。它不触发头部校验，因为头部标记完全合法。

**为什么以前没暴露**：`id 4/5` 只有在 `segs === 1`、且该组赢得 `matchDist` 时
才走这条路。多分组计划里的文本/二进制组基本都已经是 `TEXT_V3/BIN_V3`（`23/24`），
而 v3 分支是传了 `options` 的。`I` 恰好是单段纯文本，第一次踩中。

## 1.2 修法：让两端只有一个来源

不是给解码端补一个参数了事——那正是产生漂移的方式。改成三处共用两个纯函数：

| 函数 | 作用 |
|---|---|
| `legacyCmProfile(sp)` | `O0/TEXT/BIN → profile`，唯一的 id→profile 映射 |
| `legacyCmOptions(profile, options)` | 只有 `text`/`bin` 才产出 `{matchDist:true}` |
| `tagLegacyCm(payload, profile, options)` | 载荷自带它实际用到的 `V22_FLAG_MATCH_DISTANCE` |

`planHeader` 会拿载荷的 modelFlags 与组的 `matchDist` 元数据对账，探针编码又
不持有容器模型，所以标记必须随载荷走。**三处旧规则分支**（单分片编码、
多分片编码、解码）现在都从这两个函数取值。

同时修掉一个对称的问题：`_V2` 规则（`18/19`）的分支原本**解码端**传了
`options`、**编码端**没传，方向正好相反。同一类缺陷，同样改为共用函数。

## 1.3 验证

- 组级矩阵：`O0/TEXT/BIN/TEXT_V2/BIN_V2/TEXT_V3/BIN_V3` × `{文本, 二进制}` ×
  `{单分片, 双分片}` × `{md 关, md 开}` —— 其中 `matchDist` 部分 **40/40 全部往返一致**
  （修复前 `id 4/5` 在 `md=true` 时全部失败）。
- **零回归**：24 个 `md=false` 配置在 `1ef1761` 与修复后的载荷 **SHA-256 逐字节相同**
  （含 `id 18/19` 单分片那个既有的、与本缺陷无关的不对称结果，也原样保留）。
- 端到端 12 切片与 P17.1 交付数字**完全一致**（`773,804 B`，7 胜 0 退），
  因为本次修复只触及 `id 4/5` 的单段 `matchDist` 路径。
- 回归测试写入 `tests/p10.test.ts`：单段 `id 4/5` × `matchDist` × 单/双分片
  全部断言逐字节往返，并断言 `text/bin` 载荷确实带上 v22 标志。

## 1.4 顺带发现：`id 18/19` 单分片本来就对称性缺失（**未修**）

矩阵测试暴露：`TEXT_V2/BIN_V2` 在**单分片**下即使 `matchDist=false` 也往返失败，
而双分片正常。已确认这个行为在 `1ef1761` 上**完全一样**，与 `matchDist` 无关，
是既有缺陷。生产代码不会给单分片 `18/19` 配这条内核组合，12 个切片与全部单元测试
都不受影响，因此本轮**不改**——它属于另一条独立机制，按"一次只动一个不受控模块"
的原则单独处理。这也是本轮唯一明确记录在案的未修项。

## 1.5 为什么会漏掉这个缺陷（流程教训）

往返校验通过 ≠ 编解码对称。上面第 2 项（模块级热字段缓存）就是同一种陷阱：
两个 `Model` 交错时缓存被后构造的实例覆盖，`base` 读到 `alt` 的权重，
产物错但**自洽**，往返照样"通过"。两次都是靠**比对新旧实现的字节哈希**
才抓到的，不是靠 round-trip。`encodeCMContextDual` 的 `base/alt` 现在固定作为
该项的哨兵用例。

---

# §P17.3 BCJ 上下文接线、转置升级管线、18/19 单分片

## 0. 结论摘要

| 任务 | 结论 | 字节 |
| --- | --- | --- |
| 1 BCJ → v21/v22 | 门禁缺陷**已修**；矩阵 32/32；真实 x86 切片上候选被严格门禁**正确拒绝** | 0 B 变化 |
| 2 转置升级管线 | 三处真实缺陷定位（其中两处是**死代码**）；逐列择优本来正确；修复后实测不赢，**按铁律不采纳** | 0 B 变化 |
| 3 id 18/19 单分片 | P17.2 修复已连带消除，无需新改动 | 0 B 变化 |
| 4 验证 | 12 切片 773,804 B，与 `fd6385a` **逐字节相同** | Δ = 0 |

本轮**没有任何采纳的比特流改动**。Task 1 交付的是门禁修复 + 测试，
Task 2 交付的是审计结论与三个已定位缺陷的处置决定。这符合 P17 系列
「严格更小才替换」的铁律：机制接通了，但在这批数据上它不赢，就不改流。

## 1. Task 1：BCJ / BCJ2 / BCJ3 接入 v21 上下文与 v22 matchDist

### 1.1 简报的前提有一处错

简报说 `BCJ3` 完全被 `matchDistProfileAllowed` 排除。实测**不成立**：
该函数对 `context === undefined` 走 CM profile 判定，而 BCJ 三类跑的就是
`bin` profile，所以 `matchDist` 在编辑前**已经对 11/20/25 生效**（矩阵
32 格里的 16 个 `md=true` 格在改动前就全部往返通过）。

真正的断点是另外两处，都是"列表漏项"：

1. `contextSpecAllowed('bin-stride4', …)` 只认 `BIN/BIN_V2/BIN_V3` 且要求
   `s === 1`。
2. `matchDistProfileAllowed(id, 'bin-stride4')` 落到 TEXT/BIN 数组判定而返回
   `false`，于是即使上下文获批，v22 也进不来。

### 1.2 第三个、也是真正让 ooffice 一分钱没省的缺陷

`ooffice-mid` 的 13 个组**全部**是 `BCJ3(MSB25)`，spec 为
`{id:25, s:2, r:1}`。`s=2` 是保持进位的 MSB 变体（`bcjMsbFwd`，
`transforms.ts` L193），**滤波后长度与 s=1 完全相同、CM profile 也是同一个
`bin`**，只是 E8/E9 操作数约定不同。原谓词要求 `s === 1`，于是：

```
contextProposalsForGroup({id:25, s:2, r:1}) → []
```

没有提案 ⇒ 没有 `contextGroup` 作业 ⇒ `contextComparison.groups` 长度为 0。
「上下文细化为 0 个组」是这条链路的可靠信号：先查提案，不要先查筛选。

### 1.3 第四个缺陷：`bin-stride4` 分支把变换整个跳过了

把 `s=2` 放行之后，提案出现了、筛选也选中了 `bin-stride4 + matchDist`，
但完整编码结果是 **109,457 B**，比它想改进的 v20 容器 100,139 B 还大 9.3 %。

原因不在门禁，在实现：`encodeTerrainGroup` 的 `bin-stride4` 分支直接把**未滤波
的原始字节**喂给恒等 `bin` 模型，BCJ 规则自己声明的 E8/E9 变换被完全跳过。
解码侧对称地也是纯恒等解码——所以往返"看起来正常"，但流与它自己的 spec 不一致，
而且必然输给真正做了滤波的 v20 路径。

修法：新增 `contextFilterForward` / `contextFilterInverse` /
`joinContextBinFiltered`，让上下文路径变成**在同一个已声明变换之上的模型替换**，
而不是"换个模型顺便丢掉变换"。编码解码逐字对称。

### 1.4 修复后仍然不赢（诚实负结果）

| 切片 | 组 | v20 基线 | `bin-stride4` | `+matchDist` |
| --- | --- | --- | --- | --- |
| ooffice-mid | `raw=44544` | 19,478 | 20,012 | 19,986 |
| ooffice-mid | `raw=20992` | 8,439 | 9,843 | 9,837 |
| ooffice-code | 全部 | 98,507 | — | 未采纳 |
| ooffice-code-late | 全部 | 101,411 | — | 未采纳 |
| mozilla-code | id24 组 | — | — | **已采纳**（v22） |

BCJ3 的 `bin` 模型本身已经带九上下文 + 长匹配，再加一组 stride-4 哈希上下文
是**重复建模**，交叉验证时反而稀释统计量。`matchDist` 在二阶上再省 26 B，
仍然远不够抵消上下文那 +534 B。

同时确认真正的赢家是 BIN 通道：`mozilla-code` / `mozilla-code-late` 的
`id24 s=1` 组走 `bin-stride4 + matchDist` 并被采纳（v22）。这条路径本来就通，
本轮的放宽没有给它带来额外风险。

### 1.5 交付

- `contextSpecAllowed('bin-stride4')`：加入 `BCJ/BCJ_V2/BCJ_V3`，并允许
  `BCJ_V3` 的 `s=1` **或** `s=2`（附注释说明两种变体等价于同一个 `bin` 流）。
- `matchDistProfileAllowed`：`bin-stride4` 与 `xform-bin*` 同列为恒等 BIN 上下文。
- `tests/p10.test.ts`：32 格 BCJ 矩阵 + v22 内核不变量（见 §3.2）。

## 2. Task 2：TRANSPOSE(9/legacy) → TRANSPOSE-G(10) → TRANSPOSE-G3(30) 升级管线

### 2.0 编号更正

简报用的是旧编号（7/10/30）。本仓库 `ID` 表为 `GRAD:7, D16:8,
TRANSPOSE:9, TRANSPOSE_GROUP:10, BCJ:11, …, TRANSPOSE_GROUP_V3:30`。
后文一律用本仓库编号。

### 2.1 `s=undefined` 是记录方式的问题，不是 spec 的问题

`candidateDecisions` 里 `{id:10, s:undefined, fl:0x0, b:undefined}` 这条记录
**不是** `chooseGroupV15` 写的。`chooseGroupV15` 的记录字段是
`{id, s, parts, rawBytes, base, alt, v20, variants, …, selectedBytes}`，按
`selectedSpec` 取值；带 `base/alt/b/screening` 的是 `planTuning.groupKernelScreen`
那一支。而 `{id, base, alt}` 这种三字段短记录只有一处：

```ts
// codec.ts L3122 — legacy ≥1 MiB V3-layout upgrade
g.spec.id = ID.TRANSPOSE_GROUP_V3
push({ id: g.spec.id, base: g.payload.length, alt: cand.length })
```

`id` 在 push 前已经被改写成 30，且这条记录**根本没有 `s` 字段**——所以
`s=undefined` 不是"步长丢了"，是"这条记录从来不记步长"。`fl=0x0`/`b=undefined`
同理：该记录不采样。**这不是缺陷**，是诊断记录格式不统一造成的误读。

真正的缺陷是它旁边那一行：

### 2.2 缺陷 A（死代码）：`v3spec` 在 `if` 里才声明，却在 `if` 外被引用

```ts
const isTgV3 = g.spec.id === ID.TRANSPOSE_GROUP_V3
const v3spec = { id: ID.TRANSPOSE_GROUP_V3, s: g.spec.s, r: 1 }   // 在 if 之外
if ((isTgV3 || g.spec.id === ID.TRANSPOSE_GROUP) && len >= 1024*1024 && …) {
```

这段本身能编译，但升级门槛写死 `len >= 1024 * 1024`（1 MiB）。`AITDCC` 与
`Silesia` 的 ≤256 KiB 切片**全部**够不着，所以这条 G3 升级路径在受测规模内
是**完全的死代码**。P6-4 的注释也承认它只为 `sao`（7.25 MiB）而设。

### 2.3 缺陷 B（结构性）：`ID.TRANSPOSE`(9) 永不参与布局择优

`encodePlanTranspose`（三布局 `9/10/22/30` 取小）只在
`g.spec.id === ID.TRANSPOSE_GROUP`(10) 的分支里调用：

```ts
} else if (g.spec.id === ID.TRANSPOSE_GROUP && g.members.every(…)) {
  const encoded = encodePlanTranspose(parts, g.spec, costBins, …)
```

`ID.TRANSPOSE`(9) 走的是通用的 `encodeTerrainGroup` + `chooseGroupV15`，
**只会在 v15/v20 内核之间选，永远不会去比 10/22/30 这三种布局**。
这正是简报 Task 2(b) 说的"`segs===1` 的 `ID.TRANSPOSE` 计划从不试升级"。

本轮受测的 12 个 Silesia ≤256 KiB 切片里，最终方案**没有**任何 id 9 组
（`sao-mid` 直接是 `30/28`，即 G3 已胜出）。所以这条缺陷在受测规模内没有
可归因的字节损失；它在 `AITDCC/N`（4 MiB，`s=4`）这类样本上才会暴露。

### 2.4 缺陷 C（实测）：逐列模式规划用错内核

`encodeGroupedTransposeImpl`：

```ts
const columnPlan = withCMProbe(() => planColumnGroups(parts, width, v13, false))
```

最后一个参数是 `v15`，写死 `false`。于是每列的模式（STORE/O0/BIN/DELTA/…）
是**用 legacy 内核定价选出来的**，而真正的载荷随后用 v15/v20 写出。
选择器为一个不会运行的模型做了最优决策。

按"逐列独立择优"的直觉，改用它真正会跑的内核应当更好。实测**相反**：

| 数据 | id10 legacy 规划 | id10 实际内核规划 |
| --- | --- | --- |
| w4-64K `10/v15` | 12,219 | **12,551** |
| w4-256K `10/v15` | 12,298 | **12,638** |
| w8-256K `10/v15` | 12,157 | **12,727** |
| w8-64K `10/v15` | 12,068 | **12,640** |

12 切片端到端复测：773,804 B，**0 B 变化**（该路径未被触达）。

结论：规划窗口是**定长样本**，而真实编码是**全组**；内核越强，样本上越容易
把某个列模式"看扁"（小样本上的 APM/SSE 校准收益低于它在全组上的真实收益），
于是按样本选出的模式在全组上反而更差。这说明**用更强内核做样本规划并不能
自动改善全组决策**——规划与编码的证据尺度必须一致，而这一点在当前架构里
无法便宜地做到（把规划窗口放大到全组会让每条候选多跑一次全组编码）。
按铁律**回退**，并把结论留在文档里，不做没有证据支撑的"优化"。

### 2.5 逐列模式下格式到底支持什么（Task 2c 的答案）

格式**支持逐组独立选择**，不支持逐列。每个列组写 `(span, mode|reverse128)`
两个字节 + varint 长度，`decodeGroupedTransposeImpl` 按这两个字节逐组解码。
实测同一份流里可以并存不同模式：

```
id10 w4 : 0+1:m6=1038  1+2:m6=5073  3+1:m3=4073     ← DELTA / DELTA / O0
id30 w4 : 0+3:m6=5662  3+1:m3=4073                  ← DELTA(span3) / O0
id30 w8 : 0+3:m6=3141  3+1:m0=2048  4+4:m6=4212    ← DELTA / STORE / DELTA
```

`planColumnGroups` 是从右往左的动态规划：对每个 `start` 枚举
`span ∈ {1,2,3,4,6,8,12,16,24,32,64}` 与（仅 `v13`）`reverse`，组内再用
`entropy8` 定**评估顺序**、用**真实字节长度**定胜负
（`[DELTA, RLE, O0, BIN]` 或 `[RLE, O0, BIN, DELTA]`，v20 变换开启时再加
`LE32/LE64`）。也就是说：**模式是逐组独立取最小，不是全组强制一个子模式**；
被"强制"的只是同一组内的若干列共享一个模式。

格式能力边界：每条目只有 7 位模式 + 1 位 reverse，`LE32/LE64` 额外要求
`span === 4/8` 且 `v13 && transformsV20Enabled()`；`FILL` 要求长度恰为 1；
`STORE` 要求载荷长度等于组长度。没有"逐列"标签位可用，想做逐列就必须改格式
版本——不在 P17.3 范围内。

## 3. Task 3：id 18/19（TEXT_V2/BIN_V2）单分片往返

P17.2 §1.4 记录的缺陷是"单分片 `_V2` 不往返"。本轮**无法复现**：

```
id 4 grp=1622/rt=true   spec=1622/rt=true
id 5 grp=1492/rt=true   spec=1492/rt=true
id18 grp=1559/rt=true   spec=1559/rt=true
id19 grp=1493/rt=true   spec=1493/rt=true
id20 grp=2186/rt=true   spec=2186/rt=true
id23 grp=1560/rt=true   spec=1560/rt=true
id24 grp=1523/rt=true   spec=1523/rt=true
```

（`grp` = `encodeTerrainGroup` 单分片路径，`spec` = `encodeSpec` 平铺路径。）

P17.2 给 `encodeSpecImpl` / `decodeSpecImpl` 的 `_V2` 分支统一到
`legacyCmOptions('bin', options)` 时，两侧的 kernel 参数（`true` = v15）本来就
一致，那次改动把最后一个不对称点消掉了。所以 Task 3 **不需要新代码**，只需要
把它固化成测试。已在 §3.2 的不变量测试里覆盖 id 4/5/18/19/23/24。

### 3.1 唯一的"失败"是正确的拒绝

112 格扩展矩阵（7 个 id × 2 个 position × 2 个 matchDist × 4 个内核）里
42 格抛 `无效的 v22 matchDist / profile / 格式标志`。全部是同一类：
`matchDist=true` 配 legacy/v13/v15 内核。v22 是 v20 内核特性，**必须**拒绝，
否则就会造出"长度对、字节错、不抛异常"的流——正是 P17.2 在 `AITDCC/I` 上
花掉整轮的那种故障。所有 v20 × matchDist 组合 100 % 通过。

### 3.2 新增测试（`tests/p10.test.ts`）

1. **32 格 BCJ 矩阵**：id `11/20/25` × `s ∈ {1}` / `BCJ_V3 s ∈ {1,2}` ×
   单/双分片 × `{无上下文, bin-stride4}` × `{md=false, md=true}`，逐格断言
   字节相等 + v21 命名空间标志。
2. **v22 内核不变量**：id `4/5/23/24` 在 `v15` 内核上请求 `matchDist` 必须
   抛错（正则 `/matchDist/`）。

## 4. Task 4：验证

全部在沙箱内、单条命令 `timeout --signal=KILL` 包裹、输入 ≤ 256 KiB。

### 4.1 门禁

| 项 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 0 |
| `npm run check:worker` | 最新 |
| `npm run build` | 462.92 kB / gzip 151.84 kB |
| `npm run test:codec` | **EXIT=0**；P10 15 checks（含新增 32 格矩阵）、P12/P13 全过、诊断 8/8 + 7/7 + 7/7 |
| `npm run test:ui` | 14/14 |
| `scripts/diag/p16/verify.mjs` | PASS 118 / 100 passes / 18 failures（既有基线） |

### 4.2 12 切片端到端（零回归铁律）

```
dickens-mid  v22   69519  rt=true      mr-mid      v21  48795  rt=true
mozilla-mid  v22   80206  rt=true      nci-mid     v22  13662  rt=true
ooffice-mid  v20  100189  rt=true      osdb-mid    v22  72355  rt=true
reymont-mid  v15   48941  rt=true      samba-c     v22  32130  rt=true
sao-mid      v20  131922  rt=true      webster-mid v22  56350  rt=true
xml-mid      v22    4501  rt=true      x-ray-mid   v20 115234  rt=true

合计 773,804 B —— 与 fd6385a 逐字节相同，Δ = 0，0 胜 0 负。
```

「0 胜」是本轮的**预期结果**而不是失败：Task 1 的机制接通了但在真实 x86 数据上
被严格门禁正确拒绝（§1.4），Task 2 的改动按铁律回退（§2.4），Task 3 无需改动。

### 4.3 四个空对照（必须 0 B）

```
iid-uniform    200000 ->   6601 v13  delta=0  [ctx:false macro:false orphan:false] rt=true
iid-5sym       200000 ->   1282 v12  delta=0  [ctx:false macro:false orphan:false] rt=true
constant       200000 ->     17 v7   delta=0  [ctx:false macro:false orphan:false] rt=true
unique-4gram   200000 ->     27 v7   delta=0  [ctx:false macro:false orphan:false] rt=true
```

四条全部 **delta = 0**：三个采纳门（上下文细化 / 宏组 / 孤儿合并）在数据里
不含结构时一个都不触发。

### 4.4 定向矩阵

| 矩阵 | 格数 | 结果 |
| --- | --- | --- |
| BCJ 11/20/25 × 单/双分片 × {无, bin-stride4} × {md 关/开} | 32 | **32/32 往返** |
| id 4/5/18/19/20/23/24 × position{0,65536} × md{关/开} × 内核{false,v13,v15,v20} | 112 | v20 × md 全通过；42 格按设计拒绝（md 配旧内核） |
| id 9/10/22/30 × 内核 × 宽度 4/8 | 24 | 24/24 往返；id30 稳定优于 id10（约 450 B） |

## 5. 教训

1. **门禁列表漏项比门禁逻辑写错更常见**。本轮三处（`bin-stride4` 的 id 列表、
   `s===1` 假设、`matchDistProfileAllowed` 的上下文分支）都是"少写了一项"，
   没有一处是判定式本身错。审计时先对齐**每个谓词覆盖的取值域**。
2. **"上下文细化为 0 组"要先查提案，再查筛选**。0 组意味着链路在更上游就断了。
3. **往返通过 ≠ 语义正确**。`bin-stride4` 跳过 BCJ 变换时往返完全正常，
   因为它两侧一起跳。只有把它和 v20 的字节数摆在一起才看得出来。
4. **合成数据上的机制收益不能直接外推**。BCJ 上下文在主战场（ooffice，
   13 个纯 BCJ3 组）上不赢，因为 BCJ3 的 `bin` 模型已经覆盖了同样的结构信息。
5. **"用更强的模型做规划"不等于"规划得更好"**。样本尺度与编码尺度不一致时，
   更强模型的样本排名会失真。这条是负结果，但必须记下来，否则下一轮还会有人
   再试一次。

---

# §P17.4 转置管线的三个断点

## 0. 结论摘要

| 断点 | 处置 | 结果 |
| --- | --- | --- |
| 1 `ID.TRANSPOSE(9)` 从不比较布局 | **已修** | 合成 4 列记录 131,072→**32,931 B**（id9 单流为 32,948）|
| 2 G3 升级 1 MiB 死门槛 | **已修** | 门槛降到 32 KiB，id 9/10 均可测 id 30 |
| 3(a) id 30 列级 `matchDist` | **审计为"本就正确"** | sao 上 matchDist 逐字节相同，标记正确地不打 |
| 3(b) 探针失败否否决正交轴 | **已修（真缺陷）** | sao 现在真的筛 `bin-stride4`，被容器门禁正确拒绝 |
| 12 切片 | 零回归 | **773,804 B 不变** |

## 1. 断点 1：`ID.TRANSPOSE(9)` 接入三布局择优

### 1.1 改动

`encodePlanTranspose` 原先只有 `ID.TRANSPOSE_GROUP(10)` 能进。id 9 走通用
`encodeTerrainGroup` + `chooseGroupV15`，**只比内核（v15/v20），不比布局
（9/10/22/30）**。现在两者共用同一条比较，前置条件完全相同
（`s > 1`、`members.every(rawLen <= MAX_SUB_CHUNK)`），字典键守卫不变。

### 1.2 一个必须同时修的、由本改动暴露的真实缺陷

`encodePlanTranspose` 的 "legacy 臂" 无条件调用 id 10 的编码器：

```ts
const legacy = encodeGroupedTranspose(parts, spec.s, undefined, undefined, false, legacyWeights)
```

这对 id 10 正确，因为只有它能进来。但 id 9 与 id 10 **接的是不同的解码器**：
id 10 每组读 `(span, mode|reverse, length)` 记录，id 9 每列读一条记录。
于是当 id 9 落回 id 9 时，返回的载荷是 id-10 字节却挂着 id-9 的 spec ——
**容器编码成功、解码抛「转置列长度错误」**。

这个 bug 在第一次跑空对照 `unique-4gram` 时就炸了（容器 63 B，解码失败）。
它之所以能活到跑测试才被抓到，是因为 12 个真实切片里没有任何 id 9 组。

修法：legacy 臂按 spec 分派。

```ts
const legacy = spec.id === ID.TRANSPOSE
  ? encodeTransposeGroup(parts, spec.s, undefined, undefined, false)
  : encodeGroupedTranspose(parts, spec.s, undefined, undefined, false, legacyWeights)
```

同一处还有第二个陷阱：调用方原先是

```ts
if(encoded.spec.id !== ID.TRANSPOSE_GROUP) { ...改 spec 与 payload... }
else g.payload = encoded.payload
```

这个判据把"id 10 就是原 spec"当成"不需要改"，一旦 id 9 进来就错了。
现在改为与**组自己的 spec** 比较（`encoded.spec.id !== g.spec.id ||
encoded.spec.s !== g.spec.s`），语义与进来的 id 无关。

### 1.3 实测

合成 4 列记录（col0 线性斜坡、col1 不可压 PRNG、col2 双峰 {0xaa,0x55}、
col3 16 级粗糙台阶；列间**无**共享结构，正是布局 30 的适用域）：

```
bytes     id9     id10    id22    id30    胜者
32768     8333    8337    8338    8305    id30 (-28 vs id9)
65536    16539   16543   16544   16512    id30 (-27)
131072   32948   32952   32953   32920    id30 (-28)
262144   65763   65767   65768   65738    id30 (-25)
```

端到端（严格 `P_new < P_old && C_new < C_old`）：

```
131072 -> 32931 B  segs=[30/4]
262144 -> 65749 B  segs=[30/4]
```

`131072 → 32931` 比 id 9 的裸载荷 32948 少 17 B，且已扣掉容器头 ——
所以这是**真实的容器级收益**，不是载荷级自欺。

### 1.4 id 9 不接受内核参数（重要约束）

实测 id 9 的载荷在 v13 / v15 / v20 下**逐字节相同**：

```
32 KiB float fixture:  9/v13=24611  9/v15=24611  9/v20=24611
```

v15/v20 这条轴对 id 9 **根本不存在**（`encodeTransposeGroup` 没有 kernel
参数）。这正是"把 id 9 送进布局比较"是该组唯一能碰到更强模型的路径。

## 2. 断点 2：G3 升级门槛

`len >= 1024 * 1024` 使整个升级路径在 1 MiB 以下是死代码 —— 对每个
≤256 KiB 切片、对 mozilla 的 307 KiB TRANSPOSE-G 组都够不着，只有
`sao`（7.25 MiB）曾经到达。现降到 `32768`，与规划器开始提出转置候选的
规模一致。id 9 也纳入该判断。

诊断记录从三字段 `{id, base, alt}` 改为与 `chooseGroupV15` 同构的
`{id, s, parts, rawBytes, base, alt, selectedSpec, selectedFlags,
selectedBytes, took, source}`。P17.3 §2.1 已确认，过去报告里的
`s=undefined / fl=0x0 / b=undefined` 是**这几个字段从来没被采样**，
不是步长丢失。

## 3. 断点 3

### 3.1 3(a)：id 30 列级 `matchDist` —— 现状本就正确

sao-mid（id 30, s=28）实测：

```
full base       132101  fl=0x3800
full matchDist  132101  fl=0x3800   <- sha256 完全相同，v22 标记从未置位
```

列计划是 `[0+8 m=8][8+6 m=0][14+1 m=3][15+1 m=1][16+12 m=5]`。
只有 `m=5`（BIN）会跑到 CM profile，而在这 112,344 字节上第二张距离表
**没有改变任何编码决定**。所以 v22 标记正确地**没有**置位 —— 这恰好就是
brief 要求的"全组没真正消费 matchDist 时不许打标记"。

对 brief 的两处更正：

1. **不要把 matchDist 传给 DELTA(m=6)**。它跑 `'res'` profile，
   `legacyCmOptions` 对 `res` 返回 `undefined`；brief 这一步会撞上
   "不要 matchDist native res/res2d" 的铁律。真正承载它的是 BIN(m=5)，
   而 BIN **本来就已透传** options。
2. **`planColumnGroups` 与 matchDist 正交的原因不是 `withCMProbe`**。
   它调用 `encodeGroupData(...)` 时**根本没传 `options`**。结论（可安全复用
   `columnPlan`）成立，理由不同。另注：P17.3 §2.4 已实测把**真实内核**传进
   该规划器会让结果变差（12,219→12,551 B），所以它保持原样。

P17.0 在 sao 上测到的 `-30 B` 因此**不可能来自 id 30 的列**：同一条流，
字节完全相同。那个数字的归因需要重做。

### 3.2 3(b)：探针失败否决正交轴 —— 真缺陷，已修

`contextGroupCandidatesSync` 里：

```ts
if(!result.screen.matchDist){result.skipped='probe-not-better';return result}
```

小分组（<256 KiB）先跑一条有界的 **matchDist 子样本探针**。它一输，
函数直接 `return`，**上下文轴连测都没测**。sao-mid 就是这样：matchDist
在 64 KiB 样本上输了 9 B，整组被标成 `probe-not-better`、`trials` 为空、
`contextComparison` 只留一行无候选记录。P17.0 到 P17.3 的 sao 差异最可能
就来自这里。

修法：探针只裁决**距离轴**，上下文轴继续走下面的筛选。

```ts
if(result.screen.matchDist)modes=[undefined as unknown as CMContext]
else result.screen.selected=[]
```

修复后 sao 真的筛到了 `bin-stride4`：

```
base 132101 | bin-stride4 132094 (载荷 -7 B) | 容器 132116 > 131922
```

严格容器门禁正确拒绝：7 B 的载荷收益小于 v21 命名空间在 plan header 里的
24 B 开销。**0 B 变化、0 回归** —— 门禁工作正常。

## 4. 验证

| 项 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 0 |
| `npm run check:worker` | 最新 |
| `npm run build` | 463.16 kB / gzip 151.93 kB |
| `npm run test:codec` | **EXIT=0**；P10 **17 checks**（新增 24 格 id30 矩阵 + id9→30 采纳断言）|
| `npm run test:ui` | 14/14 |
| `scripts/diag/p16/verify.mjs` | PASS 118 / 100 / 18 |

12 切片端到端：**773,804 B，与 `55482bc` 逐字节相同，Δ = 0，0 胜 0 负。**

四个空对照全部 `delta = 0`：

```
iid-uniform   200000 -> 6601 v13  rt=true
iid-5sym      200000 -> 1282 v12  rt=true
constant      200000 ->   17 v7   rt=true
unique-4gram  200000 ->   27 v7   rt=true
```

## 5. 教训

1. **放宽一个入口条件，必须同时审计被调用函数的"隐含前提"**。
   `encodePlanTranspose` 隐含"只有 id 10 会进来"——legacy 臂和调用方的
   `!== ID.TRANSPOSE_GROUP` 判据都建立在这个前提上。放宽入口让两处同时失效。
2. **空对照是第二道防线**。12 个真实切片全部通过，只有 `unique-4gram`
   暴露出 id 9 的编解码错配。真实语料没有 id 9 组，这个 bug 可以活很久。
3. **正交轴必须能被独立裁决**。一条探针失败就 `return`，会把另一条
   完全独立的轴一起枪毙。任何"早退"都要问：它否决的是哪条轴？
4. **"改完再测一次"不是可选项**。第一次 `test:codec` 全绿是在那个
   id-9 错配还没被空对照发现之前。
