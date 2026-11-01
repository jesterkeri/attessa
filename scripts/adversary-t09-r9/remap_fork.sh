#!/usr/bin/env bash
# Adversary T09 r9: check-nitro-pin.sh pins the folder contracts/lib/nitro-validator, not what the build
# uses. contracts/remappings.txt maps the `nitro-validator/` import prefix; pointing it at a modified
# copy elsewhere under lib/ makes EnclaveRegistry (and any deploy script importing nitro-validator/)
# compile against the copy while the pinned submodule stays untouched, so the pin check passes.
#   fork : lib/nv-fork/src = a copy of the pinned src/ with NitroValidator.validateAttestationWithHints
#          marked (a stand-in for any edit), remappings.txt nitro-validator/=lib/nv-fork/src/, committed.
# Runs the CI guard step and the CI Slither step from ci.yml, then reports which NitroValidator.sol the
# Slither build compiled EnclaveRegistry against.
# Usage: remap_fork.sh <scratch-dir>. Exit 1 = the substituted validator passes the gate (defect),
# 0 = rejected, 2 = harness error.
set -u
OUT=$1; HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
rm -rf "$OUT"; mkdir -p "$OUT"
. "$ROOT/scripts/adversary-t09/mkrepo.sh"
mkrepo "$OUT/fork" >/dev/null 2>&1 || { echo "harness error: could not build the scratch superproject"; exit 2; }
W="$OUT/fork/contracts"
mkdir -p "$W/lib/nv-fork" && cp -r "$W/lib/nitro-validator/src" "$W/lib/nv-fork/src"
python3 -I - "$W/lib/nv-fork/src/NitroValidator.sol" <<'PY' || exit 2
import sys
p = sys.argv[1]; t = open(p).read()
old = ") public returns (Ptrs memory) {"
assert t.count(old) == 1
open(p, "w").write(t.replace(old, old + "\n        // ADV-FORK: this body is not the pinned 0ea0d12 code", 1))
PY
sed -i 's|^nitro-validator/=lib/nitro-validator/src/$|nitro-validator/=lib/nv-fork/src/|' "$W/remappings.txt"
head -1 "$W/remappings.txt"
git -c user.name=adv -c user.email=adv@invalid add -A >/dev/null && git -c user.name=adv -c user.email=adv@invalid commit -qm "remap nitro-validator to a fork"
bash "$ROOT/scripts/adversary-t09/ci_guard.sh" "$OUT/fork" > "$OUT/guard.log" 2>&1; GUARD=$?
echo "guard_exit=$GUARD"; grep -h "^ok:\|^FAIL\|not allowed" "$OUT/guard.log" | head -3
[ "$GUARD" = 2 ] && { echo "harness error: ci_guard.sh could not run"; exit 2; }
bash "$ROOT/scripts/adversary-t09/ci_slither.sh" "$W" > "$OUT/slither.log" 2>&1; SLITHER=$?
echo "slither_exit=$SLITHER"; grep -h "result(s) found" "$OUT/slither.log" | tail -1
if [ "$SLITHER" != 0 ] && ! grep -q "result(s) found" "$OUT/slither.log"; then
  echo "harness error: the Slither step failed without an analysis (see $OUT/slither.log)"; tail -5 "$OUT/slither.log"; exit 2
fi
python3 -I - "$W/out/build-info" <<'PY'
import glob, json, sys
for f in glob.glob(sys.argv[1] + "/*.json"):
    srcs = json.load(open(f))["input"]["sources"]
    nv = sorted(k for k in srcs if k.endswith("NitroValidator.sol"))
    fork = any("ADV-FORK" in v.get("content", "") for v in srcs.values())
    print(f"build-info: NitroValidator.sol compiled from {nv}; ADV-FORK marker present: {fork}")
PY
if [ "$GUARD" = 0 ] && [ "$SLITHER" = 0 ]; then
  echo "verdict=PASSED_GATE (defect: EnclaveRegistry builds against a modified NitroValidator, pin check passes)"; exit 1
fi
echo "verdict=REJECTED"; exit 0
