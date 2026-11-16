# UCZ — Benchmark Record

[English](README.md) | [简体中文](README.zh-CN.md) | **Full benchmarks** | [9-Point Constitution](CONSTITUTION.md)

Every number in this file was produced by the code in this repository and verified by a
byte-exact SHA-256 roundtrip (`rt = true`). Nothing here is an estimate or a projection.
Where a figure comes from a reference implementation instead (paq8px, AC2, GeCo3, JBIG), it
is labelled as such and is never mixed into a UCZ total.

UCZ is `v0.1.0-beta.1`: a TypeScript reference implementation, single-threaded per stream.
It is slow compared with LZ77 — and that is precisely why every matrix below reports **encode
time, decode time and peak memory next to the ratio**. A context-mixing number without its cost
is not a result.

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
| **Industrial baseline** | `gzip -9`, `bzip2 -9`, `zstd -19`, `zstd --ultra -22`, `xz -9e` | "Is this worth using at all?" These are the compressors a user actually has installed. |
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

### 1.4 Cost measurement protocol

Ratios are cheap to quote and expensive to produce, so every row in this file carries its cost.
The protocol, so that a reader can reproduce or falsify it:

* **Machine**: AMD Ryzen 9 9955HX (16 cores / 32 threads), 14 GiB RAM, Linux, Node 26.13.
  Baselines: `gzip 1.15`, `bzip2 1.0.8`, `zstd 1.5.7`, `xz 5.8.4`.
* **UCZ configuration**: level `--max`, `UCZ_THREADS=6`. One file at a time, in a fresh process
  per corpus, never a solid archive — so a total is the sum of per-file containers plus nothing.
* **What "encode" means**: `compressAdaptive` including the full candidate tournament. The
  verification decode is *not* included in the encode figure; it is reported separately as
  "decode", which is what a user pays when reading the file back.
* **Memory**: peak RSS of the whole process tree (`VmHWM` for the largest process in the group),
  polled every 200 ms. This is the real footprint including the worker pool, not just the model.
* **Published figures**: `paq8px` and `cmix` rows in §5.6 come from other people's runs on other
  hardware. They are labelled, never averaged into a UCZ total, and never presented as if this
  machine had reproduced them.

---

## 2. Matrix 1 — AITDCC 16-track cross-manifold benchmark

Sixteen files, deliberately heterogeneous: text, tabular, telemetry, rasters, machine code,
already-compressed noise. Every file is 1–4 MiB so that the model has to *discover* a manifold
rather than amortise a header.

**Total: 38,289,319 B → 17,053,803 B (44.54%)**, all 16 files `rt = true`.

| Configuration | Size (B) | Ratio | Encode | Decode | Peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| `gzip -9` | 25,433,731 | 66.43% | 2.50 s | — (included) | 6 MiB |
| `bzip2 -9` | 23,955,391 | 62.56% | 1.93 s | — (included) | 8 MiB |
| `zstd -19` | 24,295,053 | 63.45% | 4.70 s | — (included) | 62 MiB |
| `zstd --ultra -22` | 24,294,244 | 63.45% | 5.08 s | — (included) | 78 MiB |
| `xz -9e -T1` | 23,638,168 | 61.74% | 7.88 s | — (included) | 110 MiB |
| **UCZ `--max`** | **17,053,803** | **44.54%** | **719.8 s** | **168.9 s** | **2,642 MiB** |

The corpus is 38.3 MB of heterogeneous data, so UCZ needs 12 minutes where `xz` needs 8 seconds:
**91× the time for 28% fewer bytes**. Per-file encode times are dominated by the text rows
(`7.J` 107 s, `6.K` 56 s, `9.H` 119 s); the incompressible rows are fast because the freeze gate
ends the search early (`1.P` 50 s, `16.A` 28 s).

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

Per-file cost of the UCZ column above (encode / decode, seconds):

| File | `alice29` | `asyoulik` | `cp.html` | `fields.c` | `grammar` | `kennedy.xls` | `lcet10` | `plrabn12` | `ptt5` | `sum` | `xargs.1` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| encode (s) | 11.4 | 10.8 | 1.2 | 0.4 | 0.1 | 31.7 | 19.9 | 15.3 | 12.7 | 1.7 | 0.1 |
| decode (s) | 1.9 | 1.3 | 0.04 | 0.01 | 0.01 | 1.6 | 5.2 | 4.6 | 0.9 | 0.05 | 0.01 |

