# P12.2 — independently versioned v20 CM

P12.1 parent: `c97b6d360805cafbf9e14ee0e7869e67c01671b7`. The locked full-file result is still **41,814,147 B / 12 PASS**, measured on the user's machine at P11.1, **not** remeasured here. No full Silesia file was encoded in this phase.

## Implementation and compatibility contract

- `CMVariant='v20'` is explicit. v20 container flag **0x1000** authorizes the new CM, separately from P12.1's transform flag **0x0800**. **0x2000 is a container flag for BIN recovery, not the valid row-size bit `r=8192`.** A new `rRaw` group marker **0x10000**, together with the existing APM marker 0x8000, distinguishes new CM from retained legacy-v15 groups in one container. WORD-PRE remains 0x4000. Transform-only v20 streams continue using their original kernels.
- v20 computes auxiliary-mixer indices before the profile-specific early returns; geometric H6/H7 overrides execute before BIN/res2d returns. Legacy kernels retain their old execution order and probabilities.
- With BIN `geomStride=0`, H4 is `hh(b1,pos&3)`, H8 is `hh(b2,b4)`, H6 remains `hh(b3,b4)`.
- Primary weights have eight bit positions × four match states: none, short (<6, normally 4–5), 6–15, >=16. The APM/a2/dual calibration path independently retains its three-state `ms2`, never indexing the old calibration tables with state 3. The mht8 lookup runs below length 32 and accepts only verified length >=6 and strictly longer than the current match.
- v20 TEXT's auxiliary mixer uses `charClass8(b1) × c0-low-2 × match-active`, with learning rate 2. This is part of the explicitly versioned kernel; legacy mixer behavior is not silently changed.
- Corrected recovery distance is `pos - 1 - mptr` after the byte write. Recovery is BIN-only. It was promoted to **enabled by default** only after all three incremental on/off comparisons below won individually. The distance fix is retained regardless of the runtime candidate switch. The global legacy `match3Tuning.gapResume` default is unchanged.
- `encodeCMDual(...,'v20').alt` is checked against an independent v20 encode. Its `base` is **not a v13 payload**: it shares the selected kernel's contexts and match evolution. Production continues to keep a separately encoded real baseline; misleading historical dual-base documentation was corrected.
- The ordinary, multi-part, WIDE, TG, WORD-PRE, dual and worker paths carry the explicit kernel. Worker jobs serialize the v20 candidate/recovery configuration, apply it only inside a synchronous job body, restore it in `finally`, and return each candidate's required flags alongside cloned bytes. Main-thread restoration uses those actual flags.
- Selection retains real base, legacy-v15 and legacy-WORD-PRE candidates; it adds raw/WORD-PRE v20 candidates and accepts only a strictly smaller serialized complete cost. The v1 dictionary is built once; legacy and new kernels separately retain the existing collapse/prefix gates. This protects the alternatives actually evaluated, **not an unmeasured full adaptive/full-file baseline**.
- P12.0 orphan follow-up: speculative prefetch used initial `compLen=0` placeholders. These costs are now explicitly removed before the pre-encode orphan proposal. Only the post-encode decision may protect an already-small structured group. Nonfinite/negative costs are unknown; genuinely measured zero allocations remain valid. The complete payload/container acceptance guard is unchanged.

## Measurements: 256 KiB, complete single-group UCZ

Every row uses the same fixed, SHA-identified 262,144-byte input on both sides and includes the actual UCZ header. These are **forced kernel/group measurements**, not adaptive-selected full-file results. Controls come from immutable **c97b6d3**. Each emitted stream roundtripped.

### BIN3: new core and incremental recovery

The new-core/off column already includes fixed M2 indices, H4/H8, four primary states and mht8<32. Recovery is the only on/off difference.

| Slice | Legacy-v15 B | v20 recovery off B | v20 recovery on B | Recovery-only delta B | On vs v15 B | On vs v15 % |
|---|---:|---:|---:|---:|---:|---:|
| mozilla-code | 76,382 | 73,180 | 72,080 | -1,100 | -4,302 | -5.632 |
| ooffice-code | 114,659 | 112,979 | 111,755 | -1,224 | -2,904 | -2.533 |
| osdb-mid | 74,288 | 72,797 | 72,729 | -68 | -1,559 | -2.099 |

All three win incrementally; there is no cross-file compensation. Off/on streams use version 20, flags 4096/12288, and 22-byte headers. Mozilla's selected window is Alpha ECOFF code, **not x86**. ooffice here is **raw BIN3**, not P12.1's BCJ comparison; those gains cannot be added.

### Raw TEXT3: combined v20 changes

| Slice | Legacy-v15 B | v20 B | Delta B | Delta % |
|---|---:|---:|---:|---:|
| dickens-mid | 70,389 | 69,566 | -823 | -1.169 |
| webster-mid | 57,284 | 56,466 | -818 | -1.428 |
| samba-c | 32,691 | 32,224 | -467 | -1.429 |
| xml-mid | 6,066 | 5,871 | -195 | -3.215 |
| nci-mid | 13,795 | 13,278 | -517 | -3.748 |
| reymont-mid | 48,387 | 47,380 | -1,007 | -2.081 |

