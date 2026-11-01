#!/usr/bin/env bash
# Adversary T09 r8: docs/SLITHER_TRIAGE.md says contracts/slither.db.json is "the only place a result
# may be suppressed". Slither 0.11.6 also reads a second triage source by default, from the working
# directory: export.sarif plus export.sarif.sarifexplorer (sarif_input / sarif_triage defaults,
# slither/utils/command_line.py:75-76). Every result in export.sarif whose index the .sarifexplorer file
# marks status 1 has its partialFingerprints.id added to the hidden ids
# (slither/core/slither_core.py:569-581, slither/utils/sarif.py:22-71). Neither file contains the text
# "slither-disable", so the CI guard step does not see them.
#   sarif : the "high" mutant (unprotected selfdestruct + arbitrary send in EnclaveRegistry.sol) with
#           contracts/export.sarif and contracts/export.sarif.sarifexplorer hiding its two Highs.
# Steps: scratch superproject (mkrepo.sh, so the pin check runs as in CI); Slither once to learn the
# new High ids (as a SARIF export would); write the two files; CI guard step from ci.yml; the CI
# Slither step from ci.yml. CI_YML=<path> reads both steps from a patched copy of ci.yml.
# Usage: sarif_triage.sh <scratch-dir>. Exit 1 = the Highs pass the gate (defect), 0 = rejected,
# 2 = harness error.
set -u
OUT=$1; HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
rm -rf "$OUT"; mkdir -p "$OUT"
. "$ROOT/scripts/adversary-t09/mkrepo.sh"
mkrepo "$OUT/sarif" || { echo "harness error: could not build the scratch superproject"; exit 2; }
W="$OUT/sarif/contracts"
python3 -I "$ROOT/scripts/adversary-t09/mutate.py" high "$W" || exit 2

# 1. Learn the ids of the new Highs (outside the superproject, so no build output lands in it; the
#    copy sits in a folder named contracts/ because include_paths matches on that name).
mkdir -p "$OUT/probe" && rsync -a "$W/" "$OUT/probe/contracts/"
(cd "$OUT/probe/contracts" && flock -w 1800 /home/hr/.cache/attessa-heavy.lock \
  slither . --config-file slither.config.json --json "$OUT/first.json" > "$OUT/first.log" 2>&1)
python3 -I - "$OUT/first.json" "$W" <<'PY' || exit 2
import json, sys
res = json.load(open(sys.argv[1]))
highs = [r for r in res["results"]["detectors"] if r["impact"] == "High"
         and any(e.get("source_mapping", {}).get("filename_relative") == "src/EnclaveRegistry.sol"
                 for e in r["elements"])]
db = {r["id"] for r in json.load(open(sys.argv[2] + "/slither.db.json"))}
new = [r for r in highs if r["id"] not in db]
if not new:
    sys.exit("harness error: the high mutant produced no new High")
for r in new:
    print(f"new High to hide: {r['id'][:12]} {r['check']}")
# 2. The two triage files Slither reads from its working directory.
sarif = {"version": "2.1.0", "runs": [{"tool": {"driver": {"name": "Slither"}},
         "results": [{"ruleId": r["check"], "partialFingerprints": {"id": r["id"]}} for r in new]}]}
json.dump(sarif, open(sys.argv[2] + "/export.sarif", "w"))
json.dump({"resultIdToNotes": {f"r:0:{i}": {"status": 1} for i in range(len(new))}},
          open(sys.argv[2] + "/export.sarif.sarifexplorer", "w"))
PY
git -C "$OUT/sarif" status --porcelain

# 3. The CI guard step (pin check, symlinks, slither-disable) on the unbuilt superproject.
bash "$ROOT/scripts/adversary-t09/ci_guard.sh" "$OUT/sarif" > "$OUT/guard.log" 2>&1; GUARD=$?
echo "guard_exit=$GUARD"; grep -h "^ok:\|^FAIL\|not allowed" "$OUT/guard.log" | head -3
[ "$GUARD" = 2 ] && { echo "harness error: ci_guard.sh could not run"; exit 2; }

# 4. Slither as the CI job runs it: the Slither step read from ci.yml (CI_YML=<path> for a patched copy).
bash "$ROOT/scripts/adversary-t09/ci_slither.sh" "$W" > "$OUT/second.log" 2>&1; SLITHER=$?
grep -h "^ *slither \." "$OUT/second.log" | head -1
echo "slither_exit=$SLITHER"; grep -h "result(s) found" "$OUT/second.log" | tail -1
if [ "$SLITHER" != 0 ] && ! grep -q "result(s) found" "$OUT/second.log"; then
  echo "harness error: the Slither step failed without an analysis (see $OUT/second.log)"; exit 2
fi
if [ "$GUARD" = 0 ] && [ "$SLITHER" = 0 ]; then
  echo "verdict=PASSED_GATE (defect: a selfdestruct in src/EnclaveRegistry.sol is hidden outside slither.db.json)"; exit 1
fi
echo "verdict=REJECTED"; exit 0
