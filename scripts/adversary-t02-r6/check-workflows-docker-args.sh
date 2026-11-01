#!/usr/bin/env bash
# T02 adversary r6: PIPELINE "No step interpolates ${{ github.event.* }} text into shell". A docker step
# with entrypoint sh and args -c "..." puts the expanded PR title into a shell script, outside run:.
# check-workflows.sh must exit non-zero, and its only refusal must be the docker:// step (the fixture
# is valid in every other respect).
set -u
S="$(cd "$(dirname "$0")/../.." && pwd)/scripts/check-workflows.sh"
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
mkdir -p "$t/.github/workflows"
cat > "$t/.github/workflows/ci.yml" <<'Y'
on:
  pull_request:
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: docker://alpine@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1
        with:
          entrypoint: sh
          args: -c "echo ${{ github.event.pull_request.title }}"
Y
out=$(cd "$t" && "$S" 2>&1); st=$?
if [ $st -eq 0 ] || [ "$(grep -c '^FAIL ' <<<"$out")" != 1 ] || ! grep -q "^FAIL .*steps\[0\]\.uses: 'docker://alpine@sha256:" <<<"$out"; then
  echo "$out"; echo "FAIL docker-sh-args: check-workflows.sh did not refuse exactly the docker:// step"; exit 1
fi
echo "ok   docker-sh-args: $out"