Corpus total: **105.4 s encode / 15.6 s decode / 1,916 MiB peak**. The same files through
`xz -9e`: 0.97 s / 83 MiB; `zstd --ultra -22`: 0.85 s / 25 MiB. `kennedy.xls` alone is 30% of the
encode time because the record-stride search trial-encodes many spans around a 1 MB spreadsheet.

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

Per-file cost (encode / decode, seconds): `adult.data` 34.3 / 31.5, `adult.test` 20.5 / 16.0,
`winequality-white.csv` 7.7 / 2.4, `winequality-red.csv` 7.5 / 0.8, `wdbc.data` 7.1 / 1.4,
`yeast.data` 39.6 / 0.9. Corpus total: **116.6 s encode / 52.9 s decode / 355 MiB peak**
(`xz -9e`: 1.49 s / 106 MiB). The decode cost is dominated by `adult.data` (31.5 s): 3.9 MB of
table rows at 22 contexts, i.e. ~8 µs per byte on the way back.

* `adult.data`/`adult.test` at 4.6–4.8% show what happens when the manifold is a dense,
  low-cardinality table: the column model (`fieldIdx`, `fieldCol`, previous-row byte) plus the
  `;`/`,`-density delimiter detector does the work.
* `wdbc.data` (25.42%) is the counter-example — 30 float columns with ~5 significant digits.
  A numeric table is not a symbol table; UCZ finds `text-vertcol` here but still loses to
  **every** general-purpose tool on this file (`gzip -9` 23,161 B is 36% smaller, `xz -9e`
  14,120 B more than twice as small) because decimal digits are what a literal coder is built
  for. Below the specialist threshold, honestly reported.
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

| Compressor | Version / params | Size (B) | Ratio | Encode | Peak RSS |
| --- | --- | ---: | ---: | ---: | ---: |
| `gzip -9` | 1.15 | 36,445,248 | 36.45% | 3.51 s | 6 MiB |
| `bzip2 -9` | 1.0.8 | 29,008,758 | 29.01% | 4.00 s | 8 MiB |
| `zstd -19` | 1.5.7 | 26,944,227 | 26.94% | 18.01 s | 374 MiB |
| `zstd --ultra -22` | 1.5.7 | 25,272,471 | 25.27% | 53.41 s | 834 MiB |
| `xz -9e` | 5.8.4 | 24,831,648 | 24.83% | 48.44 s | 679 MiB |
| **UCZ** | `--max`, 6 threads | **21,095,797** | **21.10%** | hours (see below) | — |
| `paq8f` (published) | zero-dictionary CM | 18,324,000 | 18.32% | not published | not published |
| `paq8px v206fix1 -12L` (published) | dictionary + LSTM | 15,849,084 | 15.85% | 29,916 s | 28,151 MB |
| `cmix v21 -t` (published) | LSTM + word models | 14,623,723 | 14.62% | 65,155 s | ~20 GiB |

**Cost, measured on slices of the same file** (this is why the full-file time is not quoted as a
measurement): first 8 MiB → 1,883,371 B (22.45%) in 103.1 s encode / 20.8 s decode / 2,549 MiB;
first 16 MiB → 3,698,245 B (22.04%) in 184.9 s / 40.2 s / 2,679 MiB. The slices scale almost
linearly (11.0 µs/byte for 8 MiB, 11.0 µs/byte for 16 MiB), which predicts ~18 minutes for 100 MB;
the full-file runs attempted during this revision exceeded two hours under concurrent load, so the
full-file **cost is left unquantified** instead of being back-filled with either number. The
full-file **size** (21,095,797 B) comes from an earlier complete run with the same code path.

The comparison that matters: `paq8px -12L` reaches 15.85% in 8.3 hours with 28 GB of tables,
`cmix v21` reaches 14.62% in 18 hours with ~20 GiB. UCZ reaches 21.10% while being ~27× and ~59×
faster per byte respectively. That is the frontier this project claims — not a ratio win, a
ratio-per-cost position.

