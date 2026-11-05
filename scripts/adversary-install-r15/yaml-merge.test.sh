#!/usr/bin/env bash
# Install allow-list adversary r15 lead: pnpm-workspace.yaml with two `<<` merge keys. PyYAML builds
# one merge list and lets the later mapping win (ignoreScripts True), while pnpm 10.32.1's
# @zkochan/js-yaml 0.0.11 merges each `<<` only into keys not yet set, so the earlier mapping wins
# (ignoreScripts false) and pnpm runs install scripts. The one line the guard's regex sees is the plain
# `ignoreScripts: true` inside the second merged mapping, so both static checks pass.
# Cases: the two-merge file (must be refused naming pnpm-workspace.yaml) and the committed file (must
# not be). Each case breaks the better-sqlite3 integrity so the probe never reaches pnpm.
# With PNPM_CJS set to a pnpm 10.32.1 bin/pnpm.cjs, it also shows pnpm's reading offline: a scratch
# project with a root postinstall and this pnpm-workspace.yaml runs the postinstall.
# Expected: 2 "ok:" lines (3 with PNPM_CJS) and exit 0.
# Usage: $0 <repo> [commit under test, default HEAD]
set -u
src="${1:?repo}"; rev="${2:-HEAD}"
R=$(mktemp -d "${TMPDIR:-/tmp}/attessa-adv-yaml-r15.XXXX") && [ -d "$R" ] || { echo "FAIL: no scratch folder"; exit 1; }; trap 'rm -rf "$R"' EXIT
two=$'packages:\n  - packages/*\n<<: {ignoreScripts: false}\n<<: {\nignoreScripts: true\n}'
rc=0
if [ -n "${PNPM_CJS:-}" ]; then
  P="$R/pnpm-probe"; mkdir -p "$P"
  printf '{"name":"probe","private":true,"scripts":{"postinstall":"echo ran > marker"}}\n' > "$P/package.json"
  printf '%s\n' "$two" > "$P/pnpm-workspace.yaml"
  (cd "$P" && npm_config_userconfig=/dev/null XDG_CONFIG_HOME="$P/cfg" node "$PNPM_CJS" install --offline --store-dir "$P/store" >/dev/null 2>&1)
  [ -f "$P/marker" ] && echo "ok: pnpm $(node "$PNPM_CJS" --version) reads the two-merge file as ignoreScripts false (postinstall ran)" \
    || { echo "FAIL: pnpm did not run the postinstall, so it reads ignoreScripts as true here"; rc=1; }
fi
mkdir "$R/repo"; git -C "$src" archive "$rev" | tar -x -C "$R/repo"; cd "$R/repo"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
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
    [ "$2" = 0 ] && echo "ok: $1: accepted" || { echo "FAIL: $1: accepted (pnpm reads ignoreScripts false)"; rc=1; }
  fi
  git reset -q --hard HEAD~1
}
case_ 'two << merge keys, false first' 1 "$two"
case_ 'the committed file' 0
exit $rc
