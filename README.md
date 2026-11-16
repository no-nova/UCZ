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
15,394,305 → 15,273,560 B: a container that is 0.003% larger than incompressible input and never
spirals. A zero-prior compressor that cannot re-inflate DEFLATE should say so, loudly and cheaply.

---

## Summary benchmarks

`--max` level, byte-exact SHA-256 roundtrip verified for every row. Full tables, per-file numbers
and mechanisms: **[BENCHMARKS.md](BENCHMARKS.md)**.

| Corpus | Raw (B) | UCZ (B) | Ratio | bit/byte | Industrial reference |
| --- | ---: | ---: | ---: | ---: | --- |
| Canterbury (11 files) | 2,810,784 | **369,447** | **13.14%** | 1.051 | `xz -9e` 493,168 (17.55%) |
| AITDCC (16 tracks, cross-manifold) | 38,289,319 | **17,053,803** | **44.54%** | 3.563 | mixed: 4 of 16 are incompressible |
| UCI tabular (6 files) | 6,545,162 | **375,359** | **5.73%** | 0.458 | `xz -9e` 575,724 (8.80%) |
| `enwik8` (100 MB) | 100,000,000 | **21,095,797** | **21.10%** | 1.688 | `xz -9e` 24,749,000 (24.75%) |
| *E. coli* K-12 genome | 4,734,499 | **1,154,755** | **24.39%** | **1.951** (≈1.990/base) | `xz -9e` 1,338,444 (28.27%) |
| Protein corpus (9 species) | 22,918,902 | **9,668,253** | **42.18%** | 3.374 | uniform-20 bound 4.322 |
| 10 WAV tracks | 9,028,556 | **4,222,379** | **46.77%** | 3.742 | synthetic tones 6.7–7.4% |
| 24 Kodak PNGs (honesty test) | 15,394,305 | **15,273,560** | **99.22%** | 7.938 | no expansion, no pretence |

Two numbers worth pausing on. The DNA row is **1.951 bit per input byte**, i.e. **~1.990 bit per
nucleotide base** once the FASTA header and line breaks are excluded from the denominator — still
**below 2.000 bit/base**, which is impossible
unless inter-base structure was found — and UCZ was never told what DNA, codons or
reverse-complement symmetry are. The PNG result is the opposite kind of honesty: a compressor
that cannot unpack DEFLATE should admit it in eight bytes, not invent a bad model.

Where specialists win, they win because they carry priors: `paq8px` reaches ~18–20% on Canterbury
prose using an English dictionary, `AC2` beats us on proteins with substitution matrices, `GeCo3`
beats us on DNA with reverse-complement experts, `FLAC` beats us on dense music. That is the
measurement this project exists to produce, not an embarrassment to explain away.

---

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
