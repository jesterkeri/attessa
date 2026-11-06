#!/usr/bin/env bash
# Runs each site test file on its own and sums the TAP footers, so the count does not depend on how a runner
# reports a globbed `node --test test/*.test.mjs` (some environments report one result per file).
# Prints one line per file, then the totals. Exit 1 if any file fails.
set -u
cd "$(dirname "$0")" || exit 1
files=0; tests=0; fails=0
for t in test/*.test.mjs; do
  o=$(node --test "$t" 2>&1); rc=$?
  c=$(grep -m1 '^# tests' <<<"$o" | awk '{print $3}'); p=$(grep -m1 '^# fail' <<<"$o" | awk '{print $3}')
  echo "${c:-?} tests, ${p:-?} failed, exit $rc: $t"
  files=$((files + 1)); tests=$((tests + ${c:-0})); fails=$((fails + ${p:-1}))
  [ "$rc" -ne 0 ] && fails=$((fails + 1))
done
echo "node $(node --version): $files files, $tests tests, $fails failed"
[ "$fails" -eq 0 ]
