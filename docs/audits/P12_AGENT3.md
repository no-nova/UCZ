# P12 审计单元 3：可执行段、结构体与真实分组证据边界

日期：2026-11-07。生产参考 `a3b6c3d`，无 `src/` 修改。mozilla/ooffice/osdb 用户本地P11.1基线之和 **17,549,702 B**。本环境没有真实Subagent调度接口，此处为第三独立审计单元。

## 1. 摘要与实验边界

- 28个独立256KiB短进程：**24次编码/逆变换/解码SHA往返全部通过**；4次只作结构/候选池统计。最慢 **7,207ms**，17.5s内部预算+19s外部SIGKILL保护。
- 原始BIN-v15对照在输入及生产源码完全一致时复用单元1的收据，未重复全文件编码。新增 `.rdata` 后窗在第一次结果后固定取紧邻、不重叠的下一256KiB，manifest只追加，旧选址不变。
- **Jcc不是本轮正收益方向：**真实ooffice x86 `.text` 两位置，相对现有E8/E9 BCJ分别回退864B、965B。
- **Mozilla主样本不是x86。** 它是Alpha ECOFF；盲目套x86或Alpha分支绝对地址化均没有净收益。相反，现有TG3的4B指令/8B结构体布局值得检查其规划覆盖。
- **osdb未证明是MySQL页。** 所测窗口是高ASCII占比、带二进制字段和长度/分隔控制字节的混合记录；固定4KiB页差分严重回退，已有NUL锚点/SUB转置也败给BIN。
- **尚不能给出Mozilla P11.1实际最终组构成。** 用户提供了最终大小和验收结果，但没有该次容器/原始分组JSON。本轮严格不重跑整文件去填空。历史43组或本轮切片分段都不能代替实际最终组。

## 2. 先确认架构与节区，再谈BCJ

`p12-results/slices.json` 保存tar成员和可执行节区解析。外部格式核对记录在 `p12-results/architecture-references.json`：GNU binutils镜像 `include/coff/ecoff.h` 的 `ALPHA_MAGIC=0x183`，`alpha.h` 的file header24B、section header64B，均保存了GitHub blob SHA与行号摘录。

