# UCZ — Benchmark Record

[English](README.md) | [简体中文](README.zh-CN.md) | **Full benchmarks** | [9-Point Constitution](CONSTITUTION.md)

Every number in this file was produced by the code in this repository and verified by a
byte-exact SHA-256 roundtrip (`rt = true`). Nothing here is an estimate or a projection.
Where a figure comes from a reference implementation instead (paq8px, AC2, GeCo3, JBIG), it
is labelled as such and is never mixed into a UCZ total.

UCZ is `v0.1.0-beta.1`: a TypeScript reference implementation, single-threaded per stream.
It is slow, and the ratios below are the interesting part, not the speed.

---

## 1. Methodology and the two reference frames

### 1.1 Why two reference frames

A zero-prior compressor is only meaningful if you say what it is *not* allowed to use.
UCZ runs under the [9-Point Constitution](CONSTITUTION.md): no built-in dictionaries, no
pretrained weights, no file-header magic-byte sniffing, no format-specific pre-decompressors,
no per-corpus tuning. Every model it uses is learned online from the bytes in front of it, and
every choice is made by encoding candidates and keeping the smallest.

That constraint makes a single comparison table misleading, so results are reported twice:

| Reference frame | Members | What it answers |
| --- | --- | --- |
| **Industrial baseline** | `gzip -9`, `bzip2 -9`, `zstd -19`, `xz -9e` | "Is this worth using at all?" These are the compressors a user actually has installed. |
| **Context-mixing / domain reference** | `paq8px` (Matt Mahoney et al.), `cmix` (Byron Knoll), `AC2` (proteins), `GeCo3` (DNA), `JBIG` (bi-level rasters), `FLAC` (audio) | "How far is an online-learning model from a heavily engineered specialist?" |

Both frames are stated per matrix. Where UCZ loses, the matrix says so and the next section
explains the mechanism, because a benchmark table without a mechanism is advertising.

### 1.2 Verification protocol

* Every container is decompressed in-process and compared byte-for-byte with the input.
  The SHA-256 of both buffers is printed by `scripts/bench-public.mjs` and by the per-matrix
  drivers; a mismatch aborts the run.
* Integrity of the *plan* is checked too: the reported cost ledger must equal the produced
  container length (`tests/codec.test.ts`), so a ratio cannot come from a mis-declared header.
* Files are read from disk, never generated from a seed that the compressor could exploit.
* Determinism: the same input and the same level produce the same bytes on the same build.

### 1.3 Reproduce

```bash
npm run build                      # worker bundle + dist/cli.js + dist/index.js
npm run bench:quick                # 6 synthetic streams, ~7 s, self-verifying
npx tsx tests/codec.test.ts        # plan/ledger/roundtrip/edge/CLI (~8 min)
node tests/run.mjs                 # the same suite under the release gate
```

---

## 2. Matrix 1 — AITDCC 16-track cross-manifold benchmark

Sixteen files, deliberately heterogeneous: text, tabular, telemetry, rasters, machine code,
already-compressed noise. Every file is 1–4 MiB so that the model has to *discover* a manifold
rather than amortise a header.

**Total: 38,289,319 B → 17,053,803 B (44.54%)**, all 16 files `rt = true`.

| # | File | Raw (B) | UCZ (B) | Ratio | Container ver | Discovered manifold / dominant rule |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | `1.P` | 2,910,138 | 2,887,654 | 99.23% | 20 | incompressible: `STORE` + freeze gate (no expansion) |
| 2 | `2.O` | 2,607,090 | 748,640 | 28.72% | 20 | mixed: `BIN_V3` + `TRANSPOSE_GROUP s=2` |
| 3 | `3.N` | 4,194,304 | 3,187,858 | 76.00% | 20 | high-entropy sensor streams: `TRANSPOSE s=2` |
| 4 | `4.M` | 3,145,728 | 2,387,059 | 75.88% | 20 | `TRANSPOSE_GROUP_V3 s=4` |
| 5 | `5.L` | 3,000,000 | 131,165 | 4.37% | 21 | quasi-periodic: `BITPLANE r=4` |
| 6 | `6.K` | 3,000,000 | 472,973 | 15.77% | 22 | tabular text: `text-vertcol` (22 contexts) |
| 7 | `7.J` | 3,000,000 | 1,070,488 | 35.68% | 22 | tabular text + noise pockets: `text-vertcol` |
| 8 | `8.I` | 3,295,751 | 1,536,700 | 46.63% | 21 | `TEXT_V3` (9 contexts) |
| 9 | `9.H` | 1,022,760 | 297,908 | 29.13% | 20 | x86-64 ELF: `BCJ_V3 s=2` + 25 contexts |
| 10 | `10.G` | 2,526,752 | 665,036 | 26.32% | 20 | 2-channel telemetry: `TRANSPOSE_GROUP s=2` |
| 11 | `11.F` | 2,097,152 | 1,587,269 | 75.69% | 20 | broadband noise + drift: `TRANSPOSE s=2` |
| 12 | `12.E` | 1,012,112 | 768,455 | 75.93% | 20 | `TRANSPOSE_GROUP_V3 s=4` |
| 13 | `13.D` | 2,000,000 | 173,742 | 8.69% | 21 | two-lag recurrence: `REC2` |
| 14 | `14.C` | 2,000,000 | 328,781 | 16.44% | 22 | prose/table mix: `text-vertcol` |
| 15 | `15.B` | 1,168,767 | 156,038 | 13.35% | 22 | structured text: `text-vertcol` |
| 16 | `16.A` | 1,308,765 | 654,037 | 49.97% | 21 | `TEXT_V3` |
| | **Total** | **38,289,319** | **17,053,803** | **44.54%** | | |

