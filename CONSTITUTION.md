# UCZ Constitution / UCZ 宪法

> **Status:** binding scientific charter. Every codec change must preserve these articles.
> **Identity:** UCZ is a prior-free universal lossless compressor and an executable
> Solomonoff-induction / test-time-adaptation kernel. It learns only from the input
> bytes in front of it; it never carries a domain, language, format, or corpus prior.

## Scope of the "zero-prior" claim / "零先验"的确切范围

Zero external dictionaries, zero pretrained corpus weights, zero filename or magic-byte sniffing,
and zero format-specific pre-decompressors (no built-in zlib/PNG decoder, no archive reader).
The engine may hold a finite, **hand-designed** family of general structural transforms and
context-mixing predictors and choose among them online from the input bytes. That is a design
prior about the shape of computation, not a corpus prior about the content — every claim of
"zero prior" in this repository must be read against this definition.

零外部字典、零预训练语料权重、零文件名/魔数嗅探、零格式专用预解压器（不内置 zlib/PNG 解码器，
不解析归档格式）。引擎可以持有一族有限的、**手工设计**的通用结构变换与上下文混合预测器，并在
运行时从输入字节里在线选择；这是关于"计算形状"的设计先验，不是关于"内容"的语料先验。本仓库
一切"零先验"表述都以本条为准。

## Strict-profile invariance / 严格档的不变性定理

A byte relabelling is any bijection π on `0..255`, applied pointwise to the input X.
Two different notions must be kept apart, because only one of them holds today.

**(I) Decision-input invariance (holds, enforced).** Under `--strict-zero-prior`
(container version 23) the planner may consult only: raw byte lags, positional
structure, equality between previously seen bytes, the input length, and measured
encoded sizes. It may not consult byte-value categories, arithmetic on byte values,
value-keyed headers, or content classifiers. This is enforced by
`STRICT_FORBIDDEN_SPECS` / `strictAllowsSpec()` (`src/lib/codec.ts`), the opaque-region
classifier override, the raw-lag-only context branch, and the disabled scanline,
BCJ, REC2 and bit-plane stages. `tests/invariance.test.ts` asserts that no strict
plan ever contains a forbidden rule and that `decompress(compress_π-strict(π(X))) = π(X)`.

**(II) Size invariance (does NOT hold).** `C(π(X)) = C(X)` is false in this codec, and
the strict profile does not make it true. Three mechanisms survive every gate: the
fixed hash map `hh()` maps value tuples to table slots, so a relabelling changes which
contexts collide; the model still carries byte-value features inside the
APM / secondary-mixer indices (`charClass*`, `magClass`, `binClass4`, `QV[]`
quantisation, `b >>> n` lags); and rule choice is decided by *measured* size, so
near-tied candidates can swap under π.

Measured drift (deterministic π, 128 KiB slices of the reference corpus, strict mode):
worst per-file **+12.8 %** (`adult.data`), aggregate over eight files **+3.4 %**; at
fixed profile the model alone drifts up to **+64 %** on a high-entropy structured
binary (`kennedy.xls` slice, where quantised APM indices dominate). The test suite
therefore asserts a regression *bound*, not equality: per file ≤ 70 %, aggregate ≤ 50 %.

This is why every "zero-prior" claim in this repository is a claim about **what the
planner is allowed to look at**, not a claim that the coder is invariant to relabelling
of the alphabet. Making (II) true would require a value-free model variant (no
quantisation tables, no character or magnitude classes, collision-stable hashing) and
is not claimed here.

对字节表做任意置换 π 时，本编解码器**不**满足 `C(π(X)) = C(X)`，严格档也不满足——
三重原因：固定哈希把值元组映射到桶位（置换即改变碰撞），模型内仍有 `QV[]` 量化、
字符/量级类与 `b>>>n` 位移等字节值特征，且规则选择按实测大小决定，近似并列的候选
会在 π 下互换。因此本仓库的"零先验"只主张**规划器被允许看什么**，不主张对字母表
重标号不变；`--strict-zero-prior`（容器版本 23）把规划输入限制为原始字节滞后、
位置、相等结构与长度，并由 `tests/invariance.test.ts` 以实测误差上界（单文件 ≤70%、
合计 ≤50%；参考语料实测最差 +12.8%、合计 +3.4%）作为回归闸门。

