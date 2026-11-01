#!/usr/bin/env bash
# T02 r10: allow-listed keys whose values were not checked. Each case is one valid workflow with a
# single value changed; check-workflows.sh must fail every one: a long timeout, a working-directory
# outside the checkout, a cancel-in-progress that is not a boolean, a checkout that keeps (or does
# not refuse) the token on disk, and action inputs other than the values this repo uses.
set -u
S="$(cd "$(dirname "$0")/../.." && pwd)/scripts/check-workflows.sh"
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
rc=0
run() {  # name, then sed expression applied to the base workflow
  rm -rf "$t/w"; mkdir -p "$t/w/.github/workflows"
  cat > "$t/w/.github/workflows/ci.yml" <<'Y'
name: ci
on:
  pull_request:
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  a:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          persist-credentials: false
          submodules: recursive
          fetch-depth: 0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version-file: .nvmrc
      - id: foundry
        run: echo "version=v1.0.0" >> "$GITHUB_OUTPUT"
      - uses: foundry-rs/foundry-toolchain@dba66c27052e63476d886f22216e119ba7e615bf # v1.9.2
        with:
          version: ${{ steps.foundry.outputs.version }}
      - run: forge build
        working-directory: contracts
Y
  [ -n "$2" ] && sed -i "$2" "$t/w/.github/workflows/ci.yml"
  out=$(cd "$t/w" && "$S" 2>&1); st=$?
  if [ "$1" = base ]; then
    if [ $st -ne 0 ]; then echo "$out"; echo "FAIL base: the unchanged workflow must be clean"; rc=1; else echo "ok   base clean"; fi
  elif [ $st -eq 0 ] || ! grep -q '^FAIL ' <<<"$out" || grep -q Traceback <<<"$out"; then echo "$out"; echo "FAIL $1: check-workflows.sh did not refuse it"; rc=1
  else echo "ok   $1: $(grep -m1 '^FAIL ' <<<"$out")"; fi
}
run base ''
run timeout-long 's/timeout-minutes: 1/timeout-minutes: 600/'
run timeout-string 's/timeout-minutes: 1/timeout-minutes: "1"/'
run workdir-parent 's/working-directory: contracts/working-directory: ..\/..\/tmp/'
run workdir-absolute 's/working-directory: contracts/working-directory: \/tmp/'
run cancel-string 's/cancel-in-progress: true/cancel-in-progress: maybe/'
run persist-true 's/persist-credentials: false/persist-credentials: true/'
run persist-missing '/persist-credentials: false/d'
run submodules-other 's/submodules: recursive/submodules: evil/'
run fetch-depth-negative 's/fetch-depth: 0/fetch-depth: -1/'
run node-version-file-other 's/node-version-file: .nvmrc/node-version-file: ..\/x/'
run foundry-version-literal 's/version: \${{ steps.foundry.outputs.version }}/version: nightly/'
exit $rc
