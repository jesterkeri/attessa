#!/usr/bin/env bash
# Adversary T01 r1: every repo file docs/KILL_TEST.md points the reader to must exist in this tree.
# KILL_TEST.md says "the production stack is in `docs/DEPLOYMENTS.md`", but at 04d8390 that file
# exists on no branch merged here (not on main, not on staging); it only exists on the unmerged
# T10 branch. Run from the repo root: bash scripts/adversary-t01-r1/check_kill_test_refs.sh
set -u
root=$(git rev-parse --show-toplevel)
fail=0
for p in $(grep -oE '`(docs|contracts|scripts|packages|adr)/[^`]+`' "$root/docs/KILL_TEST.md" | tr -d '`' | sort -u); do
  if [ -e "$root/$p" ]; then echo "ok      $p"; else echo "MISSING $p"; fail=1; fi
done
[ "$fail" -eq 0 ] && echo PASS || { echo "FAIL: docs/KILL_TEST.md references files absent from this tree"; exit 1; }
