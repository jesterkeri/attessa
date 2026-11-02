#!/usr/bin/env bash
# T02 adversary r16: check-workflows.sh looks up the PIPELINE.md budget by job id, and any id it does
# not know gets 5 minutes. PIPELINE names jobs by what the required checks show, the job name, and
# gives every harness job 1 minute. Each case is the repo's own workflow with one change, valid in
# every other respect: (1) ci.yml's ts job keeps name: ts but its id becomes typescript, at 5
# minutes; (2) harness.yml's guardrails job keeps name: guardrails, id guard, at 5 minutes;
# (3) harness.yml gains a reviews job (a PIPELINE harness job) at 5 minutes. Each must be refused.
set -u
R="$(cd "$(dirname "$0")/../.." && pwd)"; S="$R/scripts/check-workflows.sh"
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
rc=0
case_() { # name, file, python edit of the text
  d="$t/$1"; mkdir -p "$d/.github/workflows"; cp "$R/.github/workflows/$2" "$d/.github/workflows/$2"
  python3 -I -c "import sys; p=sys.argv[1]; s=open(p).read(); n=$3; assert n!=s, 'edit did not apply'; open(p,'w').write(n)" "$d/.github/workflows/$2" || { echo "FAIL $1: setup"; rc=1; return; }
  out=$(cd "$d" && "$S" 2>&1); st=$?
  if [ $st -eq 0 ]; then echo "$out"; echo "FAIL $1: check-workflows.sh said clean"; rc=1; else echo "ok   $1: $(grep -m1 '^FAIL ' <<<"$out")"; fi
}
case_ ts-renamed-id ci.yml 's.replace("  ts:\n    name: ts\n    runs-on: ubuntu-latest\n    timeout-minutes: 4", "  typescript:\n    name: ts\n    runs-on: ubuntu-latest\n    timeout-minutes: 5")'
case_ guardrails-renamed-id harness.yml 's.replace("  guardrails:\n    name: guardrails\n    runs-on: ubuntu-latest\n    timeout-minutes: 1", "  guard:\n    name: guardrails\n    runs-on: ubuntu-latest\n    timeout-minutes: 5")'
case_ harness-new-job harness.yml 's.replace("\n  secrets:\n", "\n  reviews:\n    name: reviews\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - name: Review integrity\n        run: ./scripts/check-reviews.sh\n\n  secrets:\n", 1)'
exit $rc
