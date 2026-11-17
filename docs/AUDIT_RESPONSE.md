# External audit — verification and disposition

Third-party review of `v0.1.0-beta.1`, checked claim by claim against this tree.
Everything below was reproduced (or refuted) with a runnable probe before any code
changed; probes were deleted afterwards.

| ID | Claim | Verdict | Action |
|----|-------|---------|--------|
| C-1 | `encodeCMContextDual` streams cannot be decoded standalone, and its `base` arm was serialised into containers | **TRUE (latent, P0 class)** | Fixed: dual streams are now pricing-only. The control payload is always an independent `encode(...)`, and no trial ever takes `fullDual.alt`. The sample-stage control price is also an independent encode, because a table-sharing stream mis-prices the baseline and biases the screen. |
| C-2 | `ID.BCJ` / `ID.BCJ_V2` could reach the `bin-stride4` context without the forward BCJ filter, while the decoder applies `bcjInv` | **TRUE** | Fixed: both ids are excluded from `contextProposalsForGroup` and `contextGroupCandidatesSync`; only `xform-bin` (which filters inside `joinForSpec`) may carry an x86 spec. |
| C-3 | `encodeCMDual(..., 'v20')` corrupts both arms | **TRUE but diagnostic-only** | `encodeCMDual`/`encodeGroupDual` have no production caller (verified: `encodeGroupDual` is referenced only by its own probe export), and no dual stream is serialised any more after the C-1 fix. Left as a probe API; documented here instead of silently changing its bits. |
| C-4 | 14-byte `wordpre` input loops forever and aborts V8 | **Partly stale, partly TRUE** | `wordPreChunkedInv` was deleted in P37.12, so the exact PoC now only throws `词元词典被截断`. The root cause (signed `<<` at `shift = 28`) was real: `getVar` now accumulates with float multiply and rejects non-safe integers, so a negative length can no longer walk `st.p` backwards. |
| H-2 | `isContainer` hard-codes `<= 23`, so `--checksum` containers (v24/v25/v27) are treated as raw input; CRC trailer counted as payload; `s = 0` NUL anchors rejected; trailing junk accepted | **TRUE** | Fixed: `isContainer` uses the shared `MAX_CONTAINER_VERSION` plus per-version length checks; `inspectContainer` excludes the CRC trailer (`bodyEnd`), requires the payloads to fill `bodyEnd` exactly, and accepts `0 <= s <= 255` for the anchor family. Regression added to `tests/edge.test.ts`. |
| H-1 | Fixed-size `bitcm`/`symTbl` allocations allow a 22–81 B container to allocate hundreds of MiB under `--max-output` | **TRUE, partially fixed** | Bit-plane history orders are now derived from the plane length (`bitCMOrdersFor`), so a 72-byte plane allocates a few KiB instead of 68 MiB (planes ≥ 1 MiB keep the historical `[16,20,24]`, so no reference byte moves). Non-FILL groups with zero payload are rejected, which kills the `22 B → 8 MiB` shape. `symTbl*` (68 MiB) and `--max-output`-bounded model allocation still need a real memory budget; tracked. |
| M-1 | `ncd` floors the prefix to 512 B (short inputs always score 1.0), treats `maxBytes: 0` as "empty", and the matrix disagrees with the pairwise mode | **TRUE** | Fixed: exact short-prefix conditional cost (`< 512 B` now scores 0.033 on two 495 B texts that differ in one byte, instead of 1.0), `maxBytes <= 0` means "do not truncate" (random noise now scores 0.997 instead of 0.0), still identity 0.000. |
| M-2..M-6 (`--json` schema, NCD report semantics, container-mode matrix, concurrency globals, model bounds) | Grouped claims about reporting/semantics | **Partially verified → fixed where real** | NCD semantics fixed with M-1; concurrency globals fixed in P37.7 (`withEncodeLock` + `poolSab`) and now guarded by `testConcurrentEncodeIsolation`; model bounds asserted by the new `testStrictContainerSpecs` (strict containers carry only `STRICT_FORBIDDEN_SPECS`-free transforms and are always v23, checksum containers v25/v27). `--json` keeps one top-level shape for both stream and container inputs. |
| L-1 (benchmark server, CLI details) | `benchmark/server.mjs` trusted `Host`/`Origin`/`Content-Length` and echoed `x-ucz-level` verbatim | **TRUE** | Fixed: loopback `Host` allow-list (421), same-origin `Origin` check (403), strict numeric `Content-Length` (400) with body-length agreement, busy state (429), and a `{fast,balanced,max}` whitelist so an attacker-controlled header is never echoed. Regression: `tests/bench-server.test.mjs`, wired into `tests/run.mjs`. |

