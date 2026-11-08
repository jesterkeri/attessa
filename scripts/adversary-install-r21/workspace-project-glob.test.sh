#!/usr/bin/env bash
# Install allow-list adversary r21 lead: the guard's set of workspace projects is every tracked
# packages/<dir>/package.json (regex packages/[^/]+/package\.json), but pnpm 10.32.1 finds them with
# tinyglobby on packages/*/package.{json,yaml,json5}, which skips a folder whose name starts with "." (no dot
# option) and ignores **/node_modules/** and **/bower_components/** (findWorkspacePackagesNoCheck). So
# packages/.hidden and packages/bower_components are no workspace projects to pnpm, yet the guard accepts an
# importer dependency `specifier: workspace:*, version: link:../.hidden` to either one. Under --frozen-lockfile
# pnpm does not re-resolve workspace: and links the folder as written, with no integrity check, and as no
# workspace project it is outside `pnpm -r` (build, lint, test never run there).
# Contract: the guard's lockfile comment "Every package comes from the default registry by integrity (no tarball,
# file, directory, git, link or other registry)" and its importer rule "each dependency is either the workspace
# project of that name (workspace: specifier, link: to its folder) or the registry snapshot of that name".
# Cases (each breaks the better-sqlite3 integrity so the probe never reaches pnpm or the network):
#   1. packages/.attessa-r21 named attessa-r21-hidden, packages/cli depends on it: must be refused.
#   2. packages/bower_components named attessa-r21-bower, packages/cli depends on it: must be refused.
#   3. control: the same with packages/attessa-r21 (pnpm lists it as a project): must be accepted.
#   4. the committed lockfile: must be accepted.
# With PNPM_CJS set to a pnpm 10.32.1 bin/pnpm.cjs, it first shows pnpm's reading with no network: in a scratch
# workspace, `pnpm ls -r` lists neither packages/.x nor packages/bower_components, and
# `install --frozen-lockfile --offline` still links packages/a/node_modules/<name> to each folder.
# Expected: 4 "ok:" lines (5 with PNPM_CJS) and exit 0.
# Usage: $0 <repo> [commit under test, default HEAD]
set -u
src="${1:?repo}"; rev="${2:-HEAD}"
R=$(mktemp -d "${TMPDIR:-/tmp}/attessa-adv-glob-r21.XXXX") && [ -d "$R" ] || { echo "FAIL: no scratch folder"; exit 1; }
trap 'rm -rf "$R"' EXIT
rc=0
if [ -n "${PNPM_CJS:-}" ]; then
  P="$R/ws"; mkdir -p "$P/packages/a" "$P/packages/.x" "$P/packages/bower_components" "$P/packages/b"
  printf '{"name":"probe","private":true}\n' > "$P/package.json"
  printf 'packages:\n  - packages/*\nignoreScripts: true\n' > "$P/pnpm-workspace.yaml"
  printf '{"name":"a","version":"1.0.0","dependencies":{"hid":"workspace:*","bow":"workspace:*","b":"workspace:*"}}\n' > "$P/packages/a/package.json"
  printf '{"name":"hid","version":"1.0.0"}\n' > "$P/packages/.x/package.json"
  printf '{"name":"bow","version":"1.0.0"}\n' > "$P/packages/bower_components/package.json"
  printf '{"name":"b","version":"1.0.0"}\n' > "$P/packages/b/package.json"
  printf "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n\n  packages/a:\n    dependencies:\n      b:\n        specifier: workspace:*\n        version: link:../b\n      bow:\n        specifier: workspace:*\n        version: link:../bower_components\n      hid:\n        specifier: workspace:*\n        version: link:../.x\n\n  packages/b: {}\n" > "$P/pnpm-lock.yaml"
  env=(npm_config_userconfig=/dev/null XDG_CONFIG_HOME="$P/cfg")
  projects=$(cd "$P" && env "${env[@]}" node "$PNPM_CJS" ls -r --depth -1 --json 2>/dev/null \
    | python3 -I -c 'import json, os, sys; r = sys.argv[1]; print(" ".join(sorted(os.path.relpath(x["path"], r) for x in json.load(sys.stdin))))' "$(cd "$P" && pwd -P)")
  (cd "$P" && env "${env[@]}" node "$PNPM_CJS" install --frozen-lockfile --offline --store-dir "$P/store" --no-side-effects-cache >"$P/log" 2>&1)
  ist=$?
  if [ "$projects" = ". packages/a packages/b" ] && [ $ist -eq 0 ] \
     && [ "$(readlink "$P/packages/a/node_modules/hid")" = ../../.x ] && [ "$(readlink "$P/packages/a/node_modules/bow")" = ../../bower_components ]; then
    echo "ok: pnpm $(node "$PNPM_CJS" --version) lists only '$projects' as workspace projects, yet links hid -> packages/.x and bow -> packages/bower_components under --frozen-lockfile"
  else
    echo "FAIL: pnpm's reading differs: projects '$projects', install exit $ist, hid -> '$(readlink "$P/packages/a/node_modules/hid")': $(tail -1 "$P/log")"; rc=1
  fi
