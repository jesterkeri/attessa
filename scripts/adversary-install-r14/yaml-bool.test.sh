#!/usr/bin/env bash
# Install allow-list adversary r14 lead (unproven as a bypass): the guard parsed pnpm-workspace.yaml
# with PyYAML (YAML 1.1), which reads `yes` and `on` as true, while pnpm's YAML 1.2 parser reads them
# as strings, so `ignoreScripts: yes` passed the guard but need not switch scripts off in pnpm.
# Cases: yes, on, a flow mapping with yes (each must be refused naming pnpm-workspace.yaml), and the
# committed file (must not be). Each case breaks the better-sqlite3 integrity so the probe never
# reaches pnpm. Expected: 4 "ok:" lines and exit 0.
# Usage: $0 <repo> [commit under test, default HEAD]
set -u
src="${1:?repo}"; rev="${2:-HEAD}"
R=$(mktemp -d "${TMPDIR:-/tmp}/attessa-adv-yaml-r14.XXXX") && [ -d "$R" ] || { echo "FAIL: no scratch folder"; exit 1; }; trap 'rm -rf "$R"' EXIT
git -C "$src" archive "$rev" | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
rc=0
case_() {  # case_ <label> <expect refused: 1|0> [new pnpm-workspace.yaml text]
  git reset -q --hard HEAD && git clean -qfdx
  [ $# -ge 3 ] && printf '%s\n' "$3" > pnpm-workspace.yaml
  sed -i 's#integrity: sha512-RbOBxmLBG8uvFUc15X9#integrity: sha512-AbOBxmLBG8uvFUc15X9#' pnpm-lock.yaml
  git add -A && git -c user.name=adv -c user.email=adv@x commit -qm case
  out=$(./scripts/check-install-scripts.sh 2>&1)
  if ! grep -q 'better-sqlite3@13.0.3: allowlisted package without its pinned registry integrity' <<<"$out"; then
    echo "FAIL: $1: the static stage did not run to the lockfile check: ${out##*$'\n'}"; rc=1
  elif grep -q '^FAIL pnpm-workspace.yaml' <<<"$out"; then
    [ "$2" = 1 ] && echo "ok: $1: refused" || { echo "FAIL: $1: refused: $(grep '^FAIL pnpm-workspace.yaml' <<<"$out" | head -1)"; rc=1; }
  else
    [ "$2" = 0 ] && echo "ok: $1: accepted" || { echo "FAIL: $1: accepted"; rc=1; }
  fi
  git reset -q --hard HEAD~1
}
case_ 'ignoreScripts: yes' 1 $'packages:\n  - packages/*\nignoreScripts: yes'
case_ 'ignoreScripts: on' 1 $'packages:\n  - packages/*\nignoreScripts: on'
case_ 'flow mapping with yes' 1 '{packages: [packages/*], ignoreScripts: yes}'
case_ 'the committed file' 0
exit $rc
