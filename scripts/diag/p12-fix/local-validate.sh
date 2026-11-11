#!/usr/bin/env bash
# USER-LOCAL ONLY: full files, not an Arena sandbox verification command.
# bash scripts/diag/p12-fix/local-validate.sh [mozilla|all] [/absolute/corpus]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODE="${1:-mozilla}"
case "$MODE" in
  mozilla) FILES=(mozilla) ;;
  all) FILES=(mozilla xml dickens ooffice mr osdb x-ray sao reymont nci samba webster) ;;
  *) printf 'Usage: %s [mozilla|all] [/absolute/corpus]\n' "$0" >&2; exit 2 ;;
esac
CORPUS="${2:-${CORPUS:-$ROOT/.diag-data/corpus}}"
CORPUS="$(cd "$CORPUS" && pwd)"
cd "$ROOT"
for f in "${FILES[@]}"; do test -f "$CORPUS/$f"; done
export UCZ_THREADS="${UCZ_THREADS:-16}"
mkdir -p .diag-data
OUT="$(mktemp -d "$ROOT/.diag-data/p12-fix-$MODE-XXXXXXXX")"
# No fake commit label for source archives. Fingerprint is authoritative; the
# quiet helper reports a real Git HEAD when available, otherwise null.
node --input-type=module - > "$OUT/run-source.meta" <<'JS'
import { sourceFingerprint, gitHead, environment } from './scripts/diag/p9-checkpoint.mjs'
console.log(JSON.stringify({ source: { commit: gitHead(process.cwd()), ...(await sourceFingerprint(process.cwd())) },
  environment: environment(), requestedWorkers: process.env.UCZ_THREADS }, null, 2))
JS
SOURCE_SHA="$(node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(process.argv[1],"utf8")).source.sha256)' "$OUT/run-source.meta")"
printf 'New results: %s\nSource SHA: %s\nRequested workers per file: %s\n' "$OUT" "$SOURCE_SHA" "$UCZ_THREADS"
printf 'Files run sequentially. This script does not run the complete codec test suite.\n'
for f in "${FILES[@]}"; do
  printf 'Encoding full file: %s\n' "$f"
  # Keep failures and partial stdout for diagnosis; never publish them as a
  # completed result. Existing /tmp/p4 or any previous output is untouched.
  if ! node scripts/diag/run.mjs bench-one "$CORPUS/$f" --no-single --no-bench --verbose-segs \
    > "$OUT/$f.json.tmp" 2> "$OUT/$f.stderr.log"; then
    printf 'FAILED %s; partial output and stderr retained in %s\n' "$f" "$OUT" >&2
    cat "$OUT/$f.stderr.log" >&2
    exit 1
  fi
  node --input-type=module - "$OUT/$f.json.tmp" "$SOURCE_SHA" "$f" <<'JS'
import { readFileSync } from 'node:fs'
const [path,sha,file]=process.argv.slice(2),r=JSON.parse(readFileSync(path,'utf8'))
if (r.file!==file || r.verified!==true || r.sourceUnchanged!==true || r.source?.sha256!==sha)
  throw Error('Unverified result or changed/mixed source; temporary JSON not promoted')
JS
  mv "$OUT/$f.json.tmp" "$OUT/$f.json"
  # A one-byte per-file regression stops this run; other wins cannot hide it.
  node scripts/diag/check-baseline.mjs "$OUT/$f.json"
done
if [[ "$MODE" == all ]]; then
  node scripts/diag/check-baseline.mjs "$OUT" --all
  node scripts/diag/summary.mjs "$OUT" --all
else
  node scripts/diag/summary.mjs "$OUT"
  printf 'Mozilla-only result: not a 12-file acceptance. Keep the previous eleven rows as historical evidence.\n'
fi
printf 'Saved results: %s\n' "$OUT"
