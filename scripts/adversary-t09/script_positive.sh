#!/usr/bin/env bash
# T09 r11 positive cases for the deploy-build source-set check (scripts/check-slither-build.sh): the
# CI guard step must still pass on trees a real deploy needs. Each case is a throwaway git superproject
# (mkrepo.sh), never the tracked tree.
#   noscript : the pinned tree as it is, with no contracts/script/ folder.
#   plain    : contracts/script/DeployRegistry.s.sol, which imports forge-std/Script.sol (resolved
#              through the pinned remapping) and ../src/EnclaveRegistry.sol, and nothing else.
# The guard step is read from ci.yml (CI_YML=<path> to use a patched copy; see ci_guard.sh).
# Usage: script_positive.sh <scratch-dir>. Exit 0 = both pass the guard, 1 = one fails, 2 = harness error.
set -u
OUT=$1; HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
rm -rf "$OUT"; mkdir -p "$OUT"
. "$HERE/mkrepo.sh"
failed=0
guard() {  # guard <case>
  bash "$HERE/ci_guard.sh" "$OUT/$1" > "$OUT/$1.guard.log" 2>&1; local rc=$?
  echo "case=$1 guard_exit=$rc"; grep -h "^ok:\|^FAIL\|^src/\|^script/\|^lib/\|^vendor/" "$OUT/$1.guard.log" | head -8
  [ "$rc" = 2 ] && { echo "harness error: ci_guard.sh could not run"; exit 2; }
  if [ "$rc" = 0 ]; then echo "case=$1 verdict=PASSES"; else echo "case=$1 verdict=FAILS_GUARD"; failed=1; fi
}

mkrepo "$OUT/noscript" >/dev/null 2>&1 || { echo "harness error: could not build the scratch superproject"; exit 2; }
[ ! -e contracts/script ] || { echo "harness error: contracts/script/ already exists"; exit 2; }
guard noscript

mkrepo "$OUT/plain" >/dev/null 2>&1 || exit 2
mkdir -p contracts/script
cat > contracts/script/DeployRegistry.s.sol <<'SOL'
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {EnclaveRegistry} from "../src/EnclaveRegistry.sol";

contract DeployRegistry is Script {
    function run() external view returns (bytes32 codeHash) {
        codeHash = keccak256(type(EnclaveRegistry).creationCode);
    }
}
SOL
git -c user.name=adv -c user.email=adv@invalid add -A >/dev/null &&
  git -c user.name=adv -c user.email=adv@invalid commit -qm "plain deploy script"
guard plain

[ "$failed" = 0 ] && { echo "verdict=PASSES (both trees pass the guard)"; exit 0; }
echo "verdict=FAILS_GUARD"; exit 1
