#!/usr/bin/env bash
# Runs the slither job's guard step exactly as .github/workflows/ci.yml in this worktree defines it:
# the `run:` of the step that checks for symlinks and slither-disable comments, extracted at run time.
# Usage: ci_guard.sh <dir-holding-contracts/>   (GitHub runs `run:` steps with bash -e {0})
# CI_YML=<path> reads the step from another copy of ci.yml (for example one with a proposed patch applied).
set -u
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
STEP=$(python3 -I - "${CI_YML:-$ROOT/.github/workflows/ci.yml}" <<'PY'
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
runs = [s["run"] for s in wf["jobs"]["slither"]["steps"]
        if "run" in s and "slither-disable" in s["run"] and "-type l" in s["run"]]
if len(runs) != 1:
    sys.exit(f"expected one guard step in the slither job, found {len(runs)}")
sys.stdout.write(runs[0])
PY
) || exit 2
echo "--- guard step from ${CI_YML:-ci.yml}:"; printf '%s\n' "$STEP"; echo "---"
cd "$1" || exit 2
# Under the heavy lock: the step builds contracts/src (scripts/check-slither-build.sh). Never call this under flock.
flock -w 1800 /home/hr/.cache/attessa-heavy.lock bash --noprofile --norc -eo pipefail -c "$STEP"
