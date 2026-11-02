#!/usr/bin/env bash
# Mutation check (TASKS.md T05, INVARIANTS.md): applies each contracts/mutations/*.patch, runs the
# contracts test suite, prints KILLED <name> or SURVIVED <name>, and always reverts the patch.
# Exits 0 only if the clean tree passes and every patch applies, compiles and is killed.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

export FOUNDRY_INVARIANT_RUNS="${FOUNDRY_INVARIANT_RUNS:-256}"
export FOUNDRY_INVARIANT_DEPTH="${FOUNDRY_INVARIANT_DEPTH:-50}"

shopt -s nullglob
patches=(contracts/mutations/*.patch)
if [ "${#patches[@]}" -eq 0 ]; then
  echo "no patches in contracts/mutations/" >&2
  exit 1
fi

if ! git diff --quiet -- contracts/src; then
  echo "contracts/src has uncommitted changes; commit or stash them first" >&2
  exit 1
fi

log="$(mktemp)"
applied=""
restore() {
  if [ -n "$applied" ]; then
    if ! git apply -R "$applied"; then
      echo "FAILED to revert $applied; contracts/src is mutated" >&2
      exit 2
    fi
    applied=""
  fi
}
trap 'restore; rm -f "$log"' EXIT
trap 'exit 130' INT TERM

if ! (cd contracts && forge test --fail-fast) >"$log" 2>&1; then
  tail -n 30 "$log" >&2
  echo "the clean tree fails its own tests; mutation results would mean nothing" >&2
  exit 1
fi

status=0
for patch in "${patches[@]}"; do
  name="$(basename "$patch" .patch)"
  if ! git apply --check "$patch" 2>"$log"; then
    cat "$log" >&2
    echo "BROKEN $name (does not apply)"
    status=1
    continue
  fi
  git apply "$patch"
  applied="$patch"
  if ! (cd contracts && forge build) >"$log" 2>&1; then
    tail -n 20 "$log" >&2
    echo "BROKEN $name (does not compile)"
    status=1
  elif (cd contracts && forge test --fail-fast) >"$log" 2>&1; then
    echo "SURVIVED $name"
    status=1
  else
    echo "KILLED $name"
  fi
  restore
done

exit "$status"
