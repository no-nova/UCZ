# Prior Registry / 先验登记册

Every place where the codec consults something other than "the bytes seen so far",
with its measured cost (ablation) and whether `--strict-zero-prior` disables it.

`--strict-zero-prior` (container version **23**) restricts the planner to a rule family
whose *decision inputs* are raw byte lags and positional/equality structure only.
It does **not** make the compressed size relabelling-invariant; see
`CONSTITUTION.md` §"Strict-profile invariance".

| # | Component | Location | Kind | Measured effect | Strict mode |
|---|-----------|----------|------|-----------------|-------------|
| 1 | x86 `E8/E9` rel32 transform (`bcj`, `bcjMsb`) | `src/lib/transforms.ts:77` | domain transform | `9.H` 316,708 → 297,908 B (−18,800) | disabled (spec + context both blocked) |
| 2 | ModRM/SIB/disp32 contexts `H[21..24]` | `src/lib/coder.ts:1527` | domain contexts | part of the −18,800 above | disabled (`bcjOn` never set) |
| 3 | printable-ASCII planning shortcut | `src/lib/codec.ts:920` | content classifier | `yeast.data` 21.2 s → 5.2 s | disabled |
| 4 | `asciiTableGroup` text proposals | `src/lib/codec.ts:5195` | content classifier | `wdbc.data` 34,645 → 31,542 B (−3,103) | disabled |
| 5 | ASCII column / word / field contexts (`text-*`) | `src/lib/coder.ts` text branch | content layout | `B` 166,242 → 156,038 B (`text-vertcol`) | disabled (raw-lag contexts only) |
| 6 | character classes `charClass2/3/8`, `charShapeMask` | `src/lib/coder.ts:380-390` | byte-value category | part of the text gains above | contexts off; APM/mixer indices **not** yet value-free |
| 7 | `;` density delimiter | `src/lib/coder.ts` `updateLineCol` | domain delimiter | wine tables −1,808 B | disabled with the text contexts |
| 8 | 0x00/0xFF bitmap gate + `detectScanPeriod` | `src/lib/coder.ts:1355` | content prior | `ptt5` 42,773 → 26,939 B (−37%) | disabled |
| 9 | quantised lags `b>>>2/3` (bin ladder) | `src/lib/coder.ts` bin branch | byte-value feature | `H` 297,908 → 296,770 B | disabled |
| 10 | `QV[]` / `magClass` / `binClass4` quantisation | `src/lib/coder.ts` res/bin profiles, `computeMix2` | byte-value feature | feeds `E/O/F/N` residuals | **still active** |
| 11 | byte-value arithmetic specs (`DELTA`, `GRAD`, `REC2`, `BITPLANE`, `MICRO`) | `src/lib/codec.ts` | non-invariant transform | `5.L` 3,000,000 → 131,165 B | disabled |
| 12 | anchor family (header stores a byte value) | `src/lib/codec.ts` `ANCHOR*` | value-keyed header | multi-anchor tables | disabled in strict (rank-based anchors otherwise) |
| 13 | fixed hash map `hh()` | `src/lib/coder.ts` | implementation | none by itself | **still active** (relabelling changes collisions) |

## Ablation summary — Canterbury (11 files) + UCI (6 files), level `max`

| Corpus | default | `--strict-zero-prior` | Delta |
|--------|---------|----------------------|-------|
| Canterbury | 369,447 | 375,283 | +1.58 % |
| UCI | 375,359 | 429,683 | +14.5 % |
| **total** | **744,806** | **804,966** | **+8.08 %** |

Largest per-file costs of the priors: `ptt5` 26,939 → 43,788 (+62.5 %, a CCITT fax
bitmap with a detected 216-byte scanline), `kennedy.xls` 33,107 → 44,848 (+35.5 %,
value-quantised residual coder), `wine-red` 13,067 → 16,024 (+22.6 %) and
`wine-white` 37,673 → 46,410 (+23.2 %) (semicolon tables → ASCII column contexts).
Files where the priors are worthless: `cp.html` +2 B, `fields.c` +2 B,
`grammar.lsp` +2 B, `xargs.1` +5 B, `adult.data` +1,076 B (+0.6 %).

Reproduce with `npx tsx <script>` calling
`compressAdaptive(raw, undefined, { level: 'max', strictZeroPrior: true })`.
Strict runs are also 1.5–4× faster (it prunes the candidate sets) and always decode
correctly; `tests/invariance.test.ts` re-checks the roundtrip and the drift bound.