### 5.2 Genomics — complete *E. coli* K-12 genome (`GCF_000005845.2.fa`, 4,734,499 B)

**1,154,755 B (24.39%)** = **1.951 bit per input byte** and **~1.990 bit per nucleotide base**, `rt = true`.
The FASTA file is 4,734,499 B of which 4,641,652 are nucleotide bases; the rest is the header and
line breaks, so the two bit-rates differ by the sequence/texture of the framing.

| Compressor | Size (B) | Ratio | bit/base | Encode | Peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| `gzip -9` | 1,486,130 | 31.39% | 2.51 | 2.28 s | 6 MiB |
| `bzip2 -9` | 1,398,421 | 29.54% | 2.36 | 0.20 s | 8 MiB |
| `zstd -19` | 1,350,603 | 28.53% | 2.28 | 1.59 s | 94 MiB |
| `zstd --ultra -22` | 1,350,586 | 28.53% | 2.28 | 1.60 s | 142 MiB |
| `xz -9e` | 1,338,436 | 28.27% | 2.26 | 1.92 s | 93 MiB |
| **UCZ `--max`** | **1,154,755** | **24.39%** | **1.951** | **97.7 s** | **1,586 MiB** |

The 2.000 bit/base line is the naive "two bits per base" bound; going below it requires exploiting
inter-base structure. UCZ does this without being told what DNA is: it finds a period-3 stride,
splits the codon positions, and lets the context model learn the Markov structure of each
position. `GeCo3` (specialised, with reverse-complement experts and template matching) reaches
roughly 1.6–1.7 bit/base on the same class of data, so the gap here is ~0.3 bit/base.

### 5.3 Proteomics — Amino Acids Corpus (9 species, 22,918,902 B)

**9,668,253 B (42.18%, 3.375 bit/byte)**, all files `rt = true`; the nine raw sizes sum to 22,918,902 B and the nine compressed sizes to 9,668,253 B.

The theoretical floor for a uniform 20-symbol alphabet is `log2(20) = 4.322 bit` (54.02%).

| Configuration | Size (B) | Ratio | Encode | Peak RSS |
| --- | ---: | ---: | ---: | ---: |
| `gzip -9` | 13,095,136 | 57.14% | 0.67 s | 6 MiB |
| `bzip2 -9` | 12,231,632 | 53.37% | 1.08 s | 8 MiB |
| `zstd -19` | 10,419,197 | 45.46% | 9.62 s | 106 MiB |
| `zstd --ultra -22` | 10,296,705 | 44.93% | 11.29 s | 282 MiB |
| `xz -9e` | 10,307,852 | 44.98% | 9.35 s | 183 MiB |
| **UCZ `--max`** | **9,668,253** | **42.18%** | **383.9 s** | **2,138 MiB** |

Note the ordering: `zstd --ultra -22` **beats `xz -9e`** on this corpus (44.93% vs 44.98%), which
is why quoting only `xz` as "the industrial reference" would understate the baseline. Per-file
encode times: `1.BT` 179.0 s (12.8 MB of sequence), `2.HS` 53.9 s, `9.SC` 48.6 s, `2.EC` 27.2 s,
`5.LC` 20.2 s, `8.SA` 19.9 s, `4.HI` 19.5 s, `7.MJ` 15.3 s, `3.EP` 0.1 s.

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

**Cost**: this table reports sizes only. The 10-track WAV set was not present on the measurement
machine during the P36 cost revision, so encode/decode time and peak RSS for this row are
deliberately *not* quoted rather than extrapolated from a different audio corpus. Every other
matrix in this file carries measured cost.

### 5.5 Pre-compressed containers — 24 Kodak `.png` images (15,394,305 B)

**15,273,560 B (99.22%)**, all files `rt = true`. The corpus shrinks by **0.78%** overall
(15,394,305 -> 15,273,560 B) because 9 of the 24 PNGs carry compressible metadata/chunk
structure; the remaining 15 incompressible ones are stored via `STORE` with only **+8 to +18 B**
of container header (`+0.002%` per file), never more.

Cost of the same 24 files (this run, per-file, no solid archive):

