#!/usr/bin/env bash
# Runs each site test module directly (`node <file>`, so node:test reports the module's own tests, not one wrapper
# per file as `node --test <file>` does in some environments) and sums the TAP footers.
# Prints one line per file, then the totals. A failure is counted once: from the module's `# fail` footer, or as 1
# when the module exits nonzero and its footer reports none. Exit 1 if any file fails.
set -u
cd "$(dirname "$0")" || exit 1
files=0; tests=0; fails=0
for t in test/*.test.mjs; do
  o=$(node "$t" 2>&1); rc=$?
  c=$(grep -m1 '^# tests' <<<"$o" | awk '{print $3}'); p=$(grep -m1 '^# fail' <<<"$o" | awk '{print $3}')
  [ -z "$p" ] && p=0
  # A nonzero exit is a failure even after a clean footer (process.exitCode, an error after the tests): counted once.
  [ "$rc" -ne 0 ] && [ "$p" -eq 0 ] && p=1
  echo "${c:-?} tests, $p failed, exit $rc: $t"
  files=$((files + 1)); tests=$((tests + ${c:-0})); fails=$((fails + p))
done
echo "node $(node --version): $files files, $tests tests, $fails failed"
[ "$fails" -eq 0 ]
