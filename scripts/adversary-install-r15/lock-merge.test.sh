#!/usr/bin/env bash
# Install allow-list adversary r15, lockfile side: PyYAML and pnpm's @zkochan/js-yaml resolve `<<`
# merge keys differently (the later merge wins in PyYAML, the earlier in js-yaml), so a pnpm-lock.yaml
# using merge keys, anchors, aliases or tags can show the guard one value and pnpm another. pnpm never
# writes any of them, so the guard refuses them outright.
# Cases: a `<<` merge key in settings, an anchor and alias, a tag (each must be refused with the
# guard's merge-key line), and the committed lockfile (must not be). Each case breaks the
# better-sqlite3 integrity so the probe never reaches pnpm. Expected: 4 "ok:" lines and exit 0.
# Usage: $0 <repo> [commit under test, default HEAD]
set -u
src="${1:?repo}"; rev="${2:-HEAD}"
R=$(mktemp -d "${TMPDIR:-/tmp}/attessa-adv-lock-r15.XXXX") && [ -d "$R" ] || { echo "FAIL: no scratch folder"; exit 1; }; trap 'rm -rf "$R"' EXIT
git -C "$src" archive "$rev" | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
rc=0
case_() {  # case_ <label> <expect refused: 1|0> [sed expression applied to pnpm-lock.yaml]
  git reset -q --hard HEAD && git clean -qfdx
  [ $# -ge 3 ] && sed -i "$3" pnpm-lock.yaml
  sed -i 's#integrity: sha512-RbOBxmLBG8uvFUc15X9#integrity: sha512-AbOBxmLBG8uvFUc15X9#' pnpm-lock.yaml
  git add -A && git -c user.name=adv -c user.email=adv@x commit -qm case
  out=$(./scripts/check-install-scripts.sh 2>&1)
  if grep -q '^FAIL pnpm-lock.yaml: anchors, aliases, tags' <<<"$out"; then
    [ "$2" = 1 ] && echo "ok: $1: refused" || { echo "FAIL: $1: refused"; rc=1; }
  else
    [ "$2" = 0 ] && echo "ok: $1: accepted" || { echo "FAIL: $1: accepted"; rc=1; }
  fi
  git reset -q --hard HEAD~1
}
case_ 'a << merge key in settings' 1 's/^  autoInstallPeers: true$/  <<: {autoInstallPeers: false}\n  autoInstallPeers: true/'
case_ 'an anchor and alias' 1 's/^settings:$/settings: \&s/; s/^importers:$/x: *s\nimporters:/'
case_ 'a tag' 1 "s/^lockfileVersion: '9.0'\$/lockfileVersion: !!str '9.0'/"
case_ 'the committed lockfile' 0
exit $rc