- [binutils ECOFF 定义](https://github.com/RTEMS/sourceware-mirror-binutils-gdb/blob/master/include/coff/ecoff.h)
- [binutils Alpha 头布局](https://github.com/RTEMS/sourceware-mirror-binutils-gdb/blob/master/include/coff/alpha.h)

|输入成员/节|已核实证据|切片位置|
|---|---|---|
|ooffice `.text`|PE signature，machine=0x014c（x86），raw offset4096，size5,283,840|文件4096及1,052,672，各256KiB|
|mozilla/components/libgkcontent.so|magic0x0183，21个节，optional header80B|tar成员offset15,110,656，size7,036,928|
|其 `.text`|成员内offset2,207,728，size4,012,816|文件17,318,384及+1MiB，各256KiB|
|其 `.rdata`|成员内offset6,245,712，size644,352|文件21,356,368及+256KiB，各256KiB|
|其 `.dynstr`|成员内offset893,296，size564,304|文件16,003,952，256KiB|

`.dynstr` 还能直接看到 `libc.so\0osf.1`、`libcxx.so` 和Tru64风格符号；`.rdata` 主要样本是指针/RTTI结构体，不能泛称为PNG/JAR资源。archive中的JAR等压缩资源是另一类，本轮没有把结构体结果推广到它们。

## 3. x86 E8/E9 与 Jcc：真正的现有基线不是raw BIN

生产 `transforms.ts:84–104` 扫描E8/E9 rel32，位移加全局位置mod2^32，跳过操作数字节；不是完整反汇编器。

诊断 `bcj-jcc` 在同一扫描规则中增加 `0F 80..8F rel32`，PC=i+6。编解码都跳过整个6字节结构，模运算可逆；仍然可能把数据/立即数字节错判为指令，**不宣称是真指令计数**。中窗扫描有8,979个E8/E9字节模式及1,204个Jcc模式。

|真实x86 `.text`，各256KiB|raw BIN B|现有BCJ B|BCJ+Jcc B|Jcc相对现有BCJ ΔB / %|
|---|---:|---:|---:|---:|
|ooffice-code|114,639|102,060|102,924|**+864 / +0.847%**|
|ooffice-code-late|115,407|105,258|106,223|**+965 / +0.917%**|

现有BCJ本身已经有效，不能把它相对raw BIN的22,728B收益包装成“Jcc新增收益”。短条件分支原位移有局部性，盲目绝对化未必有利；是否仅对反汇编确认且跨函数的分支才有收益，本轮未测。依据当前证据不改BCJ默认、不占用旧ID25的语义。

### Mozilla负对照与Alpha专用假设

|mozilla-code，256KiB|payload B|相对raw BIN ΔB / %|
|---|---:|---:|
|raw BIN v15|76,362|0|
|x86 E8/E9|79,944|+3,582 / +4.691%|
|x86 E8/E9+Jcc|79,944|+3,582 / +4.691%|
|Alpha BR/BSR（opcode30/34）21bit字位移绝对化|77,750|+1,388 / +1.818%|
|Alpha所有branch opcode30..3f绝对化|86,294|+9,932 / +13.006%|

该Alpha代码窗扫描不到Jcc；1,168个E8/E9字节模式只是非x86误命中。Alpha变换保留opcode/register位、按4B对齐处理21bit位移，全部往返通过，但**可逆不等于可压缩**。不因发现正确架构就许诺专用BCJ收益。

## 4. Mozilla真正值得追踪的是已有TG3的结构覆盖

### 4.1 代码与指针区的单组Oracle

TG3为现有ID30，s4对应定长Alpha指令，s8对应 `.rdata` 指针/结构体；测量已含TG内部组头。单组payload，不是完整UCZ，也不证明当前全文件实际遗漏了同一规则。

|独立256KiB窗口|raw BIN|DELTA3(s8)|现有SUB_TRANSPOSE(s8)|TG3候选|相对本表非TG较优 ΔB / %|
|---|---:|---:|---:|---:|---:|
|mozilla-code|76,362|未测|未测|s4：69,676|−6,686 / −8.756%|
|mozilla-code-late|74,239|未测|未测|s4：66,565|−7,674 / −10.337%|
|mozilla-resources `.rdata`|26,196|23,944|23,879|s8：17,649|−6,230 / −26.090%|
|mozilla-resources-late `.rdata`|31,408|32,659|31,784|s8：21,473|−9,935 / −31.632%|

四个独立实验相对所列较优对照，合计 **30,525B**。前两个只与raw BIN及负收益分支变换比较，未穷尽所有code候选；后两个已追加两个现有结构候选。不能将这30.525kB与单元1匹配恢复收益相加，它们会竞争同一数据。

`.dynstr` 的text-v15为26,592B，bin-v15为27,448B（−856B/−3.119%）；这是符号字符串的条件证据，不是“Mozilla全体资源改text”的依据。

### 4.2 为什么可能未入池/未扩大到同构区域

源码审查与本轮**候选资格扫描**，而非最终chooser结果：

- `planTuning.candidateTgV3=false`。ID30不在普通区域的直接候选里；通常要先让TRANSPOSE/TG获胜，后续 `encodePlanTranspose` 才比较legacy、geometric、TG3。不能简单说“没有TG3实现”。
- `.text`固定窗的全窗stride检测为32，但最大几个局部分段检测为20、24等；32可能是指令排布周期，不等于基本指令宽4。当前没有默认强制s4候选。
- `.rdata`固定窗的全窗stride8相等率75.47%，但 `analyze` 在该256KiB内分为115段（145,408B repeat、116,736B smooth）。最长段只有11,776B；其候选含SUB(15,s8)、TRANSPOSE(9,s8)，但没有长度需>=32KiB的TG(10)直接候选，且30默认不直接进池。更小段还有检测不到stride的情况。
- 上述是**此切片**的规划覆盖风险证据；整文件拥有邻段、合并、统一及macro/orphan护栏，不能从这里反推a3本地最终少了哪些组。
- 不建议全局打开TG候选开关来掩盖采样/聚合问题。优先取得实际最终目录，定位同节区、同结构的候选批次，再用保留原基线的完整容器严格成本门采纳；不以其它文件收益抵消1B回退。

## 5. osdb：记录结构明显，MySQL页归因未成立

中窗ASCII可打印/空白约80.35%，NUL约6.59%。可见日期字符串、重复小数如 `-353535354.00`、固定/变长ASCII字段，夹杂二进制数值与控制字节。这里只观察字节，不声明确切数据库格式、schema或页头类型。

|中窗滞后|同位置字节相等率|该滞后byte-Delta H0|
|---|---:|---:|
|4|5.76%|7.300|
|8|4.17%|7.423|
|4096|2.01%|7.759|
|8192|1.84%|7.772|
|16384|1.88%|7.768|

raw H0=6.591。页面间位置对应没有明显支持；窗口全局detectRecordStride=2，不能把它当完整记录长度。

|256KiB切片|现有BIN B|Oracle/现有候选 B|ΔB / %|
|---|---:|---:|---:|
|osdb-mid，4KiB前页byte-Delta后BIN|74,268|248,218|+173,950 / +234.219%|
|osdb-mid，NUL锚点SUB_ANCHOR_V3(29,0,136)|74,268|85,254|+10,986 / +14.792%|
|osdb-late，同一NUL锚点|74,484|85,658|+11,174 / +15.002%|
|osdb-mid，SUB_TRANSPOSE(15,s2)|74,268|94,673|+20,405 / +27.475%|

前页Delta是诊断假设，不是生产页格式。后两种是已有可逆子通道方案，包含内部侧信息，且在中窗最大240,640B repeat段的**实际候选列表中都存在**：ID15,s2与ID29,0,136。此处至少不能说“完全没入池”；这些局部Oracle确实不及raw BIN。对混合变长记录粗糙NUL分列会破坏已有跨字段相关性。

## 6. Mozilla P11.1最终分组：明确缺口与无需重编码的取得方式

**当前未知：**a3那次13,257,771B容器的真实groupCount、每组(id,s,r,kernel,WORD-PRE)、成员offset/length、payloadBytes，以及哪些孤儿被吸收。用户的12项大小/时间不能导出这些信息。旧P8的43组、旧 `probe-moz-groups` 的按label聚合也不是当前wire分组目录。

新增只读工具：

```sh
# 只读已有压缩文件的头/目录，不解码，不压缩，不启动worker。
node scripts/diag/p12/inspect-container.mjs /path/to/existing/mozilla.ucz --baseline mozilla > mozilla-p111-groups.json
```

输出精确group/member/range/压缩段长度、containerSHA、版本/flags、真实header长度；保留合法r=8192，不把0x2000当标志。`--baseline`只比较原始长度与13,257,771B大小，**不声称核验了原文SHA或生成commit**。输出中的orphanSizeEligible只检查 `<2MiB && <20%` 且非FILL，不表示合并获利。

`check-container-inspector.mjs` 只读六份已有独立历史容器，长度/版本/hash及截断拒绝通过；另用纯虚拟目录核查v19 uint16 flags和r8192，**没有运行编码或解码**。结果在 `container-inspector-check.json`。虚拟payload不作有效熵编码流证据。

若本地只保存了bench JSON，`--verbose-segs` 可包含部分区域信息，但没有精确同规则分组的模式位和payload布局时仍不能补造；**本轮不要求用户重新执行全文件长测**。等已有容器目录可用，再按以下顺序列出具体可合并段：

1. 同一Alpha `.text` 内不同短stride分组，比较合并为s4 TG3与保留原组。
2. 同一 `.rdata` 内散落的s8候选，比较整节区/同构子段的TG3与当前子组，不混入JAR。
3. 小STORE/O0/BIN/TEXT孤儿向已有dominant的单批重编码；排除FILL，严格保留原完整容器兜底。

这些是**待定位/待成本验证的候选类型，不是已识别的a3具体可合并offset列表**。

## 7. 审计结论

- **否决当前简单Jcc扩展、盲目的Alpha分支绝对化、osdb页差分。** 可逆性通过，体积证据不支持。
- **优先追踪已有TG3的结构覆盖/聚合，而非再造编码器。** 局部30.525kB存在，但目前无法扣除P11.1已兑现的部分；全文件新增收益的证据下界仍为0。
- 生产比特流不变；没有把架构判断、元数据扫描或历史分组算作全量复测。原始证据在 `scripts/diag/p12-results/agent3/`，完整变量与输入hash见收据。