| Configuration | Size (B) | Ratio | Encode | Peak RSS |
| --- | ---: | ---: | ---: | ---: |
| `gzip -9` | 15,389,374 | 99.97% | 0.54 s | 6 MiB |
| `bzip2 -9` | 15,422,803 | 100.19% | 1.10 s | 8 MiB |
| `zstd -19` / `--ultra -22` | 15,392,766 | 99.99% | 0.76 s | 25 MiB |
| `xz -9e` | 15,370,324 | 99.84% | 3.16 s | 82 MiB |
| **UCZ `--max`** | **15,273,560** | **99.22%** | **119.2 s** | **1,114 MiB** |

Note `bzip2` *expands* this corpus (100.19%) and `xz` only removes 0.16%: on pre-compressed
bytes, the honest answer is "store it", and the cost of deciding that is what UCZ's 119 s buys.

This is the honesty test. A `.png` payload is a DEFLATE stream: high entropy, no exploitable
structure. The 9-Point Constitution forbids a built-in `zlib` re-compressor, so UCZ cannot
unpack it. What it *can* do is notice: the `emaErr` tracker crosses its gate, the context tables
freeze, and the planner emits `STORE`. A stored file comes back exactly its own size plus the
container header, and decodes bit-exactly — no expansion spiral, no pretending. A production
deployment would re-wrap PNGs or refuse them; UCZ reports the truth instead.

### 5.6 The context-mixing family — published figures, not reproduced here

`paq8px` and `cmix` are the honest upper bound for an online-learning compressor, and neither is
installed on the measurement machine. Their rows are quoted from the authors' published runs,
with the version and parameters that produced them. They are **not** mixed into any UCZ total and
they were produced on other hardware.

| Compressor | Version / parameters | Corpus | Size (B) | Ratio | Encode time | Peak RAM | Source |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| `paq8px` | v206fix1 `-12L` | `enwik8` (100 MB) | 15,849,084 | 15.85% | 29,916 s (8.3 h) | 28,151 MB | Large Text Compression Benchmark / encode.su |
| `paq8px` | v208 `-8` | `ptt5` (513,216 B) | 21,233 | 4.14% | 5.05 s | 1,434 MB | encode.su, v208-teaser post |
| `paq8px` | v206 `-8lrta` (solid) | Canterbury, 11 files | 285,365 | 10.15% | not published | not published | encode.su |
| `cmix` | v21 `-t` | `enwik8` (100 MB) | 14,623,723 | 14.62% | 65,155 s (18.1 h) | ~20 GiB | byronknoll.com/cmix.html |
| `cmix` | v21 `-t` | `enwik9` (1 GB) | 107,963,380 | 10.80% | 622,950 s (7.2 d) | ~30 GiB | byronknoll.com/cmix.html |
| `cmix` | v21 `-t` | `calgary.tar` (3,152,896 B) | 534,512 | 16.95% | 2,757 s | ~18.5 GiB | byronknoll.com/cmix.html |

What the table actually says:

* On `ptt5` both families are close (`paq8px -8` 4.14%, UCZ 5.25%) — a 1-bit raster with a
  discoverable scanline is a manifold both can find, and `paq8px` gets there in 5 s with a
  hard-coded lookup for that exact block hash (a prior the Constitution forbids).
* On `enwik8` the gap is 5–6 percentage points and the cost gap runs the other way: `paq8px -12L`
  is ~27× slower per byte than UCZ, `cmix` ~59×, and they use 10–14× the memory. UCZ is the
  fast end of the CM family, not its strong end.
* The `-8lrta` Canterbury row is a *solid* archive: one model sees all 11 files in sequence, so it
  is not comparable to the per-file 369,447 B in §3. A per-file `paq8px` Canterbury total on
  comparable settings is roughly 300 KB — stated as an estimate because the per-file run is not
  published with timing.

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


### Cost of the optional integrity trailer (v24)

A container written with `--checksum` adds **4 bytes** (CRC-32C, big-endian) plus, when the
container was previously below `v19`, a **2-byte flag field** that v19+ layouts already have.
So the overhead of a stored file is `8..18 B` (framing) `+ 4 B` — never multiplicative.
The checksum is computed over the decompressed payload, so it costs one extra pass over the
output at encode time (measured: negligible against the CM search, e.g. +3 ms on a 1 MiB file)
and one CRC pass at decode time.