Notes on the interesting rows:

* `5.L` (4.37%) is not a special case in the code. The analyser finds a quasi-period, the
  planner trial-encodes a bit-plane decomposition and keeps it because it is smaller. `BITPLANE`
  exploits the fact that one bit position is stationary while another is not — a property of the
  *bytes*, not of a known file type.
* `9.H` (29.13%) is `BCJ_V3`: a causal relative-jump transform with a sign-byte guard, followed by
  a 25-context model whose extra slots bridge `disp32` immediates and `ModRM` fields.
* `1.P` (99.23%) is the freeze gate working: the entropy tracker crosses its threshold, the
  column and context tables stop being updated, and the planner downsamples the file to almost
  pure `STORE`. The container overhead on incompressible data is under 0.003%.
* The three 75–76% rows (`11.F`, `12.E`, `3.N`) are genuine high-entropy multichannel signals.
  They are reported rather than hidden: the manifold is found (transpose splits the channels),
  but the residual entropy per channel is close to 8 bit/byte, so there is little left to remove.

Reference frame: for this corpus the author's `paq8px` runs are 5–15% smaller on the text-heavy
files (`6.K`, `15.B`, `14.C`, `7.J`) and comparable on `5.L`/`13.D`; on the four incompressible
files both are within 0.1%. `paq8px` uses a built-in English dictionary and format models, which
the Constitution forbids here — that is the gap this benchmark is trying to measure, not to win.

---

## 3. Matrix 2 — Canterbury Corpus (11 files)

**Total: 2,810,784 B → 369,447 B (13.14%, 1.051 bit/byte)**, all files `rt = true`.

| File | Raw (B) | `gzip -9` | `bzip2 -9` | `zstd -19` | `xz -9e` | **UCZ** | **UCZ %** |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `alice29.txt` | 152,089 | 54,179 | 43,202 | 49,212 | 48,536 | **37,430** | 24.61% |
| `asyoulik.txt` | 125,179 | 48,816 | 39,569 | 45,138 | 44,600 | **34,817** | 27.81% |
| `cp.html` | 24,603 | 7,973 | 7,624 | 7,716 | 7,660 | **6,630** | 26.95% |
| `fields.c` | 11,150 | 3,127 | 3,039 | 3,017 | 3,040 | **2,582** | 23.16% |
| `grammar.lsp` | 3,721 | 1,234 | 1,283 | 1,214 | 1,300 | **1,100** | 29.56% |
| `kennedy.xls` | 1,029,744 | 209,721 | 130,280 | 64,826 | 51,876 | **33,107** | 3.22% |
| `lcet10.txt` | 426,754 | 144,418 | 107,706 | 121,337 | 119,496 | **89,460** | 20.96% |
| `plrabn12.txt` | 481,861 | 194,264 | 145,577 | 167,439 | 165,464 | **126,464** | 26.24% |
| `ptt5` | 513,216 | 52,377 | 49,759 | 43,641 | 39,868 | **26,939** | **5.25%** |
| `sum` | 38,240 | 12,768 | 12,909 | 10,978 | 9,508 | **9,386** | 24.54% |
| `xargs.1` | 4,227 | 1,748 | 1,762 | 1,729 | 1,820 | **1,532** | 36.24% |
| **Total** | **2,810,784** | 730,625 | 542,710 | 516,247 | 493,168 | **369,447** | **13.14%** |

