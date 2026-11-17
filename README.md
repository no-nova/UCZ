# UCZ (v0.1.0-beta.1)

**Universal Context-Mixing (Zero-Prior)** — an experimental zero-prior compression engine and
residual-entropy microscope, written in TypeScript.

What "zero-prior" means here, precisely: **zero external dictionaries, zero pretrained corpus
weights, zero filename or magic-byte sniffing, and zero format-specific pre-decompressors** (no
built-in zlib/PNG decoder, no tar/zip reader). UCZ operates through a finite, hand-designed family
of general structural transforms and context-mixing predictors that are selected online from the
input stream itself. The only thing it is told is that the input is a sequence of bytes.

[English](README.md) | [简体中文](README.zh-CN.md) | [Full benchmarks](BENCHMARKS.md) | [9-Point Constitution](CONSTITUTION.md)

---


### Integrity, budgets and determinism

```bash
ucz compress big.bin big.ucz --checksum          # v25/v27: 4-byte CRC-32C of the payload
ucz compress data.csv out.ucz --strict-zero-prior  # v23: no byte-class priors at all
ucz decompress big.ucz --max-output 2000000000   # refuse to allocate more than this
ucz compress big.bin out.ucz --time-budget 30 --threads 4 --memory-limit 4096
```

* **`--checksum`** appends a CRC-32C of the *decompressed* payload and tags the container
  `v25` (default priors) or `v27` (default priors + fresh match-distance state); with
  `--strict-zero-prior` it is `v24`. Decoding verifies it and fails with
  `container content check failed (CRC-32C)`.
  This detects **accidental corruption** (bit rot, truncated writes, bad transfers).
  It is **not authentication**: an attacker can recompute the checksum after editing the
  payload, and containers written without the flag (v1..v26 except v24/v25) carry no
  content checksum at all — the decoder cannot tell a tampered old container from a valid
  one.
* **`--memory-limit`** is enforced twice: it caps the worker count *and* every job checks
  the worker's resident set (`UCZ_RSS_LIMIT_MIB`) before it runs, so exceeding the budget
  produces `memory budget exhausted` instead of an OOM kill.
* **`--strict-zero-prior`** disables every prior that depends on byte *categories*
  (ASCII/printable tables, x86 call detection, gradient/bit-plane/anchor candidates,
  2-D scanline period). It is an ablation mode, not the default: on the reference corpora
  it costs between +1.6 % and +62 % bytes for the same file. Under strict the model also
  drops every value-dependent construction it cannot justify positionally: mod-2^16 linear
  prediction (`D16`), per-column `Z_256` differences, and the word/stem hashes of the text
  layouts. Exact invariance under a byte renaming is still *not* claimed — hash bins,
  quantisers and size-measured plan choice keep a small residual drift (measured on the
  synthetic invariance corpus: text 2.39 %, uniform noise 0.00 %, and 21.6 % for a linear
  ramp, where the permutation destroys the ramp itself). `tests/invariance.test.ts` asserts
  those measured bounds and that no forbidden transform appears in a strict container.
* **`--time-budget SECONDS`** returns the best plan found when the budget expires and marks
  the result `budgetTruncated`; the container is still valid and still decodes.
  **`--threads` / `--memory-limit`** cap workers using the exact model accounting in
  `cmModelBytes(nctx, bits)` (`src/lib/parallel.ts`): 25 contexts at 23 bits = 800.1 MiB,
  14 at 24 bits = 896.1 MiB — not the old flat 1024 MiB guess — so a
  limit below 800 MiB is rejected. The budget bounds the planner's **search**, not
  its arithmetic: it stops *starting* new candidate measurements and returns the best plan
  already priced, so a budgeted container is always complete and decodes (never a truncated
  stream). One model pass over one segment is atomic, so the worst case is "one baseline
  encode", not "the whole search". Measured here (`--max`, 16 cores): 95 KiB `yeast.data`
  38.8 s → 10.0 s at a 300 ms budget (8,640 → 9,125 B), 264 KiB `winequality-white.csv`
  8.8 s → 8.4 s (the baseline dominates), 1.0 MiB `kennedy.xls` 33.5 s → 33.4 s (a single
  1 MiB model pass dominates).
