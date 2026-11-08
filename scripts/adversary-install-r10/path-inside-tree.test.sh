#!/usr/bin/env bash
# Install allow-list adversary r10: the header of scripts/check-install-scripts.sh says "Nothing is
# resolved from the tree under test ... and PATH keeps absolute entries only". Keeping absolute
# entries does not keep the tree out: an absolute PATH entry inside the checkout, such as the
# $PWD/node_modules/.bin that direnv's `layout node` adds, still resolves git (and python3, node)
# from files the tree under test ships. Two cases, one per entry kind:
#   1. a tracked node_modules/.bin/git with $root/node_modules/.bin on PATH
#   2. a tracked bin/git with $root/bin on PATH
# Each fake git records that it ran, then hands over to the real git. Each case also breaks the
# better-sqlite3 integrity, so the probe stops at the static stage and runs no pnpm.
# Expected against a guard that keeps the tree out: 2 "ok:" lines and exit 0. Against a55742d:
# 2 "FAIL:" lines and exit 1.
# Usage: $0 <repo> [commit under test, default HEAD]
set -u
src="${1:?repo}"; rev="${2:-HEAD}"
realgit=$(command -v git)
R=$(mktemp -d /tmp/attessa-adv-path-r10.XXXX); S=$(mktemp -d /tmp/attessa-adv-path-r10-s.XXXX)
trap 'rm -rf "$R" "$S"' EXIT
git -C "$src" archive "$rev" | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
rc=0
case_() {  # case_ <dir inside the tree> <label>
  git reset -q --hard HEAD && git clean -qfdx; rm -f "$S/ran"
  mkdir -p "$1"
  printf '#!/bin/sh\necho "$0 $*" >> %s/ran\nexec %s "$@"\n' "$S" "$realgit" > "$1/git"; chmod 755 "$1/git"
  sed -i 's#integrity: sha512-RbOBxmLBG8uvFUc15X9#integrity: sha512-AbOBxmLBG8uvFUc15X9#' pnpm-lock.yaml
  git add -f -A && git -c user.name=adv -c user.email=adv@x commit -qm case
  out=$(PATH="$R/$1:$PATH" ./scripts/check-install-scripts.sh 2>&1); st=$?
  if [ -e "$S/ran" ]; then
    echo "FAIL: $2: the guard ran the tree's $1/git (guard exit $st), first call: $(head -1 "$S/ran")"; rc=1
  else echo "ok: $2: the tree's $1/git never ran (guard exit $st)"; fi
  git reset -q --hard HEAD~1
}
case_ node_modules/.bin 'PATH entry $root/node_modules/.bin'
case_ bin 'PATH entry $root/bin'
exit $rc
