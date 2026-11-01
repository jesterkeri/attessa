#!/usr/bin/env bash
# Adversary T09 r9: the CI Slither step pins slither.config.json by hash, but not contracts/foundry.toml,
# which crytic-compile's `forge build` reads. Setting foundry's `src` to the pinned validator's own
# source folder means contracts/src/ is never compiled for Slither: every analysed file is under
# lib/nitro-validator/, which include_paths drops, so a High in contracts/src/EnclaveRegistry.sol
# passes the gate. `find src -name '*.sol'` in the CI step still finds src/, so the step runs.
# Tests and deploy scripts still compile src/ through their own imports.
#   redirect : the "high" mutant (selfdestruct + arbitrary send in src/EnclaveRegistry.sol) plus
#              src = "lib/nitro-validator/src" in contracts/foundry.toml, committed.
# Runs the CI guard step and the CI Slither step, both read from ci.yml at run time.
# Usage: src_redirect.sh <scratch-dir>. Exit 1 = the Highs pass the gate (defect), 0 = rejected, 2 = harness error.
set -u
OUT=$1; HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
rm -rf "$OUT"; mkdir -p "$OUT"
. "$ROOT/scripts/adversary-t09/mkrepo.sh"
mkrepo "$OUT/redirect" >/dev/null 2>&1 || { echo "harness error: could not build the scratch superproject"; exit 2; }
W="$OUT/redirect/contracts"
python3 -I "$ROOT/scripts/adversary-t09/mutate.py" high "$W" || exit 2
sed -i 's|^src = "src"$|src = "lib/nitro-validator/src"|' "$W/foundry.toml"
grep -n '^src' "$W/foundry.toml"
git -c user.name=adv -c user.email=adv@invalid commit -qam "redirect foundry src" && git -C "$OUT/redirect" status --porcelain
grep -c "selfdestruct" "$W/src/EnclaveRegistry.sol" | sed 's/^/selfdestruct lines in src\/EnclaveRegistry.sol: /'
bash "$ROOT/scripts/adversary-t09/ci_guard.sh" "$OUT/redirect" > "$OUT/guard.log" 2>&1; GUARD=$?
echo "guard_exit=$GUARD"; grep -h "^ok:\|^FAIL\|not allowed" "$OUT/guard.log" | head -3
[ "$GUARD" = 2 ] && { echo "harness error: ci_guard.sh could not run"; exit 2; }
bash "$ROOT/scripts/adversary-t09/ci_slither.sh" "$W" > "$OUT/slither.log" 2>&1; SLITHER=$?
grep -h "slither.config.json: OK\|differs from the pinned" "$OUT/slither.log" | head -1
echo "slither_exit=$SLITHER"; grep -h "result(s) found" "$OUT/slither.log" | tail -1
if [ "$SLITHER" != 0 ] && ! grep -q "result(s) found" "$OUT/slither.log"; then
  echo "harness error: the Slither step failed without an analysis (see $OUT/slither.log)"; tail -5 "$OUT/slither.log"; exit 2
fi
if [ "$GUARD" = 0 ] && [ "$SLITHER" = 0 ]; then
  echo "verdict=PASSED_GATE (defect: a selfdestruct in src/EnclaveRegistry.sol passes; foundry.toml src redirected)"; exit 1
fi
echo "verdict=REJECTED"; exit 0
