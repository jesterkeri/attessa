#!/usr/bin/env bash
# Install allow-list adversary r12: the header of scripts/check-install-scripts.sh says "Nothing is
# resolved from the tree under test ... and PATH keeps only absolute entries outside the checked
# folder". When every PATH entry is inside the checked folder or relative, the filter keeps none and
# sets PATH to the empty string, and bash (like execvp and Python's subprocess) reads an empty PATH
# as one null entry: the current folder, which is the checkout. The next command the guard looks up
# (grep, on the `unset $(compgen -e | grep '^GIT_')` line, then git) runs from the tree.
# Two cases, one per entry kind the filter drops, each as the only PATH entry:
#   1. the absolute entry $root/bin (the r10 premise)
#   2. the relative entry "."
# The tree tracks a grep and a git at its root; each records that it ran, then hands over to the
# real tool by absolute path. Each case also breaks the better-sqlite3 integrity, so the probe can
# never reach pnpm.
# Expected against a guard that keeps the tree out: 2 "ok:" lines and exit 0. Against d1ef492:
# 2 "FAIL:" lines and exit 1.
# Usage: $0 <repo> [commit under test, default HEAD]
set -u
src="${1:?repo}"; rev="${2:-HEAD}"
realgrep=$(command -v grep); realgit=$(command -v git)
R=$(mktemp -d /tmp/attessa-adv-path-r12.XXXX); S=$(mktemp -d /tmp/attessa-adv-path-r12-s.XXXX)
trap 'rm -rf "$R" "$S"' EXIT
git -C "$src" archive "$rev" | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
rc=0
case_() {  # case_ <the only PATH entry> <label>
  git reset -q --hard HEAD && git clean -qfdx; rm -f "$S/ran"
  for t in grep:"$realgrep" git:"$realgit"; do
    printf '#!/bin/sh\necho "$0 $*" >> %s/ran\nexec %s "$@"\n' "$S" "${t#*:}" > "${t%%:*}"; chmod 755 "${t%%:*}"
  done
  mkdir -p bin
  sed -i 's#integrity: sha512-RbOBxmLBG8uvFUc15X9#integrity: sha512-AbOBxmLBG8uvFUc15X9#' pnpm-lock.yaml
  git add -f -A && git -c user.name=adv -c user.email=adv@x commit -qm case
  out=$(PATH="$1" ./scripts/check-install-scripts.sh 2>&1); st=$?
  if [ -e "$S/ran" ]; then
    echo "FAIL: $2: the guard ran the tree's own tools (guard exit $st), first call: $(head -1 "$S/ran")"; rc=1
  else echo "ok: $2: no tool of the tree ran (guard exit $st): ${out##*$'\n'}"; fi
  git reset -q --hard HEAD~1
}
case_ "$R/bin" 'only PATH entry $root/bin'
case_ . 'only PATH entry "."'
exit $rc
