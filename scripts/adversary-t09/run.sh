#!/usr/bin/env bash
# Adversary T09: run Slither on a scratch copy of contracts/ with one mutation applied.
# Never touches the tracked tree. Usage: run.sh <mutant> <scratch-dir>
# Runs the CI guard step (ci_guard.sh) on the unbuilt copy first, then Slither, as the CI slither job does.
# Exit status: for the gate mutants (testimport libimport scriptimport outdir cachedir) 0 only if the gate
# rejects the mutant (guard fails, or Slither fails with a High not in slither.db.json); for clean 0 only
# if guard and Slither both pass; for the other mutants the report is informational and the exit is 0.
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
#   outdir    : src/out/AdvKillable.sol, a selfdestruct behind slither-disable-next-line comments
#   outdirplain: the same file without the comments (control)
#   cachedir  : the outdir mutant in src/cache/
#   testimport/libimport/scriptimport: src/AdvUser.sol inherits a selfdestruct from contracts/{test,lib,script}/AdvKillable.sol
#   clean     : no change; with ROOTCWD=1 runs the PIPELINE.md form from the repo root
set -u
MUT=$1; OUT=$2
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
rm -rf "$OUT/$MUT"
W="$OUT/$MUT/contracts"
# A git superproject copy (mkrepo.sh), so the CI guard step, pin check included, sees what CI sees.
. "$HERE/mkrepo.sh"
mkrepo "$OUT/$MUT" || { echo "harness error: could not build the scratch superproject"; exit 2; }
python3 -I "$HERE/mutate.py" "$MUT" "$W"
bash "$HERE/ci_guard.sh" "$OUT/$MUT" > "$OUT/$MUT/guard.log" 2>&1; GUARD=$?
echo "mutant=$MUT guard_exit=$GUARD"; tail -1 "$OUT/$MUT/guard.log"
[ "$GUARD" = 2 ] && { echo "harness error: ci_guard.sh could not run"; exit 2; }
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
SLITHER=$?
echo "mutant=$MUT slither_exit=$SLITHER"
tail -1 "$OUT/$MUT/slither.log"
SUMMARY=$(python3 -I "$HERE/summarize.py" "$OUT/$MUT/result.json" "$ROOT/contracts/slither.db.json")
printf '%s\n' "$SUMMARY"
NEWHIGH=$(printf '%s\n' "$SUMMARY" | sed -n 's/^new_high=\([0-9][0-9]*\)$/\1/p')
case "$MUT" in
  testimport|libimport|scriptimport|outdir|cachedir)
    if [ "$GUARD" = 1 ] || { [ "$SLITHER" != 0 ] && [ "${NEWHIGH:-0}" -gt 0 ]; }; then
      echo "verdict=REJECTED mutant=$MUT (gate holds)"; exit 0
    fi
    echo "verdict=PASSED_GATE mutant=$MUT (defect: deployed vulnerable code passes the Slither gate)"; exit 1 ;;
  clean)
    if [ "$GUARD" = 0 ] && [ "$SLITHER" = 0 ]; then echo "verdict=CLEAN_PASSES"; exit 0; fi
    echo "verdict=CLEAN_FAILS"; exit 1 ;;
esac
