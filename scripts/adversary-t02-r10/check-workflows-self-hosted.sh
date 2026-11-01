#!/usr/bin/env bash
# T02 adversary r10: check-workflows.sh allow-lists the runs-on key but not its value. A pull_request
# job on runs-on: self-hosted runs every fork's code on a persistent machine of ours (its network,
# its disk, whatever later jobs leave there), which is more than read access. The repo uses only
# ubuntu-latest. check-workflows.sh must exit non-zero.
set -u
S="$(cd "$(dirname "$0")/../.." && pwd)/scripts/check-workflows.sh"
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
mkdir -p "$t/.github/workflows"
cat > "$t/.github/workflows/ci.yml" <<'Y'
name: ci
on:
  pull_request:
permissions:
  contents: read
jobs:
  a:
    runs-on: self-hosted
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          persist-credentials: false
      - run: ./build.sh
Y
out=$(cd "$t" && "$S" 2>&1); st=$?; echo "$out"
if [ $st -eq 0 ]; then echo "FAIL self-hosted: check-workflows.sh said clean"; exit 1; fi
echo "ok   self-hosted"
