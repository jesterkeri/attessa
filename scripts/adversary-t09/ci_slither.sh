#!/usr/bin/env bash
# Runs the slither job's Slither step exactly as .github/workflows/ci.yml defines it: the `run:` of the
# step with working-directory contracts that calls `slither .`, extracted at run time, in <contracts-dir>
# under the heavy lock. CI_YML=<path> reads the step from another copy of ci.yml (for example one with
# a proposed patch applied). Usage: ci_slither.sh <contracts-dir>   (GitHub runs `run:` with bash -e {0})
set -u
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
STEP=$(python3 -I - "${CI_YML:-$ROOT/.github/workflows/ci.yml}" <<'PY'
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
runs = [s["run"] for s in wf["jobs"]["slither"]["steps"]
        if s.get("working-directory") == "contracts" and "slither ." in s.get("run", "")]
if len(runs) != 1:
    sys.exit(f"expected one Slither step in the slither job, found {len(runs)}")
sys.stdout.write(runs[0])
PY
) || exit 2
echo "--- slither step from ${CI_YML:-ci.yml}:"; printf '%s\n' "$STEP"; echo "---"
cd "$1" || exit 2
flock -w 1800 /home/hr/.cache/attessa-heavy.lock bash --noprofile --norc -eo pipefail -c "$STEP"