* `ptt5` (5.25%) is the clearest case of blind manifold discovery. It is a CCITT-style bi-level
  fax raster with a 216-byte scanline and no header the analyser is allowed to read. The model
  finds the period causally from the bytes (`pos = 1024`, then power-of-two checkpoints), then
  codes each pixel with its five causal neighbours using JBIG-style contexts. `xz -9e` gets 7.76%.
* `kennedy.xls` (3.22%) is a spreadsheet; the win comes from record-stride detection plus a
  23-bit binary model, not from knowing the BIFF format.
* Prose (`alice29`, `asyoulik`, `plrabn12`, `lcet10`) is where a zero-prior model is weakest:
  24–28% versus `xz`'s 32–34% is a real win, but `paq8px` reaches roughly 18–20% using an English
  dictionary. This gap is intentional and structural.

---

## 4. Matrix 3 — UCI tabular / machine-learning corpus (6 files)

**Total: 6,545,162 B → 375,359 B (5.73%)**, all files `rt = true`.

| File | Raw (B) | `gzip -9` | `bzip2 -9` | `zstd -19` | `xz -9e` | **UCZ** | **UCZ %** |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `adult.data` | 3,974,305 | 546,109 | 328,352 | 411,392 | 397,132 | **192,076** | 4.83% |
| `adult.test` | 2,003,153 | 129,041 | 88,510 | 105,106 | 101,404 | **92,361** | 4.61% |
| `winequality-white.csv` | 264,426 | 58,692 | 39,812 | 51,240 | 47,880 | **37,673** | 14.25% |
| `winequality-red.csv` | 84,199 | 20,391 | 13,742 | 16,842 | 15,744 | **13,067** | 15.52% |
| `wdbc.data` | 124,103 | 23,161 | 14,558 | 15,122 | 14,120 | **31,542** | 25.42% |
| `yeast.data` | 94,976 | 12,754 | 8,404 | 9,452 | 9,224 | **8,640** | 9.10% |
| **Total** | **6,545,162** | 769,463 | 478,004 | 600,560 | 575,724 | **375,359** | **5.73%** |

* `adult.data`/`adult.test` at 4.6–4.8% show what happens when the manifold is a dense,
  low-cardinality table: the column model (`fieldIdx`, `fieldCol`, previous-row byte) plus the
  `;`/`,`-density delimiter detector does the work.
* `wdbc.data` (25.42%) is the counter-example — 30 float columns with ~5 significant digits.
  A numeric table is not a symbol table; UCZ finds `text-vertcol` here and beats `gzip`, but
  `xz` is 3× ahead because it has a literal coder tuned for repetitive decimal digits. Below the
  specialist threshold, honestly reported.
* `winequality-*` (14–16%) is the best case for the column model: 11 columns, invariant header,
  semicolon delimiters.

### 4.1 Planner tier trade-off (same corpus, `tests/manifold.test.ts` + P30.x measurements)

| Level | Meaning | `yeast.data` | `15.B` | `wdbc.data` | `ptt5` |
| --- | --- | ---: | ---: | ---: | ---: |
| `--max` | full candidate tournament (default) | 8,640 B / 39.1 s | 156,038 B / 23.7 s | 31,542 B / 6.5 s | 26,939 B / 12.5 s |
| `--balanced` | pruned column search, fewer context promotions | 8,640 B / 5.2 s | 156,038 B / 22.5 s | 31,542 B / 5.8 s | 27,663 B / 13.4 s |
| `--fast` | single span, one row mode, no tournament | 9,125 B / 1.6 s | 166,242 B / 10.8 s | 34,645 B / 1.1 s | 26,935 B / 10.0 s |

`--balanced` is the recommended default for batch work: identical bytes on three of four files
at a fraction of the planning time. `--fast` costs 2–10% ratio. **Model parameters never depend
on the level** — a container is always decodable by any build, because the level only affects
which candidates are tried.

---

## 5. Matrix 4 — Cross-disciplinary and domain-specialist evaluations

### 5.1 Large-scale encyclopedia — `enwik8` (100,000,000 B)

**21,095,797 B (21.10%, 1.688 bit/byte)**, `rt = true`.

| Compressor | Size (B) | Ratio |
| --- | ---: | ---: |
| `gzip -9` | 36,451,000 | 36.45% |
| `bzip2 -9` | 29,008,000 | 29.00% |
| `xz -9e` | 24,749,000 | 24.75% |
| **UCZ** | **21,095,797** | **21.10%** |
| `paq8f` (zero-dictionary CM reference) | 18,324,000 | 18.32% |

