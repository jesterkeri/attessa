#!/usr/bin/env bash
# Adversary T09 r11: check-slither-build.sh holds the source set of the src/ build (--skip ./test/**
# ./script/**), but the validator stack is deployed by a script (SPEC 3.5: DeployValidatorStack.s.sol
# deploys P384Verifier -> CertManager -> NitroValidator), and script/ is skipped by both the guard build
# and Slither. A deploy script that imports a modified copy from contracts/vendor/ deploys a validator
# that is not the pinned 0ea0d12 code, while the pin check, the config/remappings hashes, the src
# source-set check and Slither all pass.
#   fork : contracts/vendor/nv-fork/src = a copy of the pinned src/ whose NitroValidator gains a public
#          constant ADV_FORK (a bytecode-visible stand-in for any edit, e.g. one that skips certificate
#          checks); contracts/script/DeployValidatorStack.s.sol deploys the stack from that copy. Committed.
# Then the full `forge build` the CI contracts job runs, and which NitroValidator.sol the deploy script
# compiled, from its artifact's metadata.
# Usage: script_fork.sh <scratch-dir>. Exit 1 = the forked stack passes the gate (defect), 0 = rejected,
# 2 = harness error.
set -u
OUT=$1; HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
rm -rf "$OUT"; mkdir -p "$OUT"
. "$ROOT/scripts/adversary-t09/mkrepo.sh"
mkrepo "$OUT/fork" >/dev/null 2>&1 || { echo "harness error: could not build the scratch superproject"; exit 2; }
W="$OUT/fork/contracts"
mkdir -p "$W/vendor/nv-fork" "$W/script" && cp -r "$W/lib/nitro-validator/src" "$W/vendor/nv-fork/src"
python3 -I - "$W/vendor/nv-fork/src/NitroValidator.sol" <<'PY' || exit 2
import sys
p = sys.argv[1]; t = open(p).read()
old = "contract NitroValidator {"
assert t.count(old) == 1, "contract line not found"
open(p, "w").write(t.replace(old, old + "\n    uint256 public constant ADV_FORK = 1; // not the pinned 0ea0d12 code", 1))
PY
cat > "$W/script/DeployValidatorStack.s.sol" <<'SOL'
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {P384Verifier} from "../vendor/nv-fork/src/P384Verifier.sol";
import {CertManager} from "../vendor/nv-fork/src/CertManager.sol";
import {NitroValidator} from "../vendor/nv-fork/src/NitroValidator.sol";

contract DeployValidatorStack is Script {
    function run() external returns (NitroValidator validator) {
        vm.startBroadcast();
        P384Verifier p384 = new P384Verifier();
        CertManager certManager = new CertManager(p384, msg.sender, msg.sender);
        validator = new NitroValidator(certManager, p384);
        vm.stopBroadcast();
    }
}
SOL
git -c user.name=adv -c user.email=adv@invalid add -A >/dev/null && git -c user.name=adv -c user.email=adv@invalid commit -qm "deploy the validator stack from a copy"
bash "$ROOT/scripts/adversary-t09/ci_guard.sh" "$OUT/fork" > "$OUT/guard.log" 2>&1; GUARD=$?
echo "guard_exit=$GUARD"; grep -h "^ok:\|^FAIL\|^BAD\|not allowed" "$OUT/guard.log" | head -4
[ "$GUARD" = 2 ] && { echo "harness error: ci_guard.sh could not run"; exit 2; }
bash "$ROOT/scripts/adversary-t09/ci_slither.sh" "$W" > "$OUT/slither.log" 2>&1; SLITHER=$?
echo "slither_exit=$SLITHER"; grep -h "result(s) found" "$OUT/slither.log" | tail -1
if [ "$SLITHER" != 0 ] && ! grep -q "result(s) found" "$OUT/slither.log"; then
  echo "harness error: the Slither step failed without an analysis (see $OUT/slither.log)"; tail -5 "$OUT/slither.log"; exit 2
fi
# The CI contracts job's build (everything, script/ included), in a throwaway copy.
mkdir -p "$OUT/full" && rsync -a --exclude out --exclude cache "$W/" "$OUT/full/contracts/"
(cd "$OUT/full/contracts" && flock -w 1800 /home/hr/.cache/attessa-heavy.lock forge build > "$OUT/full.log" 2>&1); BUILD=$?
echo "forge_build_exit=$BUILD"
python3 -I - "$OUT/full/contracts/out" <<'PY'
import glob, json, sys
for f in glob.glob(sys.argv[1] + "/DeployValidatorStack.s.sol/*.json"):
    srcs = json.load(open(f))["metadata"]["sources"]
    print("DeployValidatorStack compiles NitroValidator from:", sorted(k for k in srcs if k.endswith("NitroValidator.sol")))
for f in sorted(glob.glob(sys.argv[1] + "/**/NitroValidator*.json", recursive=True)):
    a = json.load(open(f))
    target = a["metadata"]["settings"]["compilationTarget"]
    fork = any(e.get("name") == "ADV_FORK" for e in a["abi"])
    print(f"artifact {f[len(sys.argv[1]) + 1:]}: compiled from {list(target)}, has ADV_FORK(): {fork}")
PY
if [ "$GUARD" = 0 ] && [ "$SLITHER" = 0 ] && [ "$BUILD" = 0 ]; then
  echo "verdict=PASSED_GATE (defect: the deploy script builds a validator stack that is not the pinned code; every check passes)"; exit 1
fi
echo "verdict=REJECTED"; exit 0
