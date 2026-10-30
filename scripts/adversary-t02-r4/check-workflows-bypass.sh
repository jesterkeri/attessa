#!/usr/bin/env bash
# T02 adversary r4: check-workflows.sh must reject an unpinned action wherever GitHub will run it.
# Each case is a tree that GitHub resolves to an unpinned action; the scanner must exit non-zero.
set -u
S="$(cd "$(dirname "$0")/../.." && pwd)/scripts/check-workflows.sh"
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fails=0
expect_fail() { # name dir
  if (cd "$2" && "$S" >/dev/null 2>&1); then echo "FAIL $1: check-workflows.sh said clean"; fails=1; else echo "ok   $1"; fi
}

# 1. a local composite action: ci.yml is pinned, the composite it calls is not.
mkdir -p "$t/c/.github/workflows" "$t/c/.github/actions/setup"
cat > "$t/c/.github/workflows/ci.yml" <<'Y'
on: pull_request
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
      - uses: ./.github/actions/setup
Y
cat > "$t/c/.github/actions/setup/action.yml" <<'Y'
name: setup
runs:
  using: composite
  steps:
    - uses: tj-actions/changed-files@v35
Y
expect_fail composite-action "$t/c"

# 2. a quoted key: YAML loads "uses": x exactly as uses: x.
mkdir -p "$t/q/.github/workflows"
cat > "$t/q/.github/workflows/ci.yml" <<'Y'
on: pull_request
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - "uses": actions/checkout@v4
Y
expect_fail quoted-key "$t/q"
exit $fails
