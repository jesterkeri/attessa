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
# Checked first: a script that ran and failed could print the engines error itself.
ran=$(printf '%s\n' "$log" | grep -E '(pre|post)?install\$' | grep -vE 'better-sqlite3|keytar')
if [ -n "$ran" ]; then echo "FAIL: non-allowlisted install script ran:"; echo "$ran"; exit 1; fi
# The only acceptable failure is pnpm 9 refusing the engines pin (pnpm >= 10.32.1). Anything
# else (offline registry, bad lockfile, rejected config) proves nothing, so it fails the probe.
if [ $st -ne 0 ]; then
  if printf '%s\n' "$log" | grep -q 'ERR_PNPM_UNSUPPORTED_ENGINE'; then
    echo "install refused by the engines pin (exit $st): ok"; exit 0
  fi
  echo "FAIL: install failed for another reason (exit $st); no evidence either way:"
  printf '%s\n' "$log" | tail -5
  exit 1
fi
echo "PASS"
