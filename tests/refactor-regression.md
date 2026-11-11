# Refactor byte comparison

Reproduce from the project directory with `node scripts/compare-refactor.mjs`.
Compared local commit `57b41aa` with `dbce917` plus this test/documentation-only
follow-up on Node v22.22.3. Every line denotes byte-identical old/new complete
containers and a successful current-decoder round trip. `adaptive` uses actual
`compressAdaptive()` and lists selected codec IDs; `forced` constructs a valid
single-group container using the specified encoder path on each revision and
also checks the current evaluator's total. A forced path is not a claim that the
adaptive classifier selected that codec.

```text
adaptive text bytes=68 ids=19 sha256=05e2e7527a9965eb3090d8bead3a816ff7ec40a32fe0eb1dadea51ee09e7f405
adaptive noise bytes=8015 ids=0 sha256=5797e4b5ebd1114984d8bf2915f580ca95db80d71489aa02cc7c615af3983cf8
adaptive mixed bytes=8096 ids=19,0,19 sha256=8cd57cc53b3e889a3a6537b0eba1a312df24528deb1e12d1f806c3e5e3f121c3
adaptive records bytes=56 ids=26 sha256=722d5221e6c3213d3b85be4c3f158009f96b078d4dcf9cb515e370b3e8ea5281
adaptive executable bytes=59 ids=6 sha256=87db0a2c7ffecbc9b01081f1828b182baa1d1ad7ff813ee730641cd6fe929205
adaptive image bytes=60 ids=28 sha256=882002a4522e7a3063c1a29b9996fcb4b762977535c542c6cf8d3561fb1d5830
adaptive wide bytes=239 ids=26 sha256=8aac71406699b9df7d8d512b655b6bb98b1656d96d6cab5f6bf7ab8a5548247a
adaptive fill bytes=8026 ids=1,0,1 sha256=919d47fc9df80d3795ed35264819afc5406c5a6be0ead9ae251eadbfc25ef199
adaptive anchor bytes=55 ids=19 sha256=83b6aa43db09451e7111ef5bc33d3f6ded8ace3f39b78bae2cedeba053f6b3f5
forced BCJ bytes=2653 sha256=9ce0a376af2a0e6a036900cb5d6206e3e28880d7912d04f75017c75d8c03089d
forced TRANSPOSE_2D bytes=54 sha256=4558f357b704548121928b9f3b73e4316a2b2e8615d7b5d464d946bf5f1081f2
forced TRANSPOSE_GROUP_V3 bytes=112 sha256=8e1297d87f3a2ce0610016746b8d447f890b880b591a7847050cb0d628a2fb20
forced TRANSPOSE_GROUP_AUTO bytes=53 sha256=1ce3b2aff242d6b20a6817bd98bbcd2d607608fe0165b4362482188f1008f655
forced WIDE_D16 bytes=275 sha256=70b8b349c49cc992b396a2be1b36d38c63d9661c2697012391087b0b80c57da0
forced WIDE_MED bytes=167 sha256=b95dda00ba992681f16409c5d180d425d1053688706a3de1a2461dfac3508457
forced FILL bytes=15 sha256=8c2193e20567deee0f669d731fb5f32b20de78d2fd01f00d83fb3ec88aab3046
forced PEEL bytes=255 sha256=af5911e9b60ba61091a16f00939b9026cf68daf454e93416b1e6165ea6a8e876
forced MICRO bytes=282 sha256=3efcda8ff19c548001f410a60314efc13cdfa0571d6e396e6760b1ce07f08fa5
forced ANCHOR bytes=115 sha256=f9df587979ee5cfe436cc1c6cf77b4e734c1a0b179a996e2ec8e346e9b5ee692
```
