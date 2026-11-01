#!/usr/bin/env bash
# T02 Codex r2 m1: check-workflows.sh treated a job with no timeout-minutes as if it had 1, so a job
# that GitHub runs under its default (hours) passed. A workflow that is clean except for a missing
# timeout-minutes must be refused, and the same workflow with it must be clean.
set -u
S="$(cd "$(dirname "$0")/../.." && pwd)/scripts/check-workflows.sh"
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
mkdir -p "$t/a/.github/workflows" "$t/b/.github/workflows"
cat > "$t/a/.github/workflows/ci.yml" <<'Y'
name: ci
on:
  pull_request:
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          persist-credentials: false
      - run: ./build.sh
Y
sed '/timeout-minutes/d' "$t/a/.github/workflows/ci.yml" > "$t/b/.github/workflows/ci.yml"
rc=0
out=$(cd "$t/a" && "$S" 2>&1) || { echo "$out"; echo "FAIL with-timeout: must be clean"; rc=1; }
[ $rc -eq 0 ] && echo "ok   with-timeout: $out"
out=$(cd "$t/b" && "$S" 2>&1); st=$?
if [ $st -eq 0 ] || ! grep -q "timeout-minutes" <<<"$out"; then echo "$out"; echo "FAIL timeout-missing: check-workflows.sh did not refuse a job with no timeout-minutes"; rc=1
else echo "ok   timeout-missing: $(grep -m1 '^FAIL ' <<<"$out")"; fi
exit $rc
