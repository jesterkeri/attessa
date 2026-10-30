#!/usr/bin/env bash
# T02 adversary r5: PIPELINE "No step interpolates ${{ github.event.* }} text into shell". Each case is a
# run step that interpolates attacker-controlled event text; check-workflows.sh must exit non-zero.
set -u
S="$(cd "$(dirname "$0")/../.." && pwd)/scripts/check-workflows.sh"
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fails=0
case_() { # name, run line, dir under .github holding the file, file name
  d="$t/$1"; mkdir -p "$d/.github/workflows" "$d/.github/$3"
  printf 'on: pull_request\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: %s\n' "$2" > "$d/.github/$3/$4"
  if (cd "$d" && "$S" >/dev/null 2>&1); then echo "FAIL $1: check-workflows.sh said clean"; fails=1; else echo "ok   $1"; fi
}
case_ head-ref    'echo "${{ github.event.pull_request.head.ref }}"' workflows ci.yml
case_ bracket     "echo \"\${{ github.event['pull_request']['title'] }}\"" workflows ci.yml
case_ env-comment 'echo "${{ github.event.pull_request.title }}" # env: none' workflows ci.yml
exit $fails
