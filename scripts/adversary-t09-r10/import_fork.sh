#!/usr/bin/env bash
# Adversary T09 r10 (the copy sits in contracts/vendor/, not lib/, so forge auto-detects no remapping
# for it and its effective configuration is unchanged): check-nitro-pin.sh pins the folder lib/nitro-validator and check-slither-build.sh
# pins forge's remappings, but neither pins what src/ imports. Changing EnclaveRegistry.sol's three
# `nitro-validator/...` imports to plain relative paths into a modified copy (vendor/nv-fork/src/) builds
# the registry against the copy with no remapping, config or .env change, and the pinned submodule
# stays untouched, so every guard check passes.
#   fork : vendor/nv-fork/src = a copy of the pinned src/ with NitroValidator.validateAttestationWithHints
#          marked (a stand-in for any edit, e.g. one that skips certificate checks, which raises no
#          Slither High); src/EnclaveRegistry.sol imports it as "../vendor/nv-fork/src/...". Committed.
# Runs the CI guard step and the CI Slither step from ci.yml (CI_YML=<path> for a patched copy), then
# reports which NitroValidator.sol the Slither build compiled.
# Usage: import_fork.sh <scratch-dir>. Exit 1 = the substituted validator passes the gate (defect),
# 0 = rejected, 2 = harness error.
set -u
OUT=$1; HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
rm -rf "$OUT"; mkdir -p "$OUT"
. "$ROOT/scripts/adversary-t09/mkrepo.sh"
mkrepo "$OUT/fork" >/dev/null 2>&1 || { echo "harness error: could not build the scratch superproject"; exit 2; }
W="$OUT/fork/contracts"
mkdir -p "$W/vendor/nv-fork" && cp -r "$W/lib/nitro-validator/src" "$W/vendor/nv-fork/src"
python3 -I - "$W/vendor/nv-fork/src/NitroValidator.sol" "$W/src/EnclaveRegistry.sol" <<'PY' || exit 2
import sys
p = sys.argv[1]; t = open(p).read()
old = ") public returns (Ptrs memory) {"
assert t.count(old) == 1
open(p, "w").write(t.replace(old, old + "\n        // ADV-FORK: this body is not the pinned 0ea0d12 code", 1))
# CborDecode and LibBytes are internal libraries: their code is inlined into EnclaveRegistry's bytecode.
c = p.replace("NitroValidator.sol", "CborDecode.sol"); u = open(c).read()
open(c, "w").write(u.replace("library CborDecode {", "library CborDecode {\n    // ADV-FORK: inlined into the registry, not the pinned 0ea0d12 code", 1))
assert "ADV-FORK" in open(c).read()
p = sys.argv[2]; t = open(p).read()
for f in ("NitroValidator", "CborDecode", "LibBytes"):
    old = f'from "nitro-validator/{f}.sol";'
    assert t.count(old) == 1, old
    t = t.replace(old, f'from "../vendor/nv-fork/src/{f}.sol";')
open(p, "w").write(t)
PY
grep -n "^import" "$W/src/EnclaveRegistry.sol"
git -c user.name=adv -c user.email=adv@invalid add -A >/dev/null && git -c user.name=adv -c user.email=adv@invalid commit -qm "registry imports a validator copy"
bash "$ROOT/scripts/adversary-t09/ci_guard.sh" "$OUT/fork" > "$OUT/guard.log" 2>&1; GUARD=$?
echo "guard_exit=$GUARD"; grep -h "^ok:\|^FAIL\|not allowed" "$OUT/guard.log" | head -4
[ "$GUARD" = 2 ] && { echo "harness error: ci_guard.sh could not run"; exit 2; }
bash "$ROOT/scripts/adversary-t09/ci_slither.sh" "$W" > "$OUT/slither.log" 2>&1; SLITHER=$?
echo "slither_exit=$SLITHER"; grep -h "result(s) found" "$OUT/slither.log" | tail -1
grep -h "High" "$OUT/slither.log" | head -3
if [ "$SLITHER" != 0 ] && ! grep -q "result(s) found" "$OUT/slither.log"; then
  echo "harness error: the Slither step failed without an analysis (see $OUT/slither.log)"; tail -5 "$OUT/slither.log"; exit 2
fi
python3 -I - "$W/out/build-info" <<'PY'
import glob, json, sys
for f in glob.glob(sys.argv[1] + "/*.json"):
    srcs = json.load(open(f))["input"]["sources"]
    for name in ("NitroValidator.sol", "CborDecode.sol"):
        got = sorted(k for k in srcs if k.endswith(name))
        fork = any("ADV-FORK" in srcs[k].get("content", "") for k in got)
        print(f"build-info: {name} compiled from {got}; ADV-FORK marker present: {fork}")
PY
if [ "$GUARD" = 0 ] && [ "$SLITHER" = 0 ]; then
  echo "verdict=PASSED_GATE (defect: EnclaveRegistry builds against a modified NitroValidator, every guard passes)"; exit 1
fi
echo "verdict=REJECTED"; exit 0
