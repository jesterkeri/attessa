#!/usr/bin/env bash
# T02 adversary r4: check-workflows.sh must reject an unpinned action wherever GitHub will run it.
# Each case is a tree that GitHub resolves to an unpinned action; the scanner must exit non-zero,
# and its only refusal must be that step's uses: (each fixture is valid in every other respect).
set -u
S="$(cd "$(dirname "$0")/../.." && pwd)/scripts/check-workflows.sh"
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fails=0
expect_fail() { # name dir pattern-of-the-one-refusal
  local out st; out=$(cd "$2" && "$S" 2>&1); st=$?
  if [ $st -eq 0 ] || [ "$(grep -c '^FAIL ' <<<"$out")" != 1 ] || ! grep -qE "^FAIL .*$3" <<<"$out"; then
    echo "$out"; echo "FAIL $1: check-workflows.sh did not refuse it for exactly this reason: $3"; fails=1
  else echo "ok   $1: $out"; fi
}

# 1. a local composite action: ci.yml is pinned, the composite it calls is not.
mkdir -p "$t/c/.github/workflows" "$t/c/.github/actions/setup"
cat > "$t/c/.github/workflows/ci.yml" <<'Y'
on:
  pull_request:
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          persist-credentials: false
      - uses: ./.github/actions/setup
Y
cat > "$t/c/.github/actions/setup/action.yml" <<'Y'
name: setup
runs:
  using: composite
  steps:
    - uses: tj-actions/changed-files@v35
Y
expect_fail composite-action "$t/c" "steps\[1\]\.uses: '\./\.github/actions/setup' is not an allowed action"

# 2. a quoted key: YAML loads "uses": x exactly as uses: x.
mkdir -p "$t/q/.github/workflows"
cat > "$t/q/.github/workflows/ci.yml" <<'Y'
on:
  pull_request:
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - "uses": actions/checkout@v4
        with:
          persist-credentials: false
Y
expect_fail quoted-key "$t/q" "steps\[0\]\.uses: 'actions/checkout@v4' is not an allowed action"
exit $fails