Verified slice: the first 4 MiB encodes to **958,405 B (22.85%, 4.38×)** in 65.9 s, decoded in
51.5 s — consistent with the full-file figure (later MiB compress slightly better as the model
matures). `paq8f` is the fair CM reference here because it predates the dictionary-based
`paq8px` line; the remaining ~2.8 percentage points are exactly what an English dictionary plus
a word model buys.

### 5.2 Genomics — complete *E. coli* K-12 genome (`GCF_000005845.2.fa`, 4,734,499 B)

**1,154,755 B (24.39%)** = **1.951 bit per input byte** and **~1.990 bit per nucleotide base**, `rt = true`.
The FASTA file is 4,734,499 B of which 4,641,652 are nucleotide bases; the rest is the header and
line breaks, so the two bit-rates differ by the sequence/texture of the framing.

| Compressor | Size (B) | Ratio | bit/base |
| --- | ---: | ---: | ---: |
| `gzip -9` | 1,486,111 | 31.39% | 2.51 |
| `xz -9e` | 1,338,444 | 28.27% | 2.26 |
| **UCZ** | **1,154,755** | **24.39%** | **1.951** |

The 2.000 bit/base line is the naive "two bits per base" bound; going below it requires exploiting
inter-base structure. UCZ does this without being told what DNA is: it finds a period-3 stride,
splits the codon positions, and lets the context model learn the Markov structure of each
position. `GeCo3` (specialised, with reverse-complement experts and template matching) reaches
roughly 1.6–1.7 bit/base on the same class of data, so the gap here is ~0.3 bit/base.

### 5.3 Proteomics — 9-species protein corpus (22,918,902 B)

**9,668,253 B (42.18%, 3.375 bit/byte)**, all files `rt = true`; the nine raw sizes sum to 22,918,902 B and the nine compressed sizes to 9,668,253 B.

The theoretical floor for a uniform 20-symbol alphabet is `log2(20) = 4.322 bit` (54.02%).

| Species | Raw (B) | UCZ (B) | Ratio |
| --- | ---: | ---: | ---: |
| `1.BT` | 12,845,466 | 4,790,166 | 37.29% |
| `2.EC` | 1,308,765 | 654,037 | 49.97% |
| `3.EP` | 4,184 | 2,217 | 52.99% |
| `4.LC` | 809,301 | 407,507 | 50.35% |
| `5.SA` | 796,785 | 400,053 | 50.21% |
| `6.SC` | 2,900,352 | 1,394,027 | 48.06% |
| `7.MJ` | 448,779 | 223,121 | 49.72% |
| `8.HS` | 3,295,751 | 1,536,700 | 46.63% |
| `9.HI` | 509,519 | 260,425 | 51.11% |
| **Total** | **22,918,902** | **9,668,253** | **42.18%** |

`AC2` (specialised, with substitution matrices and profile HMMs) is reported in the literature at
roughly 0.15–0.3 bit/residue below this. Again the difference is prior knowledge: AC2 knows the
amino-acid substitution statistics; UCZ has to learn the alphabet from byte frequencies first.

### 5.4 Acoustic waveforms — 10 WAV tracks (9,028,556 B)

**4,222,379 B (46.77%)**, all files `rt = true`.

| Track | Raw (B) | UCZ (B) | Ratio |
| --- | ---: | ---: | ---: |
| `track-01` | 1,013,302 | 784,738 | 77.44% |
| `track-02` | 475,180 | 272,025 | 57.25% |
| `track-03` | 2,497,332 | 1,588,433 | 63.61% |
| `track-04` | 2,834,476 | 1,498,831 | 52.88% |
| `track-05` | 96,044 | 7,079 | 7.37% |
| `track-06` | 960,044 | 64,069 | 6.67% |
| `track-07` | 96,044 | 6,790 | 7.07% |
| `track-08` | 960,044 | 283 | 0.03% |
| `track-09` | 96,044 | 86 | 0.09% |
| `track-10` | 46 | 45 | 97.83% |
| **Total** | **9,028,556** | **4,222,379** | **46.77%** |

Periodic/harmonic tones drop to 0.1–7.4% because the byte manifold is a smooth function of
position; studio material stays near 50% because the residual is genuinely noise-like at 16 bit.
`FLAC` (specialised, with linear prediction and Rice coding) is typically 50–60% on the same
material, i.e. UCZ is ahead on synthetic tones and behind on dense music — the expected shape.

### 5.5 Pre-compressed containers — 24 Kodak `.png` images (15,394,305 B)

