#!/usr/bin/env bash
# Adversary T09 r10: check-slither-build.sh refuses a .env under contracts/ only. Does forge, run in
# contracts/, also load a .env at the repository root (the git root)? Scratch superproject only: a
# committed root .env with FOUNDRY_SRC=lib/nitro-validator/src, plus the "high" mutant.
# Usage: rootenv.sh <scratch-dir>. Exit 1 = passes the gate (defect), 0 = rejected, 2 = harness error.
set -u
OUT=$1; HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
rm -rf "$OUT"; mkdir -p "$OUT"
. "$ROOT/scripts/adversary-t09/mkrepo.sh"
mkrepo "$OUT/rootenv" >/dev/null 2>&1 || { echo "harness error: could not build the scratch superproject"; exit 2; }
W="$OUT/rootenv/contracts"
python3 -I "$ROOT/scripts/adversary-t09/mutate.py" high "$W" || exit 2
printf 'FOUNDRY_SRC=lib/nitro-validator/src\n' > "$OUT/rootenv/.env"
git -c user.name=adv -c user.email=adv@invalid add -A >/dev/null && git -c user.name=adv -c user.email=adv@invalid commit -qm "root env"
bash "$ROOT/scripts/adversary-t09/ci_guard.sh" "$OUT/rootenv" > "$OUT/guard.log" 2>&1; GUARD=$?
echo "guard_exit=$GUARD"; grep -h "^ok:\|^FAIL\|not allowed" "$OUT/guard.log" | head -4
[ "$GUARD" = 2 ] && exit 2
bash "$ROOT/scripts/adversary-t09/ci_slither.sh" "$W" > "$OUT/slither.log" 2>&1; SLITHER=$?
echo "slither_exit=$SLITHER"; grep -h "result(s) found" "$OUT/slither.log" | tail -1
if [ "$GUARD" = 0 ] && [ "$SLITHER" = 0 ]; then echo "verdict=PASSED_GATE (defect)"; exit 1; fi
echo "verdict=REJECTED"; exit 0
