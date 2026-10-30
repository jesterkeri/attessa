#!/usr/bin/env bash
# Runs each AGENTS.md "Commands (use verbatim)" entry for install, build, test,
# lint and typecheck exactly as written, from the repo root. Exits 1 if any fails.
set -u
root=$(git rev-parse --show-toplevel)
cd "$root"
fail=0
for name in install build test lint typecheck; do
  cmd=$(sed -n "/^## Commands/,/^## /p" AGENTS.md | grep -E "^- ${name}: " | sed -E 's/^- [a-z]+: `(.*)`$/\1/')
  [ -n "$cmd" ] || { echo "MISSING $name"; fail=1; continue; }
  if out=$(bash -c "$cmd" 2>&1); then
    echo "PASS $name"
  else
    echo "FAIL $name: $cmd"
    printf '%s\n' "$out" | tail -3
    fail=1
  fi
done
exit $fail