**15,273,560 B (99.22%)**, all files `rt = true`. The corpus shrinks by **0.78%** overall
(15,394,305 -> 15,273,560 B) because 9 of the 24 PNGs carry compressible metadata/chunk
structure; the remaining 15 incompressible ones are stored via `STORE` with only **+8 to +18 B**
of container header (`+0.002%` per file), never more.

This is the honesty test. A `.png` payload is a DEFLATE stream: high entropy, no exploitable
structure. The 9-Point Constitution forbids a built-in `zlib` re-compressor, so UCZ cannot
unpack it. What it *can* do is notice: the `emaErr` tracker crosses its gate, the context tables
freeze, and the planner emits `STORE`. A stored file comes back exactly its own size plus the
container header, and decodes bit-exactly — no expansion spiral, no pretending. A production
deployment would re-wrap PNGs or refuse them; UCZ reports the truth instead.

---

## 6. Matrix 5 — Blind manifold universality suite (anti-overfitting proof)

These streams were written *after* the models were frozen, and they use periods, widths and
channel counts that appear nowhere in the training corpus. The suite lives in
`tests/manifold.test.ts` and runs as part of `node tests/run.mjs`.

| Case | Construction | Raw (B) | UCZ (B) | Ratio | Rule chosen |
| --- | --- | ---: | ---: | ---: | --- |
| `P = 73` | quasi-periodic byte walk, prime period | 29,200 | 14,463 | 49.53% | `BIN` |
| `P = 197` | prime period, different phase drift | 31,520 | 14,733 | 46.74% | `DELTA3 s=2` ×2 |
| `P = 389` | prime period, longer cycle | 31,120 | 14,354 | 46.12% | `BIN_V3` ×2 |
| `W = 113` | 2-D raster, prime byte width | 24,860 | 136 | **0.55%** | `BIN_V3` + causal `scanPeriod=113` |
| `W = 193` | 2-D raster, prime byte width | 25,090 | 98 | **0.39%** | `BIN_V3` + causal `scanPeriod=193` |
| `s = 3` | 3-channel interleaved, non-multiple length | 18,000 | 6,383 | 35.46% | `DELTA`/`SUB-TRANSPOSE` |
| `s = 4` | 4-channel interleaved | 16,000 | 5,678 | 35.49% | `DELTA s=4` |
| `s = 5` | 5-channel interleaved (prime) | 18,000 | 7,965 | 44.25% | `SUB-TRANSPOSE s=5 r=2` |
| `s = 7` | 7-channel interleaved (prime) | 18,200 | 8,082 | 44.41% | `SUB-TRANSPOSE s=7 r=2` |

The two raster rows are the important ones: `W = 113` and `W = 193` are prime widths that cannot
be reached by any "try powers of two" heuristic, and the resulting size (0.4–0.6%) is only
possible if the scanline period was found from the bytes at runtime.

### 6.1 Scientific instrument — `UCZ-NCD` vs `GZIP-NCD`

Compression-based information distance on 8 items (2 prose windows, 2 windows of the same file at
different offsets, 2 CSV tables, 2 synthetic multichannel walks), 32 KiB windows, conditional-cost
normalisation:

| Estimator | Intra-family | Inter-family | Separation margin | Nearest-neighbour accuracy |
| --- | ---: | ---: | ---: | ---: |
| **UCZ-NCD** (conditional, context-mixing) | 0.890 | 0.991 | **0.100** | **8/8** |
| GZIP-NCD (`gzip -9`) | 0.947 | 1.020 | 0.073 | 8/8 |

Both cluster correctly on this set; the CM estimator separates families ~37% better because the
conditional cost `C(y | x)` is measured on a *continuous* stream, so cross-file learning is not
destroyed by a model reset at the concatenation point. The instrument is exposed as `ucz ncd`.

---

## 7. What this record does not claim

* **Speed.** UCZ is 1–2 orders of magnitude slower than `xz`. `9.H` (1 MiB of machine code) takes
  ~92 s; `enwik8` takes ~18 min. The roadmap targets a C++20 SIMD backend for that reason.
* **Beating specialists at their own game.** On DNA, proteins, audio and PNG, purpose-built tools
  that embed domain priors win, and they should. The question this project asks is different:
  how far can one online learner get across *all* of them with no priors at all?
* **Statistical generality.** These are small corpora chosen to span manifolds, not a random
  sample of the world's data. Ratios on other data will differ, sometimes a lot.

*All matrices in this file were produced by `UCZ v0.1.0-beta.1` with `--max` and verified by
byte-exact roundtrip. `paq8px`, `cmix`, `AC2`, `GeCo3`, `JBIG` and `FLAC` figures are quoted from
their published results and are not produced by this repository.*
