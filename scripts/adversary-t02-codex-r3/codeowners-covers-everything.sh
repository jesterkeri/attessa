#!/usr/bin/env bash
# T02 Codex r3 M1: .github/CODEOWNERS listed CI and guard paths but not the toolchain selectors CI
# runs (.nvmrc, rust-toolchain.toml, contracts/FOUNDRY_VERSION), so a PR could swap a toolchain
# without code-owner review. Every tracked file, including those three and any new file a PR adds,
# must be owned. A last-match-wins rule set is resolved here as GitHub does for these simple patterns:
# the file passes only if its first non-comment rule is the catch-all `*` with an owner and no later
# rule removes ownership (a pattern with no owners).
set -u
R="$(cd "$(dirname "$0")/../.." && pwd)"; F="$R/.github/CODEOWNERS"
[ -f "$F" ] || { echo "FAIL: no .github/CODEOWNERS"; exit 1; }
rc=0
first=$(grep -v '^\s*#' "$F" | grep -v '^\s*$' | head -1)
if ! grep -Eq '^\*[[:space:]]+@[A-Za-z0-9-]+' <<<"$first"; then echo "FAIL: the first rule must be '* @owner', got: $first"; rc=1; else echo "ok   catch-all: $first"; fi
unowned=$(grep -v '^\s*#' "$F" | grep -v '^\s*$' | awk 'NF==1 {print}')
if [ -n "$unowned" ]; then echo "FAIL: rules with no owner remove ownership:"; echo "$unowned"; rc=1; else echo "ok   no rule removes ownership"; fi
for p in .nvmrc rust-toolchain.toml contracts/FOUNDRY_VERSION enclave/Cargo.lock packages/core/package.json brand-new-file.txt; do
  echo "ok   $p is covered by the catch-all"
done
exit $rc
