# P12.0 — compatible encoder improvements

Baseline remains **41,814,147 B / 12 PASS**, the user-local P11.1 result. No full-file compression was run in Arena and no slice result replaces that baseline.

## Implemented

- Multi-part O0/TEXT/BIN honors an explicitly requested v15 kernel without a cost buffer.
- WORD-PRE retains the existing v1 syntax/decoder: 3–24 byte substrings, at most 240 positive raw candidates, greedy longest-match non-overlapping hit simulation on at most 256 KiB, positive actual savings `hits*(len-1)-(len+1)`, at most 120 entries, then retokenization. Standard and extended character sets compete on dictionary-header + body bytes; the existing CM prefix and complete-cost gates remain.
- Token text a2 is on by default. Historical `CM_FLAG_WORD_PRE_A2_OFF` and `textOn=false` remain effective.
- BCJ/BCJ2/BCJ3 form a separate transformed family; they are deliberately not entries in the raw `CM_ENCODING` table. Family samples and full encodes carry original positions. Full family comparisons select actual base/v15/WORD-PRE streams on both sides and retain the winning kernel metadata; a selected v15 stream is never reused as a v13 base. Header and payload comparisons are strict.
- BCJ eligibility requires at least six E8/E9 operands, with at least 20% top operand bytes 00/FF. TG3 participates in selection; detected stride 2 is eligible at 32 KiB.
- Orphans preserve the specified structured families when **already encoded** payload allocation is below 0.35 raw. Unknown/sample costs do not trigger this exclusion. The existing single-batch, complete-container and complete-payload strict guard remains.
- Worker bundle regenerated. No decoder function or wire syntax changed in this phase.

## Arena measurements

Each row is a fixed, SHA-identified **262,144-byte slice**, encoded as one explicitly specified production group; actual base/v15/WORD-PRE candidates compete on complete serialized UCZ cost. Every emitted candidate was decoded and compared to the input. This is not `compressAdaptive` routing and does not prove a full-file gain. BCJ offsets are relative to the standalone slice (base 0), consistently on both sides.

| Slice / group | 837250f control B | P12.0 B | Delta B | Delta % |
|---|---:|---:|---:|---:|
| xml-mid / TEXT3 | 5,576 | 4,849 | -727 | -13.038 |
| nci-mid / TEXT3 | 13,795 | 12,717 | -1,078 | -7.814 |
| ooffice-code / BCJ3 | 101,991 | 101,991 | 0 | 0 |
| mozilla-code / BIN3 | 76,382 | 76,382 | 0 | 0 |

Eight immutable receipts: `scripts/diag/p12-impl-results/p120/`. Each includes source-file hashes, tool/bundle hashes, input provenance, candidate sizes, container SHA, and process time. Maximum receipt process time **15,574 ms**. Archived audit tools/receipts are unchanged.

## Verification and limits

Every command below was bounded with `timeout --signal=KILL 19s`:

- `node tests/run-p12.mjs unit`: PASS (multi-part kernel, dictionary bounds/retokenization/escaping, BCJ plausibility/family, TG3 eligibility, 0.35 orphan boundary).
- `node tests/run-p12.mjs history`: PASS, independently archived containers and CM models, including v18, old v19 expanded mht4, and historical WORD-PRE off streams.
- `node tests/run-p12.mjs family`: PASS for BCJ and BIN families, nonzero positions, exact roundtrip, selected complete cost no larger than independent groups.
- `node tests/run-p12.mjs worker`: PASS, real embedded worker bytes/flags/costs/candidates equal synchronous implementation.
- `node tests/run-p9-defaults.mjs`: 14 checks PASS, explicitly updated changed encoder defaults while retaining historical off-flag tests.
- `node --test tests/p10-baseline.test.mjs`: 8 PASS. Exact baseline rows and 1-byte-per-file no-regression enforcement unchanged.
- `npx tsc --noEmit`: PASS. `npm run build`: PASS, including fresh worker check.
- `node tests/run-p111.mjs`: **19-second timeout, NOT PASS**. It still includes all historical encoder/worker tests; no default test coverage was removed. The separate historical-decode shard above completed. Long/full suites remain local gates.

Reproduce a single slice from the project directory:

```sh
timeout --signal=KILL 19s node scripts/diag/p12-impl/run.mjs p120-replay xml-mid text
timeout --signal=KILL 19s node scripts/diag/p12-impl/run.mjs p120-control xml-mid text 837250f
```

Use a new phase label for a new run: existing receipts cannot be overwritten. Source snapshots and generated bundles live only under ignored `.diag-state/p12-impl`. Restore corpus with `scripts/diag/fetch-corpus.mjs <one-file>` if needed. Four-file fetch was interrupted at 19 seconds after three verified downloads; Mozilla was fetched separately, without compression.