## Founding Articles / 九条根本原则

1. **Zero Dictionary Systems.** No static word lists, phrase books, dictionaries,
   n-gram tables, or corpus-derived lexicons. Every dictionary/token table is built
   from the current input and transmitted or reconstructed losslessly.
2. **Zero Pretrained Models.** No external weights, no offline-trained statistical
   tables, no neural checkpoints, no BLOSUM/PAM matrices, no learned priors.
3. **Zero Hardcoded Domain Priors.** The prior-free core must not assume ASCII,
   text, DNA, protein, executable, image, or archive structure. No `'A','C','G','T'`
   or amino-acid literals, no x86 `E8/E9` opcodes, no format-specific fields, no
   magic constants whose meaning comes from a domain.
4. **Zero Filename / Path / MIME Inspection.** The codec accepts only a raw
   `Uint8Array` (plus its length). Names, extensions, paths, and external MIME
   metadata must never influence coding decisions.
5. **Zero Input Magic-Byte Sniffing.** No PNG/ZIP/ELF/PDF/FASTA/... signatures.
   Container magic for UCZ's own output is permitted; it is never read from input.
6. **Zero Corpus Fingerprinting and No Non-Monotonic Sandwich Gates.** Every
   threshold must follow a monotonic MDL/sample-complexity or memory-budget law.
   Gates of the form `A < n <= B` tuned to benchmark file sizes are forbidden.
7. **Unknown-Meaning Byte Stream, Symbolic Bijection, and Ring Isometry.**
   The engine recognizes two mathematically distinct model classes:
   - **Type I — symbolic / grammatical / homology models** (`sym-*`, `text-*`).
     These operate on a discrete alphabet `Σ` and MUST satisfy symmetric-group
     invariance: replacing every byte by any bijection `π ∈ S256` preserves
     symbol discovery, mode selection, and compressed size (`C(π(X)) = C(X)`).
     Canonical identity is derived only from invariant rank/role statistics,
     never from raw byte labels.
   - **Type II — algebraic ring / metric models** (`REC*`, delta, linear
     prediction). These operate on `(Z_256, +, -)` and MUST satisfy ring-isometry
     invariance `x -> ±x + c (mod 256)`. They are not required to be invariant
     under arbitrary symbol permutations, because doing so would erase the
     modular arithmetic they model. D/REC2 is the canonical Type II example.
8. **Hard Peak RAM Limit ≤ 4 GB.** `CONSTITUTIONAL_MAX_RAM_MIB = 3584` with 512 MiB
   headroom across all workers, tiers, and scratch buffers, even at
   `MAX_INPUT_BYTES = 256 MiB`. The scheduler must enforce a hard cap, not a hope.
9. **Self-Contained Decoder ≤ 512 KB.** The decoder must be a single self-contained
   implementation with no npm/runtime model dependency. `npm run check:worker`
   is the gate.

## Scientific Honesty and Verification Protocol

- Do not extrapolate results from a `<= 256 KiB` slice to a full file. Report full-file
  measurements, or label a slice explicitly as a probe.
- Enforce strict per-file zero regression: no file may grow relative to the previous
  committed scoreboard.
- Every reported result requires `compress -> decompress -> SHA-256` equality.
- Run the standard bijective permutation audit for symbol modes:
  `π_rand1` (0x20 trap), `π_rand2`, and `π_invert`; require `Δ = 0 B` and `rt = true`.
- Prefer a measured, mechanism-level explanation over a benchmark-only claim.
- Keep production free of temporary probes; remove diagnostic scripts before commit.

## Amendment Process

An amendment requires: (a) a written first-principles justification, (b) full-file
evidence on the standard corpus, (c) permutation and lossless verification, and
(d) an explicit statement of any article that is being narrowed. Silent exceptions
are unconstitutional.


## Integrity is not authentication

`--checksum` (container `v24`) stores a CRC-32C of the decompressed payload. Its purpose is
to catch **accidental** damage and to make "silent wrong output" impossible for new
containers. It provides **no** authenticity: a CRC is linear and unkeyed, so anyone who
modifies the payload can recompute it. Containers written before `v24` carry no content
checksum, and the decoder must keep accepting them — that gap is documented, not hidden.
Anything that needs real tamper resistance belongs on top of UCZ (a signed envelope), not
inside the format.