All six measured windows win, but this does **not** establish text improvement at all sizes. These compare the complete new kernel, not an isolated mixer2-only ablation. Production still compares against retained legacy candidates. In particular, XML/nci WORD-PRE candidates from P12.0 can be smaller than these **raw-text** rows. This table does not claim they were displaced by raw v20. The samba window starts in identified C source but also includes following contiguous tar data; see its manifest.

## Immutable evidence and provenance

- `scripts/diag/p12-impl-results/p122/`: 9 receipts — six incremental recovery measurements plus three immutable legacy controls.
- `.../p122-final/`: 15 receipts — three promoted-default binary confirmations, six text v20 measurements and six immutable text controls. These snapshot the source before the final orphan-prefetch/comment cleanup.
- `.../p122-checkpoint/`: 9 receipts — final source/default replay of all nine v20 windows. Container sizes **and SHA-256 values** exactly equal the earlier measurements. These receipts use the actual default recovery setting, not an implicit probe override.
- Final `src/lib` fingerprint (the implementation runner's sorted file-hash map): **83a4dc738009fbf917afaf6319ae55f15b7642b012bb05a6302f9097e1ff7f77**. Receipts honestly record the dirty working source and its P12.1 parent; they do not pretend the as-yet-uncreated commit was already checked out.
- P12.2: **33 PASS receipts**, longest recorded process **7,445 ms**. Across all three implementation phases: **63 PASS receipt records**, longest **15,638 ms**. Replays are included in these counts, not independent extra corpora.
- `timeout --signal=KILL 19s node scripts/diag/p12-impl/verify.mjs --current` checks all 63 records, immutable control identity, identical slice fingerprints, recovery on/off wins, replay byte/hash equality, current-source hashes, and the unchanged strict twelve-file baseline. It reads evidence only; it does not encode files.

One-window reproduction, with a fresh receipt namespace:

```sh
timeout --signal=KILL 19s node scripts/diag/p12-impl/run.mjs p122-replay mozilla-code bin-v20-default
timeout --signal=KILL 19s node scripts/diag/p12-impl/run.mjs p122-control-replay mozilla-code bin-v15 c97b6d3
```

`bin-v20` explicitly turns recovery off; `bin-v20-gap` explicitly turns it on; `bin-v20-default` leaves the compiled default alone. Existing receipts cannot be overwritten.

## Verification and explicit unfinished gates

Completed bounded checks (each command bounded below 20 seconds):

- `npx tsc --noEmit`: PASS. Final invocation **15,228 ms**. This is the project's normal src/config typecheck scope.
- `npm run build`: PASS, including `prebuild` worker-freshness check; final invocation **10,396 ms**. Embedded worker rebuilt, approximately 79.7 KiB.
- P12 bounded shards `unit`, `family`, `history`, `kernel`, `mixed`, `transforms`, `worker`, `worker-transforms`, `worker-v20`, `worker-plan`: PASS. Coverage includes independent predictor/hash arithmetic, 18 WIDE multi-part kernel paths, BCJ/TG v20, ms2 bounds, corrected distance 80 rather than 81, recovery flags independent of runtime defaults, and real worker/main-thread byte parity with recovery on/off.
- All **14 independent P12.1 transform-v20/legacy-CM containers** decode under P12.2. Archived v18, pre-correction v19 and historical WORD-PRE-off streams also decode. Fixtures were not regenerated.
- `tests/run-p9-defaults.mjs`: 14 checks PASS, preserving selective a2, actual costs/orphans and worker metadata. `tests/p10-baseline.test.mjs`: 8 PASS, including one-byte regression and cross-file-compensation rejection.
- Five individually bounded historical current-writer fixtures passed: guarded-wordpre, adaptive-prose, adaptive-mixed, guarded-orphans, guarded-many-rules. Frozen historical decode remains exact; current writer/worker parity, per-fixture nonregression and strict current guard arithmetic are checked instead of demanding that an intentionally upgraded encoder reproduce every old selection.
- `bench-one` smoke: 16 KiB input, roundtrip/source stability PASS, actual output version 13 (legacy fallback), 5,730 B. This is only CLI integration coverage, not another phase-size benchmark. P9 status-only invocation accepts registered v20 knobs and encodes nothing. The local full-run command uses `bench-one`, because `probe-p9-ab` currently hard-codes `serial:true`.

**Not PASS / deferred:**

- The older full P11.1 attempt exceeded its 19-second sandbox limit in P12.0. It was not retried unchanged.
- Isolated `history-write adaptive-periodic` exceeded the P12 runner's **17.5-second child deadline** in this phase. It remains unverified as a current adaptive writer fixture; its frozen historical container is covered by the decode shard.
- A chained verification command hit its 19-second outer cap after four completed PASS shards, during a fifth fixture. Do not count that compound command as PASS. The unfinished fixture was subsequently isolated; the other independent shard results remain valid.
- During initial historical-case sharding, two parallel calls wrote the same temporary bundle and both executed prose. No periodic result was accepted from that collision. Bundle paths now include the process ID.
- **Full `npm run test:codec` was not completed/run as a full suite here.** Its coverage was not silently removed; the bounded shards are not a substitute full-suite PASS. Full suite, remaining adaptive fixture, all twelve full files, throughput, peak RSS and final full-file group directories remain user-local gates.

See [P12 implementation summary](P12_IMPLEMENTATION_SUMMARY.md) for the per-phase table and exact local sixteen-worker command. No slice sum or projection replaces the locked 41,814,147-byte result.
