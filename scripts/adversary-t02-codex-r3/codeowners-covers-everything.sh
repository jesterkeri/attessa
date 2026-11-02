#!/usr/bin/env bash
# T02 Codex r3 M1: .github/CODEOWNERS listed CI and guard paths but not the toolchain selectors CI
# runs (.nvmrc, rust-toolchain.toml, contracts/FOUNDRY_VERSION), so a PR could swap a toolchain
# without code-owner review. Every tracked file, including those three and any new file a PR adds,
# must be owned, so CODEOWNERS must hold exactly one rule, the catch-all `* @owner`. Any second
# rule, even an owned one, fails here: a later rule overrides the catch-all for its paths, so adding
# one needs a deliberate edit of this test.
set -u
R="$(cd "$(dirname "$0")/../.." && pwd)"; F="$R/.github/CODEOWNERS"
[ -f "$F" ] || { echo "FAIL: no .github/CODEOWNERS"; exit 1; }
rules=$(grep -v '^[[:space:]]*#' "$F" | grep -v '^[[:space:]]*$')
n=$(printf '%s\n' "$rules" | grep -c .)
if [ "$n" != 1 ] || ! grep -Eqx '\*[[:space:]]+@[A-Za-z0-9-]+[[:space:]]*' <<<"$rules"; then
  echo "FAIL: CODEOWNERS must hold exactly one rule, '* @owner'; it has $n:"; printf '%s\n' "$rules"; exit 1
fi
echo "ok   the only rule is the catch-all: $rules"
