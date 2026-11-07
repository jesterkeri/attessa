#!/usr/bin/env bash
# Fails unless every custom error declared in contracts/src/EnclaveRegistry.sol is named in at
# least one file under contracts/test/ (TASKS.md T04).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/contracts/src/EnclaveRegistry.sol"
tests="$root/contracts/test"

names="$(grep -oE '^[[:space:]]*error[[:space:]]+[A-Za-z_][A-Za-z0-9_]*' "$src" | awk '{print $2}' | sort -u)"
if [ -z "$names" ]; then
  echo "no custom errors found in $src" >&2
  exit 1
fi

missing=0
count=0
for name in $names; do
  count=$((count + 1))
  if ! grep -rqw -- "$name" "$tests"; then
    echo "MISSING $name" >&2
    missing=$((missing + 1))
  fi
done

if [ "$missing" -ne 0 ]; then
  echo "$missing of $count custom errors are not named in any test" >&2
  exit 1
fi
echo "all $count custom errors in EnclaveRegistry.sol are named in contracts/test/"