* **`--max-output BYTES`** refuses an oversized container
  (in the library: `maxOutputBytes`), and the decoder validates the whole header before it
  allocates the output buffer.

## The thought experiment

Most strong compressors are libraries of knowledge. `xz` knows LZ77 and range coding. `paq8px`
ships an English dictionary, a JPEG model, an x86 filter and dozens of hand-built contexts.
`zstd` trains on a corpus before it ever sees your file. All of that works — that is exactly why
everyone uses it.

UCZ asks a narrower, more academic question:

> What happens if a compressor is **strictly forbidden** from using built-in dictionaries,
> pretrained weights, file-header magic bytes, or format-specific pre-decompressors — and must
> learn every data manifold (tabular text, multi-channel telemetry, 2D periodic rasters, machine
> code, genomic sequences) **online, from scratch, from the bytes in front of it**?

The point is not to defeat those tools. It is to measure how much of their advantage comes from
*prior knowledge about the world* versus *universal online learning*, and to make that gap
inspectable rather than hidden. The rules that make the question well-posed are written down as
the [9-Point Constitution](CONSTITUTION.md); the measurements are in [BENCHMARKS.md](BENCHMARKS.md).

### The 9-Point Constitution, in one paragraph

No built-in dictionary or training corpus. No file-type sniffing for control flow — the analyser
may only look at byte statistics it computes itself. No format-specific pre-decompressors (no
`zlib` inside PNG, no `FlateDecode` inside PDF). No per-corpus tuning or magic constants tied to
a known file. Every candidate rule must be trial-encoded and compared by real byte count. Every
container must decode bit-exactly, or the plan is rejected. The decoder may never need information
the encoder did not write into the container. Cost estimates must be derived from actual encodes.
And the system must be honest about incompressible data: it may expand a stream by at most a
few bytes of framing.

---

## How it works — five manifolds, one learner

A UCZ encode is: **analyse → propose rules per region → trial-encode → keep the smallest ↦
coalesce → frame**. Everything below is chosen by measurement at run time, not by file extension.

### 1.1 Tabular and symbolic text

The workhorse is `text-vertcol`, a 22-context model that keeps a live picture of the *table
structure* it is reading: current line, current field index and offset, the byte at the same
field/offset on the previous row, the current/previous word, a 6-cell character-shape mask, a
prefix stem and terminal suffix, and 5/6-grams. A delimiter set is learned, not assumed (`\t`,
`,`, `:`, and `;` once semicolons dominate the stream). A high-entropy freeze gate (`emaErr`)
stops the column tables being poisoned by embedded noise.

### 1.2 Multi-channel signals

Record-stride detection (`s = 2…64`, three independent windows, power-law normalisation) splits
interleaved channels; `TRANSPOSE` / `TRANSPOSE_GROUP` / `SUB_TRANSPOSE` reorder them, `DELTA`
removes the channel's own lag, and the residual is coded by a 12–13 context binary model with a
two-generation match model.

### 1.3 Quasi-periodic signals and 2D rasters

`BITPLANE` decomposes a stationary-period signal into bit planes (`5.L`: 4.37%). For bi-level
rasters the model finds the scanline period **causally** at runtime — checkpoints at `pos = 1024`
and at powers of two, a non-trivial-match census, a flat-byte gate, and a `bestP ≥ 32` floor —
then codes each pixel against its five causal neighbours with JBIG-style contexts. That is how
`ptt5` (a fax raster with a 216-byte line and no readable header) reaches 5.25%.

### 1.4 Machine code

`BCJ_V3` is a causal relative-jump transform with a sign-byte guard, feeding a 25-context model
whose extra slots bridge `disp32` immediates and `ModRM` fields (`9.H`: 29.13% on a 1 MiB ELF).
Nothing in the code knows what x86 is; the transform and contexts are chosen because they encode
smaller.

### 1.5 The high-entropy freeze gate

When the running prediction error says "this region is noise", context tables stop training, the
column model freezes, and the planner falls back to `STORE`. On 24 Kodak PNGs the result is
15,394,305 → 15,273,560 B (99.22% overall; on the 15 purely incompressible images, `STORE` adds
only 8–18 bytes / ~0.002% of framing and never spirals). A zero-prior compressor that cannot
re-inflate DEFLATE should say so, loudly and cheaply.

---

## Summary benchmarks