fi
# Every git command below runs in this scratch copy only: stop if it could not be made.
mkdir "$R/repo" && git -C "$src" archive "$rev" | tar -x -C "$R/repo" && cd "$R/repo" || { echo "FAIL: could not extract $rev into $R/repo"; exit 1; }
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base || { echo "FAIL: could not commit the scratch copy"; exit 1; }
base='better-sqlite3@13.0.3: allowlisted package without its pinned registry integrity'
case_() {  # case_ <label> <expect refused: 1|0> [folder under packages/] [dependency and project name]
  git reset -q --hard HEAD && git clean -qfdx
  if [ -n "${3:-}" ]; then
    python3 -I - "$3" "$4" <<'PY'
import json, re, sys
d, name = sys.argv[1], sys.argv[2]
t = open("pnpm-lock.yaml").read()
t, n = re.subn(r"(\n  packages/cli:\n    dependencies:\n)", lambda g: g.group(1) + "      %s:\n        specifier: workspace:*\n        version: link:../%s\n" % (name, d), t, count=1)
assert n == 1, "packages/cli importer not found"
open("pnpm-lock.yaml", "w").write(t)
m = open("packages/cli/package.json").read()
m, k = re.subn(r'("dependencies": \{\n)', lambda g: g.group(1) + "    %s: \"workspace:*\",\n" % json.dumps(name), m, count=1)
assert k == 1, "dependencies not found in packages/cli/package.json"
open("packages/cli/package.json", "w").write(m)
PY
    mkdir -p "packages/$3"
    printf '{\n  "name": "%s",\n  "version": "0.0.0",\n  "private": true\n}\n' "$4" > "packages/$3/package.json"
  fi
  sed -i 's#integrity: sha512-RbOBxmLBG8uvFUc15X9#integrity: sha512-AbOBxmLBG8uvFUc15X9#' pnpm-lock.yaml
  git add -A && git -c user.name=adv -c user.email=adv@x commit -qm case
  out=$(./scripts/check-install-scripts.sh 2>&1)
  other=$(grep '^FAIL ' <<<"$out" | grep -vF "$base")
  if ! grep -qF "$base" <<<"$out"; then
    echo "FAIL: $1: the static stage did not run to the lockfile check: ${out##*$'\n'}"; rc=1
  elif [ -n "$other" ]; then
    [ "$2" = 1 ] && echo "ok: $1: refused" || { echo "FAIL: $1: refused: $(head -1 <<<"$other")"; rc=1; }
  else
    [ "$2" = 0 ] && echo "ok: $1: accepted" || { echo "FAIL: $1: accepted (pnpm's packages/* glob does not list that folder as a workspace project, so the link: is to a plain folder); the guard's only FAIL lines: $(grep '^FAIL' <<<"$out" | paste -sd '|')"; rc=1; }
  fi
  git reset -q --hard HEAD~1
}
case_ 'packages/cli dependency attessa-r21-hidden (workspace:*, link:../.attessa-r21), a dot folder pnpm does not list' 1 .attessa-r21 attessa-r21-hidden
case_ 'packages/cli dependency attessa-r21-bower (workspace:*, link:../bower_components), a folder pnpm ignores' 1 bower_components attessa-r21-bower
case_ 'control: packages/cli dependency attessa-r21 (workspace:*, link:../attessa-r21), a workspace project' 0 attessa-r21 attessa-r21
case_ 'the committed lockfile' 0
exit $rc