## What changed in this commit

- `src/lib/codec.ts` — removed the serialised dual fast path (C-1, C-2), independent
  sample control price.
- `src/lib/wordpre.ts` — unsigned, bounded varints (C-4).
- `src/lib/inspect.ts` — shared version bound, CRC-aware `bodyEnd`, exact-fill
  payload check, anchor `s = 0` (H-2).
- `tests/edge.test.ts` — `isContainer`/`inspectContainer` coverage for v24/v25,
  trailer exclusion, trailing-junk rejection.

## Invariants held

Reference containers are byte-identical after the change (alice29 37,421 / ptt5
26,939 / kennedy 33,107 / wdbc 31,542 / winequality-white 37,497 / yeast 8,640, all
`rt = true`), `npx tsc --noEmit` is clean, and `node tests/run.mjs` exits 0.

## Follow-up audit (2026-11-17): decoder resource limits

A second external review focused on decoder denial-of-service and CLI resource
handling. The labels below are local (`F-*`) because the previous audit already
used `H-1`/`H-2` for different findings. Every item was reproduced before the
fix; probes and temporary containers were deleted afterwards.

| ID | Claim | Verdict | Action |
|----|-------|---------|--------|
| F-1 (review label H-1) | A 24-byte CM container can declare 8 MiB and decode for 11.5 s; a 512 MiB declaration extrapolates to minutes of CPU | **TRUE** | Root cause: `decodeCMImpl` returned `0` forever after the payload ended. The arithmetic decoder now permits at most 8 B of zero flush (valid corpus streams overread exactly 3 B) and throws `压缩载荷被截断（算术解码越界）`. The reproduced 19 B / 8 MiB bomb now fails in 24 ms instead of 5,860 ms. Regression in `tests/edge.test.ts`. |
| F-2 (review label H-2) | A 23-byte FILL container writes 512 MiB; the default limit is independent of input size and the whole result is buffered before writing | **TRUE** | The library's explicit 512 MiB hard cap is unchanged, but the CLI now applies a monotonic implicit budget: `min(512 MiB, max(64 MiB, 4096 × container size))`. A trusted high-ratio file can still be decoded with an explicit `--max-output`. The reproduced 21 B → 512 MiB case is refused before allocation/write; the opt-in path still works. Regression in `tests/cli.test.mjs`. |
| F-3 (review label H-3) | Default containers have no content checksum: 397/500 random mutations decode “successfully” with wrong bytes; CRC containers detect all 500 | **TRUE, not changed by default** | `checksum` remains opt-in because turning it on changes every container byte and the 26-file golden manifest. The tradeoff is now explicit: `inspect` prints `integrity CRC-32C` or `integrity none (pre-v24 container; silent corruption is not detectable)`, and `--checksum` stays documented. Verdict: known format tradeoff, not a silent assumption. |
| F-4 (review label M-1) | The library/CLI have no input cap; `readFileSync` OOMs on a 10 GiB file | **TRUE** | CLI now `stat`s before reading and refuses inputs above `MAX_INPUT_BYTES` (256 MiB) for data, or `MAX_OUTPUT_BYTES + 16 MiB` for containers. `--max-input N` is the explicit trusted-file override. A sparse 300 MiB file is rejected without allocation. Regression in `tests/cli.test.mjs`. |
| F-5 (review label M-2) | `max` throughput is unusably low (98 KiB in 85 s; 1 MiB decompress ≈ 1.5 s) | **TRUE, data-dependent** | Reproduced 100,352 B at `max` in 11.1 s (1,180 B container) and 1 MiB in 41.1 s (9,792 B container); decompress 152 ms / 1,515 ms. This is a planner-cost property, not a bug that can be fixed by a threshold without changing output. Mitigation: the Web UI now defaults to `balanced` (the CLI default) instead of `max`, so the 256 MiB queue no longer defaults to multi-hour jobs. `max` remains selectable. |
| F-6 (review label M-3) | `ucz inspect <container> --no-compress` throws a `TypeError` for every valid container | **TRUE** | `formatInspectionReport` now accepts reports without a fingerprint and guards the fingerprint block; `--no-compress` renders container anatomy, integrity status and elapsed time. `--json` shape is unchanged. Regression in `tests/cli.test.mjs`. |