`--max` level, byte-exact SHA-256 roundtrip verified for every row. Full tables, per-file numbers
and mechanisms: **[BENCHMARKS.md](BENCHMARKS.md)**.

A context-mixing ratio without its cost is advertising. Every row below therefore carries encode
time, decode time and peak memory, measured on one machine with one protocol: AMD Ryzen 9 9955HX
(16 cores / 32 threads), 14 GiB RAM, Linux, Node 26.13, `UCZ_THREADS=6`, files compressed one at a
time (never as a solid archive), peak RSS from `VmHWM`, `gzip 1.15`, `bzip2 1.0.8`,
`zstd 1.5.7`, `xz 5.8.4`.

### Ratio (% of the raw bytes — lower is better)

| Corpus | Raw (B) | `gzip -9` | `bzip2 -9` | `zstd -19` | `zstd --ultra -22` | `xz -9e` | **UCZ `--max`** |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Canterbury (11 files) | 2,810,784 | 26.00% | 19.31% | 18.37% | 18.37% | 17.54% | **13.14%** |
| UCI tabular (6 files) | 6,545,162 | 11.76% | 7.30% | 9.18% | 9.18% | 8.80% | **5.73%** |
| AITDCC (16 tracks, cross-manifold) | 38,289,319 | 66.43% | 62.56% | 63.45% | 63.45% | 61.74% | **44.54%** |
| Amino Acids Corpus (9 species) | 22,918,902 | 57.14% | 53.37% | 45.46% | 44.93% | 44.98% | **42.18%** |
| *E. coli* K-12 genome | 4,734,499 | 31.39% | 29.54% | 28.53% | 28.53% | 28.27% | **24.39%** |
| 24 Kodak PNGs (honesty test) | 15,394,305 | 99.97% | 100.19% | 99.99% | 99.99% | 99.84% | **99.22%** |
| `enwik8`, first 8 MiB | 8,388,608 | 36.84% | 29.18% | 28.20% | 28.20% | 27.46% | **22.45%** |
| `enwik8`, first 16 MiB | 16,777,216 | 36.87% | 29.27% | 27.58% | 27.37% | 26.71% | **22.04%** |

### Cost of that ratio (same machine, same files)

| Corpus | UCZ encode | UCZ decode | UCZ peak RSS | `xz -9e` encode | `zstd -22` encode | `zstd -22` peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Canterbury | 105.4 s | 15.6 s | 1,916 MiB | 0.97 s | 0.85 s | 25 MiB |
| UCI tabular | 116.6 s | 52.9 s | 355 MiB | 1.49 s | 1.51 s | 76 MiB |
| AITDCC | 719.8 s | 168.9 s | 2,642 MiB | 7.88 s | 5.08 s | 78 MiB |
| Amino Acids Corpus | 383.9 s | 85.5 s | 2,138 MiB | 9.35 s | 11.29 s | 282 MiB |
| *E. coli* K-12 | 97.7 s | 13.9 s | 1,586 MiB | 1.92 s | 1.60 s | 142 MiB |
| 24 Kodak PNGs | 119.2 s | 15.5 s | 1,114 MiB | 3.16 s | 0.76 s | 25 MiB |
| `enwik8` 8 MiB | 103.1 s | 20.8 s | 2,549 MiB | 2.33 s | 2.69 s | 146 MiB |
| `enwik8` 16 MiB | 184.9 s | 40.2 s | 2,679 MiB | 5.54 s | 4.96 s | 284 MiB |

Read the two tables together. On Canterbury UCZ is 13.14% at **105 s encode** while `xz -9e` is
17.54% at **0.97 s**: xz is ~108× faster, UCZ is 25% smaller. That trade is the whole product.
Per byte on `enwik8`, UCZ is roughly 27× faster than `paq8px -12L` and 59× faster than `cmix v21`
while landing 6.2 and 7.4 percentage points above them — that is the speed/ratio frontier this
project occupies. Full `enwik8` (100 MB) lands at 21,095,797 B (21.10%); its wall-clock is *not*
quoted here — the 8/16 MiB slices above measure ~11 µs/byte, which linearly predicts ~18 minutes
for 100 MB, but the full runs we attempted exceeded two hours on a contended machine. The slices
are the measurement; the extrapolation is labelled as one.

### Position in the CM family (published figures, not measured here)

