#!/bin/bash
# 全语料诊断：对 12 个 Silesia 文件逐一跑 bench-one，输出 JSONL。
# 用法：scripts/diag/run-corpus.sh <语料目录> [输出文件]
# 预计耗时：约 40 分钟（2 vCPU），主要花在 mozilla 上。
set -u
cd "$(dirname "$0")/../.." || exit 1
CORPUS=${1:-/tmp/corpus}
OUT=${2:-/tmp/corpus-results.jsonl}
FILES="xml dickens ooffice mr osdb x-ray sao reymont nci samba webster mozilla"
: > "$OUT"
for f in $FILES; do
  [ -f "$CORPUS/$f" ] || { echo "缺少 $CORPUS/$f，跳过" >&2; continue; }
  echo "=== $f $(date +%T)" >&2
  node scripts/diag/run.mjs bench-one "$CORPUS/$f" >> "$OUT" 2>>"$OUT.err"
done
echo "完成，结果在 $OUT" >&2
