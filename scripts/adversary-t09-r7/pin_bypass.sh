#!/usr/bin/env bash
# Adversary T09 r7: the Slither scope drops lib/nitro-validator/ because it is "pinned at 0ea0d12"
# (docs/SLITHER_TRIAGE.md, adr/001), but nothing checks the gitlink. A PR that moves the submodule to
# another commit can carry a vulnerable contract there, and a src/ contract that inherits it is
# deployed with the vulnerability while the CI guard and Slither both pass.
# Each case is a throwaway git superproject under <scratch-dir>: this repo's contracts/, scripts/ and
# .gitmodules, with lib/nitro-validator cloned from the local submodule at 0ea0d12 (forge-std inside
# it at its recorded commit), so the gitlink and .gitmodules are real, as CI checks them out.
#   control : the pinned tree, unchanged. The guard must pass, or the harness itself is broken.
#   moved   : a new commit in the submodule adds a selfdestruct contract, the gitlink moves to it,
#             src/AdvUser.sol inherits it. Guard, then Slither.
#   url     : .gitmodules points the submodule at another url, gitlink unchanged. Guard only.
#   dirty   : the same contract written into the submodule's working tree, uncommitted. Guard, then Slither.
# The guard step is read from ci.yml (CI_YML=<path> to use a patched copy; see ci_guard.sh).
# Usage: pin_bypass.sh <scratch-dir>. Exit 1 = some case passes the gate (defect), 0 = all rejected,
# 2 = harness error.
set -u
OUT=$1; HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
echo "-- pin enforcement in the repo (anything comparing the gitlink to 0ea0d12):"
git -C "$ROOT" grep -n "0ea0d12" -- ':!docs' ':!adr' ':!*.md' ':!scripts/adversary-*' || echo "none"
git -C "$ROOT" ls-files -s contracts/lib/nitro-validator
rm -rf "$OUT"; mkdir -p "$OUT"
g() { git -c user.name=adv -c user.email=adv@invalid -c advice.addEmbeddedRepo=false "$@"; }

KILL='// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract AdvKillable {
    function advKill() external {
        selfdestruct(payable(msg.sender));
    }

    function advSweep(address payable to) external {
        to.transfer(address(this).balance);
    }
}'
USER='// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AdvKillable} from "nitro-validator/AdvKillable.sol";

contract AdvUser is AdvKillable {}'

. "$ROOT/scripts/adversary-t09/mkrepo.sh"

guard() {  # guard <case>: the CI guard step on the case's superproject
  bash "$ROOT/scripts/adversary-t09/ci_guard.sh" "$OUT/$1" > "$OUT/$1.guard.log" 2>&1; local rc=$?
  echo "case=$1 guard_exit=$rc"; grep -h "^FAIL\|^symlinks under\|^slither-disable comments\|No such file" "$OUT/$1.guard.log" | head -3
  return $rc
}

slither_run() {  # slither_run <case>
  (cd "$OUT/$1/contracts" && flock -w 1800 /home/hr/.cache/attessa-heavy.lock \
    slither . --config-file slither.config.json --fail-high > "$OUT/$1.slither.log" 2>&1); local rc=$?
  echo "case=$1 slither_exit=$rc"; grep -h "result(s) found" "$OUT/$1.slither.log" | tail -1
  [ -d "$OUT/$1/contracts/out/AdvUser.sol" ] && echo "built: out/AdvUser.sol (AdvUser inherits advKill/advSweep)"
  return $rc
}

passed=0
verdict() {  # verdict <case> <guard_rc> [<slither_rc>]
  if [ "$2" = 0 ] && [ "${3:-0}" = 0 ]; then echo "case=$1 verdict=PASSED_GATE (defect)"; passed=1
  else echo "case=$1 verdict=REJECTED"; fi
}

mkrepo "$OUT/control" || { echo "harness error: could not build the scratch superproject"; exit 2; }
guard control; rc=$?
[ "$rc" = 0 ] || { echo "harness error: the guard fails the pinned, unchanged tree (see $OUT/control.guard.log)"; exit 2; }

mkrepo "$OUT/moved" || exit 2
printf '%s\n' "$KILL" > contracts/lib/nitro-validator/src/AdvKillable.sol
g -C contracts/lib/nitro-validator add -A && g -C contracts/lib/nitro-validator commit -qm "add AdvKillable"
printf '%s\n' "$USER" > contracts/src/AdvUser.sol
g add -A && g commit -qm "move nitro-validator; AdvUser inherits from it"
git ls-files -s contracts/lib/nitro-validator
guard moved; grc=$?; slither_run moved; src=$?; verdict moved $grc $src

mkrepo "$OUT/url" || exit 2
git config -f .gitmodules submodule.contracts/lib/nitro-validator.url https://github.com/adv/nitro-validator
g add .gitmodules && g commit -qm "point nitro-validator at another url"
guard url; verdict url $?

mkrepo "$OUT/dirty" || exit 2
printf '%s\n' "$KILL" > contracts/lib/nitro-validator/src/AdvKillable.sol
printf '%s\n' "$USER" > contracts/src/AdvUser.sol
guard dirty; grc=$?; slither_run dirty; src=$?; verdict dirty $grc $src

[ "$passed" = 0 ] && { echo "verdict=REJECTED (every case fails the gate)"; exit 0; }
echo "verdict=PASSED_GATE (defect)"; exit 1
