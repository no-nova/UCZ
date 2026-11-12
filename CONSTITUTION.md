# UCZ Constitution / UCZ 宪法

> **Status:** binding scientific charter. Every codec change must preserve these articles.
> **Identity:** UCZ is a prior-free universal lossless compressor and an executable
> Solomonoff-induction / test-time-adaptation kernel. It learns only from the input
> bytes in front of it; it never carries a domain, language, format, or corpus prior.

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
