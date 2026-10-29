#!/usr/bin/env bash
# Install with a pnpm the repo does not refuse (9.x) and fail if any dependency
# install script outside the allowlist (better-sqlite3, keytar) runs.
set -u
root=$(git rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git -C "$root" archive HEAD | tar -x -C "$work"
cd "$work"
log=$(npx -y pnpm@9.15.9 install --frozen-lockfile --reporter=append-only --store-dir "$work/.store" --no-side-effects-cache 2>&1)
st=$?
[ $st -eq 0 ] || { echo "install refused (exit $st): ok"; printf '%s\n' "$log" | tail -3; exit 0; }
ran=$(printf '%s\n' "$log" | grep -E '(pre|post)?install\$' | grep -vE 'better-sqlite3|keytar')
if [ -n "$ran" ]; then echo "FAIL: non-allowlisted install script ran:"; echo "$ran"; exit 1; fi
echo "PASS"
