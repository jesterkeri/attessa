#!/usr/bin/env bash
# The Slither gate drops results only in contracts/lib/nitro-validator/ (contracts/slither.config.json,
# docs/SLITHER_TRIAGE.md) because that submodule is pinned at 0ea0d12 (adr/001). This fails unless the
# pin holds, so a moved gitlink cannot carry new code into the unanalysed folder:
#   - the committed gitlink is exactly 0ea0d12366b4fa44f9e07e4755f2ad36561cb674, with nothing else
#     tracked under that path;
#   - .gitmodules has exactly one entry for that path, with url https://github.com/base/nitro-validator;
#   - the checked-out submodule is its own repository, its HEAD equals the gitlink, and every nested
#     submodule (forge-std, pinned by 0ea0d12 itself) is checked out at its recorded commit;
#   - no file in the submodule or its nested submodules differs from its commit: no modified,
#     untracked or ignored file.
# Run from the repository root, after `git submodule update --init --recursive`. Used by the CI
# slither job before Slither runs.
set -uo pipefail
P=contracts/lib/nitro-validator
PIN=0ea0d12366b4fa44f9e07e4755f2ad36561cb674
URL=https://github.com/base/nitro-validator
bad=0
fail() { echo "FAIL: $*"; bad=1; }

got=$(git ls-files -s -- "$P") || { echo "FAIL: git ls-files failed (run from the repository root)"; exit 1; }
want=$(printf '160000 %s 0\t%s' "$PIN" "$P")
[ "$got" = "$want" ] || fail "$P must be one gitlink at $PIN, found: ${got:-nothing}"

if [ -f .gitmodules ]; then
  names=$(git config -f .gitmodules --get-regexp '^submodule\..*\.path$' |
    awk -v p="$P" '$2 == p { n = $1; sub(/^submodule\./, "", n); sub(/\.path$/, "", n); print n }')
  if [ "$(printf '%s' "$names" | grep -c .)" != 1 ]; then
    fail ".gitmodules must have exactly one entry with path $P, found: ${names:-none}"
  else
    u=$(git config -f .gitmodules --get "submodule.$names.url")
    [ "$u" = "$URL" ] || fail ".gitmodules url for $P must be $URL, found: ${u:-none}"
  fi
else
  fail ".gitmodules is missing"
fi

if [ -d "$P" ] && top=$(git -C "$P" rev-parse --show-toplevel 2>/dev/null) &&
   [ "$top" = "$(cd "$P" && pwd -P)" ]; then
  head=$(git -C "$P" rev-parse --verify HEAD 2>/dev/null)
  [ "$head" = "$PIN" ] || fail "$P is checked out at ${head:-nothing}, not $PIN"
  nested=$(git -C "$P" submodule status --recursive 2>&1) || fail "git submodule status failed in $P: $nested"
  off=$(printf '%s\n' "$nested" | grep -v '^ ' | grep .)
  [ -z "$off" ] || fail "nested submodules in $P not checked out at their recorded commit:"$'\n'"$off"
  dirty=$(git -C "$P" status --porcelain --ignored --untracked-files=all 2>&1;
          git -C "$P" submodule foreach --quiet --recursive \
            'git status --porcelain --ignored --untracked-files=all | sed "s|^|$displaypath: |"' 2>&1)
  [ -z "$dirty" ] || fail "$P differs from its pinned commits:"$'\n'"$dirty"
else
  fail "$P is not a checked-out submodule (run git submodule update --init --recursive)"
fi

[ "$bad" = 0 ] && echo "ok: $P pinned at $PIN ($URL), checkout clean"
exit "$bad"