| Compressor | Version / parameters | Corpus | Size (B) | Ratio | Encode time | Peak RAM | Source |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| **UCZ** | `0.1.0-beta.1`, `--max`, 6 threads | Canterbury (11 files, per-file) | 369,447 | **13.14%** | 105 s | 1.9 GiB | this repo, measured above |
| **UCZ** | same | `enwik8` first 16 MiB | 3,698,245 | **22.04%** | 185 s | 2.6 GiB | this repo, measured above |
| `paq8px` | v206fix1 `-12L` | `enwik8` (100 MB) | 15,849,084 | 15.85% | 29,916 s (8.3 h) | 28,151 MB | LTCB entry, encode.su |
| `paq8px` | v208 `-8` | `ptt5` (513,216 B) | 21,233 | 4.14% | 5.05 s | 1,434 MB | encode.su (v208-teaser) |
| `paq8px` | v206 `-8lrta` (solid archive) | Canterbury, 11 files | 285,365 | 10.15% | not published | not published | encode.su |
| `cmix` | v21 `-t` | `enwik8` (100 MB) | 14,623,723 | 14.62% | 65,155 s (18.1 h) | ~20 GiB | byronknoll.com/cmix.html |
| `cmix` | v21 `-t` | `calgary.tar` (3,152,896 B) | 534,512 | 16.95% | 2,757 s | ~18.5 GiB | byronknoll.com/cmix.html |

Caveats, stated rather than buried: the `paq8px` and `cmix` rows were produced by other people on
other hardware, `paq8px -8lrta` is a *solid* archive (one model over all files) so it is not
comparable to per-file totals, and both carry priors the Constitution forbids here (English
dictionary, format models, hand-written image/x86 detectors). The gap they open on text —
15.8% vs 22.0% on enwik8 — is what a dictionary plus 28 GB of tables buys; the cost is 2–3 orders
of magnitude in time and 10× in memory.

Where specialists win, they win because they carry priors: `paq8px` reaches ~15–18% on English text
with a dictionary, `AC2` beats us on proteins with substitution matrices, `GeCo3` beats us on DNA
with reverse-complement experts, `FLAC` beats us on dense music. That is the measurement this
project exists to produce, not an embarrassment to explain away.

## Scientific instruments

UCZ ships two instruments that use the same zero-prior machinery to *describe* data.

### `ucz inspect` — residual entropy microscope

```
$ ucz inspect ptt5

=== UCZ Residual Information Microscope ===
bytes                 513216
H0 entropy            1.210 bit/byte
printable ASCII       1.75 %
flat bytes 00/FF      89.21 %
record stride s       -
lag candidates        216
scanline period P     216
manifold class        2d-periodic-raster
evidence              scanPeriod confirmed by lag census | flat=89.2% text=1.8% | scanPeriod=216 | lagCandidates=216

residual H(x|x<)     min 0.003 / mean 0.548 / max 3.151 bpb  (block 512 B)
sparkline             ▁▁▁▁▁▁▄▃▃▂▁▁▂▂▂▂▂▂▂▂▂▂▃▃▃▃▃▃▂▁▁▁   (0 bpb ▁ -> 8 bpb █)
anomalies             47 bin(s)
  @    53760  len  512  1.774 bpb  regime-shift
  @    54272  len  512  2.483 bpb  entropy-spike
  @    55808  len  512  2.899 bpb  entropy-spike
  ... 39 more
```

The sparkline is the *prequential predictive code cost* `-log2 P(x_t | x_{<t})` measured by the
model itself, not by a histogram: each bin is what the model actually paid for those bytes given
only the bytes before them. A ruler with a ruler's honesty: the periodic scanline is flat and
cheap, the annotated headline block is expensive, and the instrument says where.

### `ucz ncd` — zero-prior information distance

`ucz ncd` reports a **bounded, symmetrised conditional-complexity dissimilarity**: each direction
is the prequential cost of one input given the other, divided by the cost of the input alone, with
the self-renewal floor subtracted and the result clamped to `[0, 1]`. It is not a metric in the
strict sense, and it is not a distance between "formats" — it is measured on bytes.

