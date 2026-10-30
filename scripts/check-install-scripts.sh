#!/usr/bin/env bash
# Install HEAD with the pinned pnpm (packageManager), a fresh store and no side-effects cache,
# and fail if any dependency install script outside the allowlist (better-sqlite3, keytar) runs.
set -u
root=$(git rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git -C "$root" archive HEAD | tar -x -C "$work"
cd "$work"
pm=$(node -p 'require("./package.json").packageManager || ""'); pm=${pm%%+*}
[[ $pm =~ ^pnpm@[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "FAIL: packageManager is not pnpm@X.Y.Z: '$pm'"; exit 1; }
# User-level config is kept out so only the repo's own settings decide what runs.
log=$(npm_config_userconfig=/dev/null XDG_CONFIG_HOME="$work/.cfg" npx -y "$pm" install --frozen-lockfile \
  --reporter=append-only --store-dir "$work/.store" --no-side-effects-cache 2>&1)
st=$?
ran=$(printf '%s\n' "$log" | grep -E '(pre|post)?install\$' | grep -vE '(^|/)(better-sqlite3|keytar) (pre|post)?install\$')
if [ -n "$ran" ]; then echo "FAIL: non-allowlisted install script ran:"; echo "$ran"; exit 1; fi
# A failed install proves nothing either way, so it fails the probe.
if [ $st -ne 0 ]; then
  echo "FAIL: $pm install failed (exit $st); no evidence either way:"
  printf '%s\n' "$log" | tail -5
  exit 1
fi
echo "$pm install ran no non-allowlisted install script: ok"
