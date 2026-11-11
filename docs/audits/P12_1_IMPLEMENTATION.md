# P12.1 — versioned reversible transforms

P12.0 checkpoint: `f19e4d5`. Locked full-file baseline remains **41,814,147 B / 12 PASS** (user-local, not remeasured). No full Silesia file was compressed here.

## Format and implementation

- **v20 / uint16 flag `0x0800`** authorizes the new transforms. It does **not** change CM semantics. P12.2 must use a separate kernel flag. v18/v19 flag widths and old v19 mht4 behavior remain explicit; v20 uses fixed mht4 sizing, including when only low table flags are present. No `r` bit is repurposed (`r=8192` remains valid).
- WIDE_GRAD s3/s4/s5: true unsigned LE16 MED / `clamp16((3a+3b-2c+2)>>2)` / `(a+b)>>1`. Row-zero predicts left, column-zero predicts up. Wrapped 16-bit residuals are interleaved; CM uses res2d(s=2,r=rowBytes). Each region must have even length.
- s6/s7/s8: grad332 / average / MED signed wrapped residual, 16-bit ZigZag, high plane then low plane. Payload is `varint(compressedHighBytes) || highCM || lowCM`; high uses res(1,1), low res2d(1,rowBytes/2). Predictor resets per segment, CM is shared across same-plane segments. Existing WIDE row a2 suppression remains symmetric.
- Wide spatial trials include s1..s8. New modes only propose an alternative: the original wide/multi-segment plan is fully encoded first; a whole-input new-mode candidate replaces it **only if its complete UCZ is strictly smaller**. Equal/larger/error retains the baseline.
- BCJ3 s1 is unchanged; s2 is MSB-filtered E8/E9, modulo-25-bit position arithmetic and bit-24 sign extension. Both candidate and v15 group paths use the same transform and exact header-aware costs.
  - Reversibility detail: every scanned rel32 operand consumes four bytes, **including a filter rejection**. Skipping only converted operands is unsafe: a nested E8 can modify an earlier rejected MSB and change inverse eligibility. Dedicated nested-opcode/nonzero/wrapped-base tests cover this case. This is not an x86 disassembler.
- TG3 planning uses a stride-aligned 65,536-byte window instead of 16,000 when the largest contiguous segment is at least 131,072 bytes. DP includes span-4/8 carry-preserving LE uint32/uint64 differences, with both orientations. New inner modes are 7/8, legal only under v20 transform permission. Partial final words copy through; history resets at segment seams. Complete selected channels must beat STORE, BIN and byte-DELTA, charging actual lengths and new flag overhead; otherwise they revert.
- Worker bundle rebuilt. Fourteen small v20/legacy-CM fixtures are frozen in `tests/p121-fixtures.json` for independent P12.2 compatibility testing; never regenerate them under the new kernel.

## Measured 256 KiB single-group containers

These are **forced group comparisons**, not full `compressAdaptive` routing or full-file gains. All inputs are SHA-identified fixed windows. Each WIDE/BCJ row includes real base/v15 comparison and complete UCZ bytes. TG rows explicitly select v15 to fit the process budget.

| Slice / comparison | P12.0 control B | New B | Delta B | Delta % |
|---|---:|---:|---:|---:|
| mr-mid / best old WIDE → best tested new WIDE (s6) | 55,850 | 49,259 | -6,591 | -11.801 |
| x-ray-mid / best old WIDE → best tested new WIDE (s7) | 119,804 | 115,234 | -4,570 | -3.815 |
| ooffice-code / BCJ3 s1 → s2 | 101,991 | 100,314 | -1,677 | -1.644 |
| sao-mid-256 / TG3 stride 4, v15 | 163,182 | 159,438 | -3,744 | -2.294 |

Full-mode measurements (complete UCZ B):

| WIDE mode | mr-mid | x-ray-mid |
|---|---:|---:|
| s1 D16, P12.0 | 59,406 | 119,804 |
| s2 byte MED, P12.0 | 55,850 | 124,271 |
| s3 MED16 | 52,199 | 117,381 |
| s4 grad332 | 50,647 | 117,047 |
| s5 average16 | 52,341 | 115,461 |
| s6 ZigZag grad332 planes | 49,259 | 117,657 |
| s7 ZigZag average planes | 51,964 | 115,234 |
| s8 ZigZag MED planes | 51,566 | 117,751 |

“Best tested” means the minimum of these full-slice measurements, **not a claim that the adaptive spatial sampler selected that mode on a full file**. Production uses its own strict full-container guard.

### sao limitation

The audit's existing sao-mid window is 262,136 B (28-byte aligned). Its **old stride-28** control is 139,912 B complete UCZ. The new stride-4 result on that same window is 159,431 B and therefore **does not beat the old stride-28 baseline**. The stride-4 gain comes from the longer planning window; the selected stream has no new integer-mode flag. Do not attribute it to a proven uint32/64 win or count it as a full-file sao gain.

The exact-256-KiB row above extends the precommitted offset by eight bytes, with new provenance in `scripts/diag/p12-impl/slices.json`. New stride-28 64-KiB DP is not run in the sandbox: the old 16-KiB planning control already took 15.6 seconds. The requested larger planner and full sao outcome require the user's local run. New LE32/64 modes, both orientations and partial tails, were independently verified with BigInt arithmetic and forced inner-mode decode tests.

## Verification

- 22 immutable slice receipts in `scripts/diag/p12-impl-results/p121/`; all PASS, max **15,638 ms**, production source hashes checked. ooffice s1 control is the matching P12.0 receipt.
- `timeout --signal=KILL 19s node tests/run-p12.mjs transforms`: PASS — independent predictor arithmetic, 12 multi-part kernel paths, split planes, BCJ25 boundary cases, uint32/64 carry/reverse/tails, old-version rejection, v20 fixed mht4 sizing.
- `... node tests/run-p12.mjs worker-transforms`: PASS — real worker equals synchronous bytes/flags/costs/candidates for six WIDE modes, BCJ s2 and TG3.
- `... node tests/run-p12.mjs history`: PASS — archived v18/v19 and older container/WORD-PRE decoders.
- `... npx tsc --noEmit`: PASS; `... npm run build`: PASS including worker freshness.
- Fixture-freezer's first esbuild attempt failed before any encoding due to a quoted newline; corrected, then 14 fixture roundtrips passed.
- No full codec-suite or full-file performance/RSS claim. The P12.0 full P11.1-suite timeout remains a deferred local gate; it was not retried unchanged.

Reproduction uses `scripts/diag/p12-impl/run.mjs`, e.g. one bounded invocation:

```sh
timeout --signal=KILL 19s node scripts/diag/p12-impl/run.mjs p121-replay mr-mid wide6
```

Use a fresh receipt namespace for reruns. Do not replace the locked twelve-file baseline with the minima in these tables.
