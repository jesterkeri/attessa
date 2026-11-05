#!/usr/bin/env bash
# Install allow-list r17 follow-up: pnpm merges each packages entry over its snapshot, and reads top-level
# lockfile keys beyond the five it writes for this repo (overrides, patchedDependencies, catalogs and others
# change what is installed), so the guard allows only the fields this lockfile uses.
# Cases: a packages entry with an extra `version` field, a top-level `overrides` key (each must be refused
# with the guard's keys line), and the committed lockfile (must not be). Each case breaks the
# better-sqlite3 integrity so the probe never reaches pnpm. Expected: 3 "ok:" lines and exit 0.
# Usage: $0 <repo> [commit under test, default HEAD]
set -u
src="${1:?repo}"; rev="${2:-HEAD}"
R=$(mktemp -d "${TMPDIR:-/tmp}/attessa-adv-keys-r17.XXXX"); trap 'rm -rf "$R"' EXIT
git -C "$src" archive "$rev" | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
rc=0
case_() {  # case_ <label> <expect refused: 1|0> [sed expression applied to pnpm-lock.yaml]
  git reset -q --hard HEAD && git clean -qfdx
  [ $# -ge 3 ] && sed -i "$3" pnpm-lock.yaml
  sed -i 's#integrity: sha512-RbOBxmLBG8uvFUc15X9#integrity: sha512-AbOBxmLBG8uvFUc15X9#' pnpm-lock.yaml
  git add -A && git -c user.name=adv -c user.email=adv@x commit -qm case
  out=$(./scripts/check-install-scripts.sh 2>&1)
  if grep -qE '^FAIL pnpm-lock.yaml: (top-level keys|tr46@5.1.1: keys) not allowed' <<<"$out"; then
    [ "$2" = 1 ] && echo "ok: $1: refused" || { echo "FAIL: $1: refused"; rc=1; }
  else
    [ "$2" = 0 ] && echo "ok: $1: accepted" || { echo "FAIL: $1: accepted"; rc=1; }
  fi
  git reset -q --hard HEAD~1
}
case_ 'a packages entry with its own version' 1 '0,/^  tr46@5.1.1:$/s//&\n    version: 5.1.0/'
case_ 'a top-level overrides key' 1 's/^settings:$/overrides:\n  tr46: 5.1.0\n\nsettings:/'
case_ 'the committed lockfile' 0
exit $rc