```
$ ucz ncd alice29.txt asyoulik.txt kennedy.xls

=== UCZ Zero-Prior NCD Distance Matrix ===
                    0       1       2
alice29.txt    0.0000  0.9197  0.9943
asyoulik.txt   0.9197  0.0000  0.9943
kennedy.xls    0.9943  0.9943  0.0000

Nearest neighbour:
  alice29.txt  → asyoulik.txt  (NCD=0.9197)
  kennedy.xls  → asyoulik.txt  (NCD=0.9943)
```

Normalised compression distance with a *conditional* cost that keeps the model warm across the
concatenation point. On a mixed 8-item set it separates families with a 0.100 margin versus
0.073 for `gzip`-based NCD, at 8/8 nearest-neighbour accuracy.

---

## Zero-prior ablation (`--strict-zero-prior`)

The default engine holds a finite, hand-designed family of *content* priors — an x86
`E8/E9` transform, ASCII column/word contexts, a bitmap scanline detector. They are
worth 8.08 % on Canterbury+UCI (744,806 → 804,966 B) and up to +62.5 % on a fax bitmap,
so they are measured, not assumed. `--strict-zero-prior` disables every one of them and
restricts the planner to raw byte lags, position, equality and length, marked by
container version 23. `PRIOR_REGISTRY.md` lists each component, its ablated cost and
whether strict mode removes it; `CONSTITUTION.md` §"Strict-profile invariance" states
exactly what the flag does and does not guarantee.

## Quick start

```bash
npm install
npm run build          # worker bundle + dist/cli.js + dist/index.js

# CLI
node dist/cli.js compress notes.txt          # -> notes.txt.ucz
node dist/cli.js decompress notes.txt.ucz    # -> notes.txt
node dist/cli.js inspect notes.txt           # residual microscope
node dist/cli.js ncd a.csv b.csv c.csv       # distance matrix

# Web workbench (local)
npm run build:web && npx vite preview --outDir dist/web

# Release artifact: one self-contained HTML file (no server, no sibling files)
npm run release:html   # -> dist/ucz-v0.1.0-beta.1.html + .sha256

# Programmatic API
node --input-type=module -e "
  import { compressAdaptive, decompress } from './dist/index.js'
  const bytes = new Uint8Array([/* ... */])
  const { container } = await compressAdaptive(bytes)
  const back = decompress(container)   // identical bytes, always
"
```

Planner levels: `--fast` (1 span, one row mode, no tournament), `--balanced` (recommended default;
identical bytes to `--max` on most files, ~4× faster planning), `--max` (full candidate
tournament). The level never changes model parameters, so any container decodes with any build.

```bash
npm run bench:quick    # 6 self-verifying streams, ~7 s
node tests/run.mjs     # full suite: plan ledger, roundtrip, edge cases, CLI, manifold suite
```

---

## Roadmap

* **v0.1.x — TypeScript reference.** Correctness, instruments, and the benchmark record above.
  Speed is not a goal at this stage; the planner is deliberately exhaustive.
* **v0.2.0 — C++20 SIMD backend.** Port the mixing layer and table primitives, keep the planner
  and container format identical so v0.1 containers keep decoding. Target: 5–10× on encode,
  10–20× on decode.
* Beyond that: a streamable variant (the model is already causal), and a proper arithmetic coder
  with 32-bit renormalisation instead of the current 12-bit probability path.

---

## License and acknowledgments

**MPL-2.0** — see [LICENSE](LICENSE).

UCZ stands on a long line of published work, and the comparison points in
[BENCHMARKS.md](BENCHMARKS.md) exist because those systems are good:

* **Context mixing** — Matt Mahoney's `paq` family (and `paq8px`, maintained by the paq8px
  contributors) and Byron Knoll's `cmix`, which established that logistic mixing of many weak
  predictors beats any single strong one.
* **Domain specialists** — `AC2` (proteins), `GeCo3` (DNA), `JBIG`/`JBIG2` (bi-level images),
  `FLAC` (audio), `xz`/LZMA (general purpose). Their ratios are the bar this project measures
  itself against, and the places where they win are documented rather than omitted.
* **The idea of universality** — Solomonoff, Kolmogorov, Rissanen (MDL), and Wallace & Boulton's
  MML: the notion that a compressor which learns everything online is a model of induction, not
  just a file utility.

This is a research toy with a rigorous test suite. If it is useful, it is useful as a measuring
instrument for the question in the first section.
