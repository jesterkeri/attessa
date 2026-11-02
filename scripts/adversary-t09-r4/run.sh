#!/usr/bin/env bash
# Adversary T09: run Slither on a scratch copy of contracts/ with one mutation applied.
# Never touches the tracked tree. Usage: run.sh <mutant> <scratch-dir>
#   nofilter  : unmodified src, path filters removed, --show-ignored-findings (what the filter hides)
#   high      : unprotected selfdestruct + arbitrary send appended to EnclaveRegistry (expect exit != 0)
#   sameline  : length guards removed on the same lines (expect the two High collisions to stay suppressed)
#   pathname  : the same selfdestruct contract placed at src/Transcript.sol (expect it to be filtered)
#   control   : the same selfdestruct contract at src/Sweeper.sol (expect exit != 0)
#   libhigh   : a High (reentrancy-eth) whose elements span src/ and lib/ (expect exit != 0)
#   outside   : src/AdvUser.sol inherits a selfdestruct from contracts/shared/ (deployed code outside src/)
#   highnodeps: high with exclude_dependencies false (attribution, run under a lib/ ancestor)
#   srclib    : the selfdestruct contract at src/lib/AdvKillable.sol
#   deployedlib      : src imports CertManager + P384Verifier, path filter removed, show ignored (all findings in the deployed stack)
#   deployedlibgated : the same imports under the real config (what the gate reports)
#   symlink   : src/AdvLink.sol symlinks to a selfdestruct contract outside contracts/
#   inlinecomment    : high, with // slither-disable-next-line all above each new function
#   outsiderepo(allow): src/AdvUser.sol inherits a selfdestruct from ../shared/ (outside contracts/)
#   clean     : no change; with ROOTCWD=1 runs the PIPELINE.md form from the repo root
set -u
MUT=$1; OUT=$2
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
rm -rf "$OUT/$MUT"; mkdir -p "$OUT/$MUT"
W="$OUT/$MUT/contracts"
rsync -a --exclude out --exclude cache "$ROOT/contracts/" "$W/"
python3 -I "$HERE/mutate.py" "$MUT" "$W"
ARGS=(. --config-file slither.config.json --fail-high --json "$OUT/$MUT/result.json")
case "$MUT" in nofilter|deployedlib) ARGS+=(--show-ignored-findings) ;; esac
if [ "${ROOTCWD:-0}" = 1 ]; then
  # PIPELINE.md form: slither contracts --config-file contracts/slither.config.json --fail-high
  ARGS=(contracts --config-file contracts/slither.config.json --fail-high --json "$OUT/$MUT/result.json")
  cd "$OUT/$MUT"
else
  cd "$W"
fi
flock -w 1800 /home/hr/.cache/attessa-heavy.lock slither "${ARGS[@]}" > "$OUT/$MUT/slither.log" 2>&1
echo "mutant=$MUT slither_exit=$?"
tail -1 "$OUT/$MUT/slither.log"
python3 -I "$HERE/summarize.py" "$OUT/$MUT/result.json" "$ROOT/contracts/slither.db.json"
