#!/usr/bin/env bash
# USER-LOCAL ONLY: full Silesia files. Never run this in the Arena sandbox.
# UCZ_THREADS=16 bash scripts/diag/p13/local-validate.sh all /absolute/Silesia
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODE="${1:-all}"
case "$MODE" in
  all) FILES=(mozilla xml dickens ooffice mr osdb x-ray sao reymont nci samba webster) ;;
  mozilla) FILES=(mozilla) ;;
  *) printf 'Usage: %s [all|mozilla] [/absolute/corpus]\n' "$0" >&2; exit 2 ;;
esac
CORPUS="${2:-${CORPUS:-$ROOT/.diag-data/corpus}}"
CORPUS="$(cd "$CORPUS" && pwd)"
cd "$ROOT"
for f in "${FILES[@]}"; do test -f "$CORPUS/$f"; done
export UCZ_THREADS="${UCZ_THREADS:-16}"
if [[ ! "$UCZ_THREADS" =~ ^[1-9][0-9]*$ ]] || (( UCZ_THREADS > 64 )); then
  printf 'UCZ_THREADS must be an integer from 1 to 64\n' >&2; exit 2
fi
case "${P13_CONFIRM_COMPARABLE_TIMING:-0}" in 0|1) ;; *) printf 'P13_CONFIRM_COMPARABLE_TIMING must be 0 or 1\n' >&2; exit 2 ;; esac
npm run check:worker
mkdir -p .diag-data
OUT="$(mktemp -d "$ROOT/.diag-data/p13-$MODE-XXXXXXXX")"
node --input-type=module - > "$OUT/run-source.meta" <<'JS'
import { readFileSync } from 'node:fs'
import { sourceFingerprint, gitHead, environment, sha256 } from './scripts/diag/p9-checkpoint.mjs'
console.log(JSON.stringify({ kind:'p13-local-full-file-validation',startedAt:new Date().toISOString(),
  source:{commit:gitHead(process.cwd()),...(await sourceFingerprint(process.cwd()))},
  environment:environment(),requestedWorkers:Number(process.env.UCZ_THREADS),parallelFiles:1,
  benchmarkArgs:['--no-single','--no-bench','--verbose-segs'],
  timingComparableConfirmed:process.env.P13_CONFIRM_COMPARABLE_TIMING==='1',
  timingReference:'user-reported P12 d9b84df, 16 cores, encode-row sum 2137.2 s; raw machine/Node metadata unavailable',
  wrapperSha256:sha256(readFileSync('scripts/diag/p13/local-validate.sh')),
  targetCheckerSha256:sha256(readFileSync('scripts/diag/p13/check-targets.mjs')) },null,2))
JS
SOURCE_SHA="$(node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(process.argv[1],"utf8")).source.sha256)' "$OUT/run-source.meta")"
printf 'New results: %s\nSource SHA: %s\nRequested workers per file: %s\n' "$OUT" "$SOURCE_SHA" "$UCZ_THREADS"
printf 'Files run sequentially. Every file has a strict P12 byte ceiling; no cross-file offsets.\n'
printf 'Timing goal is provisional unless you explicitly confirm the same local timing protocol.\n'
for f in "${FILES[@]}"; do
  printf 'Encoding full file: %s\n' "$f"
  if ! node scripts/diag/run.mjs bench-one "$CORPUS/$f" --no-single --no-bench --verbose-segs \
    > "$OUT/$f.json.tmp" 2> "$OUT/$f.stderr.log"; then
    printf 'FAILED %s; partial stdout and stderr preserved in %s\n' "$f" "$OUT" >&2
    cat "$OUT/$f.stderr.log" >&2
    exit 1
  fi
  node --input-type=module - "$OUT/$f.json.tmp" "$SOURCE_SHA" "$f" <<'JS'
import { readFileSync } from 'node:fs'
const [path,sha,file]=process.argv.slice(2),r=JSON.parse(readFileSync(path,'utf8'))
if(r.file!==file||r.verified!==true||r.sourceUnchanged!==true||r.source?.sha256!==sha)
  throw Error('Unverified result or changed/mixed source; temporary JSON not promoted')
JS
  mv "$OUT/$f.json.tmp" "$OUT/$f.json"
  # Any 1 B per-file regression stops immediately, even if others improved.
  node scripts/diag/check-baseline.mjs "$OUT/$f.json"
done
if [[ "$MODE" == all ]]; then
  node scripts/diag/check-baseline.mjs "$OUT" --all
  node scripts/diag/summary.mjs "$OUT" --all
  if node scripts/diag/p13/check-targets.mjs "$OUT" > "$OUT/targets.meta"; then
    cat "$OUT/targets.meta"
  else
    cat "$OUT/targets.meta"
    printf 'P13 targets not accepted; all measured results remain in %s\n' "$OUT" >&2
    exit 1
  fi
else
  node scripts/diag/summary.mjs "$OUT"
  printf 'Mozilla only: NOT twelve-file acceptance and NOT evidence of either P13 target.\n'
fi
printf 'Saved results: %s\n' "$OUT"
