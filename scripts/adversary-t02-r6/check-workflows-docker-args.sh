#!/usr/bin/env bash
# T02 adversary r6: PIPELINE "No step interpolates ${{ github.event.* }} text into shell". A docker step
# with entrypoint sh and args -c "..." puts the expanded PR title into a shell script, outside run:.
# check-workflows.sh must exit non-zero.
set -u
S="$(cd "$(dirname "$0")/../.." && pwd)/scripts/check-workflows.sh"
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
mkdir -p "$t/.github/workflows"
cat > "$t/.github/workflows/ci.yml" <<'Y'
on: pull_request
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: docker://alpine@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1
        with:
          entrypoint: sh
          args: -c "echo ${{ github.event.pull_request.title }}"
Y
if (cd "$t" && "$S" >/dev/null 2>&1); then echo "FAIL docker-sh-args: check-workflows.sh said clean"; exit 1; fi
echo "ok   docker-sh-args"
