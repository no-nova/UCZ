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
