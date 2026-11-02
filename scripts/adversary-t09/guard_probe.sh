#!/usr/bin/env bash
# Adversary T09 r4: does the ci.yml slither symlink guard catch a symlink that reaches Slither?
# Builds throwaway git repos under <scratch-dir>, never touches the tracked tree.
# Usage: guard_probe.sh <scratch-dir>
set -u
T=$1; HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
rm -rf "$T"; mkdir -p "$T/outside"
python3 -I - "$T/outside/AdvKillable.sol" <<'PY'
import sys
open(sys.argv[1], "w").write("""// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract AdvKillable {
    function advKill() external {
        selfdestruct(payable(msg.sender));
    }

    function advSweep(address payable to) external {
        to.transfer(address(this).balance);
    }
}
""")
PY
# The guard, verbatim from .github/workflows/ci.yml (slither job).
guard() {
  links=$(git ls-files -s contracts | awk '$1 == "120000" {print $4}')
  if [ -n "$links" ]; then echo "symlinks under contracts/ are not allowed:"; echo "$links"; return 1; fi
  return 0
}
g() { git -c user.name=adv -c user.email=adv@invalid -c protocol.file.allow=always "$@"; }

# Superproject: contracts/ as plain files (lib included, no nested .git).
mkdir -p "$T/repo" && cd "$T/repo" && git init -q
rsync -a --exclude out --exclude cache --exclude .git "$ROOT/contracts/" contracts/
g add -A >/dev/null && g commit -qm base

echo "== case A: committed symlink contracts/src/AdvLink.sol (round-3 attack)"
ln -s ../../../outside/AdvKillable.sol contracts/src/AdvLink.sol
g add contracts/src/AdvLink.sol && g commit -qm link
guard; echo "guard_exit=$?"
g rm -q contracts/src/AdvLink.sol && g commit -qm unlink

echo "== case B: submodule at contracts/src/ext whose file is a symlink out of contracts/"
mkdir -p "$T/ext" && (cd "$T/ext" && git init -q && ln -s ../../../../outside/AdvKillable.sol Evil.sol \
  && g add Evil.sol && g commit -qm ext)
g submodule add -q "$T/ext" contracts/src/ext && g commit -qm sub
git ls-files -s contracts/src/ext
ls -l contracts/src/ext/Evil.sol | awk '{print $9, $10, $11}'
guard; echo "guard_exit=$?"
echo "-- slither on case B"
cd contracts && flock -w 1800 /home/hr/.cache/attessa-heavy.lock slither . --config-file slither.config.json --fail-high > "$T/slither-B.log" 2>&1
echo "slither_exit=$?"; grep -E "result\(s\) found|suicidal|arbitrary-send|Error" "$T/slither-B.log" | head -5
ls out | grep -i evil
