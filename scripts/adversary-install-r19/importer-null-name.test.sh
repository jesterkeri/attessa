#!/usr/bin/env bash
# Install allow-list adversary r19 lead: the importer rule compares a `link:` version's target with
# proj.get(<normalised path>) == <dependency name>. PyYAML (YAML 1.1) reads an unquoted dependency key `null`
# (or `~`) as None, and proj.get() of a path that is no workspace project is also None, so
# `null: {specifier: workspace:*, version: link:<any path>}` passes whatever the path is. pnpm 10.32.1 reads the
# lockfile with js-yaml, whose storeMappingPair does keyNode = String(keyNode), so the same key is the string
# "null"; the manifest names "null": "workspace:*" (the manifest rules accept any name with workspace:*), the
# frozen-lockfile check compares only specifiers, and headless links node_modules/null to that path as is.
# Contract: "Dependency versions never point into the tree: link: only for a workspace: specifier", and each
# importer dependency is "the workspace project of that name (workspace: specifier, link: to its folder)".
# Cases (each must be refused with a FAIL line beyond the broken better-sqlite3 integrity), then the committed
# lockfile (must not be refused). Each case breaks the better-sqlite3 integrity so the probe never reaches
# pnpm or the network.
#   1. packages/cli null: workspace:*, link:../../vendor/null, a tracked folder of the tree that is no project.
#   2. packages/cli ~: workspace:*, link:/opt/attessa-r19-outside, a folder outside the repository.
# With PNPM_CJS set to a pnpm 10.32.1 bin/pnpm.cjs, it also shows pnpm's reading with no network: a workspace
# project a with "null": "workspace:*" and the lockfile key `null:` linked to vendor/null gets that folder
# as require("null"), and PyYAML reads the same lockfile key as None.
# Expected: 3 "ok:" lines (5 with PNPM_CJS) and exit 0.
# Usage: $0 <repo> [commit under test, default HEAD]
set -u
src="${1:?repo}"; rev="${2:-HEAD}"
R=$(mktemp -d "${TMPDIR:-/tmp}/attessa-adv-null-r19.XXXX") && [ -d "$R" ] || { echo "FAIL: no scratch folder"; exit 1; }
trap 'rm -rf "$R"' EXIT
rc=0
if [ -n "${PNPM_CJS:-}" ]; then
  P="$R/ws"; mkdir -p "$P/packages/a" "$P/vendor/null"
  printf '{"name":"probe","private":true}\n' > "$P/package.json"
  printf 'packages:\n  - packages/*\nignoreScripts: true\n' > "$P/pnpm-workspace.yaml"
  printf '{"name":"a","version":"1.0.0","dependencies":{"null":"workspace:*"}}\n' > "$P/packages/a/package.json"
  printf '{"name":"null","version":"1.0.0","main":"index.js"}\n' > "$P/vendor/null/package.json"
  printf 'module.exports = "from-the-tree";\n' > "$P/vendor/null/index.js"
  printf "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n\n  packages/a:\n    dependencies:\n      null:\n        specifier: workspace:*\n        version: link:../../vendor/null\n" > "$P/pnpm-lock.yaml"
  key=$(python3 -I -c 'import sys, yaml; print(repr(list(yaml.safe_load(open(sys.argv[1]))["importers"]["packages/a"]["dependencies"])))' "$P/pnpm-lock.yaml")
  [ "$key" = '[None]' ] && echo "ok: PyYAML $(python3 -I -c 'import yaml; print(yaml.__version__)') reads the lockfile dependency key null as None" \
    || { echo "FAIL: PyYAML reads the dependency key null as $key, not None"; rc=1; }
  (cd "$P" && npm_config_userconfig=/dev/null XDG_CONFIG_HOME="$P/cfg" node "$PNPM_CJS" install --frozen-lockfile \
    --store-dir "$P/store" --no-side-effects-cache >"$P/log" 2>&1)
  got=$(cd "$P/packages/a" && node -e 'console.log(require("null"))' 2>/dev/null)
  [ "$got" = from-the-tree ] \
    && echo "ok: pnpm $(node "$PNPM_CJS" --version) links the workspace:* dependency \"null\" (lockfile key null) to link:../../vendor/null, no project" \
    || { echo "FAIL: pnpm did not link the lockfile key null to vendor/null (got '$got'): $(tail -1 "$P/log")"; rc=1; }
fi
# Every git command below runs in this scratch copy only: stop if it could not be made.
mkdir "$R/repo" && git -C "$src" archive "$rev" | tar -x -C "$R/repo" && cd "$R/repo" || { echo "FAIL: could not extract $rev into $R/repo"; exit 1; }
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base || { echo "FAIL: could not commit the scratch copy"; exit 1; }
base='better-sqlite3@13.0.3: allowlisted package without its pinned registry integrity'
case_() {  # case_ <label> <expect refused: 1|0> [lockfile key] [link target]
  git reset -q --hard HEAD && git clean -qfdx
  if [ -n "${3:-}" ]; then
    python3 -I - "$3" "$4" <<'PY'
import re, sys
key, to = sys.argv[1], sys.argv[2]
t = open("pnpm-lock.yaml").read()
t, n = re.subn(r"(\n  packages/cli:\n    dependencies:\n)", lambda g: g.group(1) + "      %s:\n        specifier: workspace:*\n        version: link:%s\n" % (key, to), t, count=1)
assert n == 1, "packages/cli importer not found"
open("pnpm-lock.yaml", "w").write(t)
m = open("packages/cli/package.json").read()
m, k = re.subn(r'("dependencies": \{\n)', r'\1    "null": "workspace:*",\n', m, count=1)
assert k == 1, "dependencies not found in packages/cli/package.json"
open("packages/cli/package.json", "w").write(m)
PY
    mkdir -p vendor/null
    printf '{\n  "name": "null",\n  "version": "1.0.0",\n  "main": "index.js"\n}\n' > vendor/null/package.json
    printf 'module.exports = { from: "the tree under test" };\n' > vendor/null/index.js
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
    [ "$2" = 0 ] && echo "ok: $1: accepted" || { echo "FAIL: $1: accepted (pnpm reads the key as the string \"null\" and links it as is under --frozen-lockfile); the guard's only FAIL lines: $(grep '^FAIL' <<<"$out" | paste -sd '|')"; rc=1; }
  fi
  git reset -q --hard HEAD~1
}
case_ 'packages/cli lockfile key null (manifest "null": "workspace:*") linked to link:../../vendor/null, a tree folder that is no workspace project' 1 null ../../vendor/null
case_ 'packages/cli lockfile key ~ (manifest "null": "workspace:*") linked to link:/opt/attessa-r19-outside, outside the repository' 1 '~' /opt/attessa-r19-outside
case_ 'the committed lockfile' 0
exit $rc
