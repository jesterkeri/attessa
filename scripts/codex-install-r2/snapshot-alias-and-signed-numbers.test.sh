#!/usr/bin/env bash
# Codex install-allowlist review r2.
# Major 1: a snapshot dependency written `prebuild-install: node-addon-api@8.9.2` is an alias to pnpm (it installs
# node-addon-api under the name prebuild-install), yet the guard only refused a ":" in the value. Contract: "each
# dependency is ... the registry snapshot of that name". Every snapshot dependency must be the snapshot `name@ref`.
# Minor 1: CORE12 missed signed base-prefixed numbers (+0o17, -0o17, +0x1F, -0b1), plain strings to PyYAML and
# numbers to pnpm's YAML 1.2 reader. They are refused like the unsigned forms.
# Each case breaks the better-sqlite3 integrity so the guard stops at its static stage (no pnpm, no network).
# Expected: every line "ok:" and exit 0.
# Usage: $0 <repo> [commit under test, default HEAD]
set -u
src="${1:?repo}"; rev="${2:-HEAD}"
R=$(mktemp -d "${TMPDIR:-/tmp}/attessa-codex-install-r2.XXXX") && [ -d "$R" ] || { echo "FAIL: no scratch folder"; exit 1; }
trap 'rm -rf "$R"' EXIT
rc=0
mkdir "$R/repo" && git -C "$src" archive "$rev" | tar -x -C "$R/repo" && cd "$R/repo" || { echo "FAIL: could not extract $rev into $R/repo"; exit 1; }
git init -q && git add -A && git -c user.name=t -c user.email=t@x commit -qm base || { echo "FAIL: could not commit the scratch copy"; exit 1; }
base='better-sqlite3@13.0.3: allowlisted package without its pinned registry integrity'
# edit <python regex> <replacement>: one substitution in the snapshots section of pnpm-lock.yaml, or fail.
edit() {
  python3 -I - "$1" "$2" <<'PY'
import re, sys
pat, rep = sys.argv[1], sys.argv[2].replace("\\n", "\n")
t = open("pnpm-lock.yaml").read(); i = t.index("\nsnapshots:\n")
head, tail = t[:i], t[i:]
tail, n = re.subn(pat, lambda g: g.group(0) + rep, tail, count=1)
assert n == 1, f"pattern not found: {pat}"
open("pnpm-lock.yaml", "w").write(head + tail)
PY
}
case_() {  # case_ <label> <expect refused: 1|0> [python regex] [text added after its match]
  git reset -q --hard HEAD && git clean -qfdx
  if [ -n "${3:-}" ]; then edit "$3" "$4" || { echo "FAIL: $1: could not make the case"; rc=1; return; }; fi
  sed -i 's#integrity: sha512-RbOBxmLBG8uvFUc15X9#integrity: sha512-AbOBxmLBG8uvFUc15X9#' pnpm-lock.yaml
  git add -A && git -c user.name=t -c user.email=t@x commit -qm case
  out=$(./scripts/check-install-scripts.sh 2>&1)
  other=$(grep -a '^FAIL ' <<<"$out" | grep -avF "$base")
  if ! grep -qaF "$base" <<<"$out"; then
    echo "FAIL: $1: the static stage did not reach the lockfile check: ${out##*$'\n'}"; rc=1
  elif [ -n "$other" ]; then
    [ "$2" = 1 ] && echo "ok: $1: refused" || { echo "FAIL: $1: refused: $(head -1 <<<"$other")"; rc=1; }
  else
    [ "$2" = 0 ] && echo "ok: $1: accepted" || { echo "FAIL: $1: accepted; the guard's only FAIL lines: $(grep -a '^FAIL' <<<"$out" | paste -sd '|')"; rc=1; }
  fi
  git reset -q --hard HEAD~1 && git clean -qfdx
}
DEPS='\n  better-sqlite3@13\.0\.3:\n    dependencies:\n'
case_ 'snapshot better-sqlite3 dependency prebuild-install: node-addon-api@8.9.2 (an alias)' 1 "$DEPS" '      prebuild-install: node-addon-api@8.9.2\n'
case_ 'snapshot better-sqlite3 dependency node-addon-api: 9.9.9 (no such snapshot)' 1 '\n  better-sqlite3@13\.0\.3:\n    dependencies:\n      node-addon-api: 8\.9\.2' '\n      attessa-r2-missing: 1.0.0'
for v in +0o17 -0o17 +0x1F -0b1; do
  case_ "snapshot better-sqlite3 plain transitivePeerDependencies entry $v (a number to YAML 1.2)" 1 "$DEPS"'      node-addon-api: 8\.9\.2' "\n    transitivePeerDependencies:\n      - $v"
done
case_ "control: the same entry quoted, '+0o17'" 0 "$DEPS"'      node-addon-api: 8\.9\.2' "\n    transitivePeerDependencies:\n      - '+0o17'"
case_ 'the committed lockfile' 0
exit $rc