### What changed

- `src/lib/coder.ts` — bounded arithmetic-decoder overread (`F-1`).
- `src/cli.ts` — `stat`-based input caps and `--max-input` (`F-4`), monotonic
  implicit decode budget with explicit `--max-output` override (`F-2`), inspect
  path uses the same budget.
- `src/lib/inspect.ts` — nullable-fingerprint report and integrity status
  (`F-3`, `F-6`).
- `src/App.tsx` — Web default tier is `balanced` (`F-5` mitigation).
- `tests/edge.test.ts`, `tests/cli.test.mjs`, `tests/concurrency.test.ts` —
  regressions for the CM bomb, input cap, FILL amplification, text inspect, and
  early corruption rejection.

### Invariants held

Reference containers remain byte-identical after the change (alice29 37,421 /
ptt5 26,939 / kennedy 33,107 / wdbc 31,542 / winequality-white 37,497 / yeast
8,640, all `rt = true`), `npx tsc --noEmit` is clean, `node tests/run.mjs` exits
0, `node tests/run-ui.mjs` passes 17/17, `npm run test:p111` passes, and
`npm run bench:quick` still totals 91,759 B versus gzip's 120,730 B.

## Follow-up review (2026-11-18): publishing and regression gates

A third review focused on the published TypeScript surface, benchmark gating,
and the strength of the resource-limit wording. All claims were reproduced.

| ID | Claim | Verdict | Action |
|----|-------|---------|--------|
| P-1 | The packed `dist/index.d.ts` uses extensionless relative imports, so a `moduleResolution: NodeNext` consumer cannot resolve the public API (`TS2834`, `TS2305`) | **TRUE** | `scripts/fix-dts-specifiers.mjs` rewrites the emitted declaration graph (`.js`, directory imports to `/index.js`) and fails on unresolved specifiers; `scripts/build-dist.mjs` runs it after `tsc`. `npm run check:package` packs the tarball, installs it into a fresh ESM project, and compiles a real NodeNext consumer with `skipLibCheck:false`; CI and release-check run that gate. |
| P-2 | `bench:quick` prints `❌` on a broken roundtrip but still exits 0, and has no size baseline | **TRUE** | Every stream is now SHA-256 verified; any mismatch exits nonzero. Per-stream raw size, corpus SHA-256, and UCZ bytes are locked in `scripts/bench-public-baseline.json`, so size drift also fails. `-- --update-baseline` is the explicit, reviewable way to accept a byte change. |
| P-3 | Resource-limit flags sound stronger than they are | **TRUE, documentation** | `--time-budget` is a cooperative planner deadline; `--memory-limit` caps worker admission and checks RSS before jobs, not a reservation; `--max-output` bounds the output buffer, not total RSS. CLI help and README now say this, and recommend an external memory/wall-clock limit for untrusted input. |
| P-4 | Dev build chain has high-severity `picomatch` advisories | **TRUE, dev-only** | `npm audit --omit=dev` is clean and the published package has no runtime dependencies. Latest `picomatch` is still in the advisory range, so no non-breaking upgrade fixes it yet; this is tracked as a build-chain advisory, not a shipped-code vulnerability. |
| P-5 | `inspectContainer` and `decompressImpl` duplicate the header parser | **TRUE, known debt** | Not changed in this pass; unifying them requires careful trailer/CRC handling. Both paths validate before allocating, and both are covered by the golden suite. |

### Invariants held

Declaration emission is idempotent (first pass 25/54 files, second 0/54), the
NodeNext consumer compiles, `npm run bench:quick` totals 91,759 B and passes its
locked baseline, `npx tsc --noEmit` is clean, `node tests/run.mjs` exits 0,
`node tests/run-ui.mjs` passes 17/17, and `npm run test:p111` passes. Reference
container bytes are unchanged.

