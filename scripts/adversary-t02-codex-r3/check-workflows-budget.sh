#!/usr/bin/env bash
# T02 Codex r3 m1: check-workflows.sh accepted any timeout-minutes from 1 to 30, so jobs above their
# PIPELINE.md budget (ts 4, contracts 4, slither 3, enclave 5, harness jobs 1) passed. Each named job
# at its budget must be clean; one minute over must be refused; a job id PIPELINE does not name may
# take at most 1 (the strictest budget; T02 adversary r16).
set -u
S="$(cd "$(dirname "$0")/../.." && pwd)/scripts/check-workflows.sh"
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
rc=0
check() { # job-id minutes expect(clean|refused)
  d="$t/$1-$2"; mkdir -p "$d/.github/workflows"
  cat > "$d/.github/workflows/ci.yml" <<Y
name: ci
on:
  pull_request:
permissions:
  contents: read
jobs:
  $1:
    runs-on: ubuntu-latest
    timeout-minutes: $2
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          persist-credentials: false
      - run: ./build.sh
Y
  out=$(cd "$d" && "$S" 2>&1); st=$?
  if [ "$3" = clean ]; then
    if [ $st -ne 0 ]; then echo "$out"; echo "FAIL $1=$2: must be clean"; rc=1; else echo "ok   $1=$2 clean"; fi
  elif [ $st -eq 0 ] || ! grep -q "timeout-minutes" <<<"$out" || grep -q Traceback <<<"$out"; then
    echo "$out"; echo "FAIL $1=$2: check-workflows.sh did not refuse a timeout over the PIPELINE budget"; rc=1
  else echo "ok   $1=$2: $(grep -m1 '^FAIL ' <<<"$out")"; fi
}
check ts 4 clean;         check ts 5 refused
check contracts 4 clean;  check contracts 5 refused
check slither 3 clean;    check slither 4 refused
check enclave 5 clean;    check enclave 6 refused
check guardrails 1 clean; check guardrails 2 refused
check secrets 1 clean;    check secrets 2 refused
check other 1 clean;      check other 2 refused
exit $rc
