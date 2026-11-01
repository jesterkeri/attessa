#!/usr/bin/env bash
# Adversary T09 r9, the other routes to the same redirect: each case changes the build Slither analyses
# without touching src/, and must fail the CI guard step. Each case is a throwaway git superproject
# (mkrepo.sh); the .env files exist only inside those scratch copies.
#   control  : the pinned tree, unchanged. The guard must pass, or the harness itself is broken.
#   dotenv   : a committed contracts/.env with FOUNDRY_SRC=lib/nitro-validator/src (forge loads it).
#   nested   : the same .env one folder down, at contracts/test/.env.
#   newlib   : a new folder lib/nv2/ holding a copy of the validator src/, which forge auto-detects as
#              the remapping nv2/=lib/nv2/src/.
#   allow    : allow_paths = ["../shared"] in foundry.toml, so the build can import from outside contracts/.
# The guard step is read from ci.yml (CI_YML=<path> to use a patched copy; see ci_guard.sh).
# Usage: build_redirects.sh <scratch-dir>. Exit 1 = some case passes the guard (defect), 0 = all
# rejected, 2 = harness error.
set -u
OUT=$1; HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
rm -rf "$OUT"; mkdir -p "$OUT"
. "$ROOT/scripts/adversary-t09/mkrepo.sh"
g() { git -c user.name=adv -c user.email=adv@invalid "$@"; }

guard() {  # guard <case>
  bash "$ROOT/scripts/adversary-t09/ci_guard.sh" "$OUT/$1" > "$OUT/$1.guard.log" 2>&1; local rc=$?
  echo "case=$1 guard_exit=$rc"; grep -h "^FAIL\|^ok:" "$OUT/$1.guard.log" | head -3
  return $rc
}
passed=0
verdict() { if [ "$2" = 0 ]; then echo "case=$1 verdict=PASSED_GATE (defect)"; passed=1; else echo "case=$1 verdict=REJECTED"; fi; }

mkrepo "$OUT/control" >/dev/null 2>&1 || { echo "harness error: could not build the scratch superproject"; exit 2; }
guard control || { echo "harness error: the guard fails the pinned, unchanged tree (see $OUT/control.guard.log)"; exit 2; }

mkrepo "$OUT/dotenv" >/dev/null 2>&1 || exit 2
printf 'FOUNDRY_SRC=lib/nitro-validator/src\n' > contracts/.env
g add -f contracts/.env && g commit -qm "contracts/.env"
guard dotenv; verdict dotenv $?

mkrepo "$OUT/nested" >/dev/null 2>&1 || exit 2
printf 'FOUNDRY_SRC=lib/nitro-validator/src\n' > contracts/test/.env
g add -f contracts/test/.env && g commit -qm "contracts/test/.env"
guard nested; verdict nested $?

mkrepo "$OUT/newlib" >/dev/null 2>&1 || exit 2
mkdir -p contracts/lib/nv2 && cp -r contracts/lib/nitro-validator/src contracts/lib/nv2/src
g add contracts/lib/nv2 && g commit -qm "lib/nv2"
guard newlib; verdict newlib $?

mkrepo "$OUT/allow" >/dev/null 2>&1 || exit 2
sed -i 's|^\[profile.default\]$|[profile.default]\nallow_paths = ["../shared"]|' contracts/foundry.toml
grep -n allow_paths contracts/foundry.toml
g commit -qam "allow_paths"
guard allow; verdict allow $?

[ "$passed" = 0 ] && { echo "verdict=REJECTED (every case fails the guard)"; exit 0; }
echo "verdict=PASSED_GATE (defect)"; exit 1
