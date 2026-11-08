#!/usr/bin/env bash
# Install allow-list adversary r20 lead: no rule checks the format of a dependency name. The manifest rules check
# only the value of each dependencies/devDependencies entry (workspace:* passes), the importer rule checks only that a
# link: dependency's name equals the "name" of the workspace project it links to, and a project's "name" has no
# format rule at all. So a project packages/hooks named "../../../.git/hooks", a packages/cli dependency
# "../../../.git/hooks": "workspace:*" and the lockfile entry of that name with link:../hooks all pass.
# pnpm 10.32.1 links each direct dependency with path.join(<project>/node_modules, <name>)
# (symlinkDirectRootDependency) and symlink-dir moves an existing folder aside, so the install replaces the
# repository's .git/hooks with a symlink to packages/hooks: its tracked executable pre-commit then runs on the
# next git commit. Nothing runs at install, so the dynamic probe would pass this too.
# Contract: the guard's lockfile comment "Every package comes from the default registry by integrity (no tarball,
# file, directory, git, link or other registry)" and each importer dependency is "the workspace project of that
# name (workspace: specifier, link: to its folder)": a name that is a path is placed outside node_modules.
# Cases (each must be refused with a FAIL line beyond the broken better-sqlite3 integrity), then the committed
# lockfile (must not be refused). Each case breaks the better-sqlite3 integrity so the probe never reaches
# pnpm or the network.
#   1. packages/cli "../../../.git/hooks": workspace:*, link:../hooks, project packages/hooks of that name.
#   2. packages/cli "../../../../attessa-r20-outside": workspace:*, link:../hooks, a link outside the checkout.
# With PNPM_CJS set to a pnpm 10.32.1 bin/pnpm.cjs, it also shows pnpm's reading with no network: in a scratch
# workspace whose project a depends on "../../../.git/hooks": "workspace:*", the install leaves .git/hooks a symlink
# to packages/evil (the old folder renamed .git/.ignored_hooks) and .git/hooks/pre-commit is the tree's script.
# Expected: 3 "ok:" lines (4 with PNPM_CJS) and exit 0.
# Usage: $0 <repo> [commit under test, default HEAD]
set -u
src="${1:?repo}"; rev="${2:-HEAD}"
R=$(mktemp -d "${TMPDIR:-/tmp}/attessa-adv-name-r20.XXXX") && [ -d "$R" ] || { echo "FAIL: no scratch folder"; exit 1; }
trap 'rm -rf "$R"' EXIT
rc=0
if [ -n "${PNPM_CJS:-}" ]; then
  P="$R/ws"; mkdir -p "$P/packages/a" "$P/packages/evil" "$P/.git/hooks"
  printf '{"name":"probe","private":true}\n' > "$P/package.json"
  printf 'packages:\n  - packages/*\nignoreScripts: true\n' > "$P/pnpm-workspace.yaml"
  printf '{"name":"a","version":"1.0.0","dependencies":{"../../../.git/hooks":"workspace:*"}}\n' > "$P/packages/a/package.json"
  printf '{"name":"../../../.git/hooks","version":"1.0.0"}\n' > "$P/packages/evil/package.json"
  printf '#!/bin/sh\necho from-the-tree\n' > "$P/packages/evil/pre-commit"; chmod +x "$P/packages/evil/pre-commit"
  printf 'original\n' > "$P/.git/hooks/pre-commit"
  printf "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n\n  packages/a:\n    dependencies:\n      '../../../.git/hooks':\n        specifier: workspace:*\n        version: link:../evil\n\n  packages/evil: {}\n" > "$P/pnpm-lock.yaml"
  (cd "$P" && npm_config_userconfig=/dev/null XDG_CONFIG_HOME="$P/cfg" node "$PNPM_CJS" install --frozen-lockfile --offline \
    --store-dir "$P/store" --no-side-effects-cache >"$P/log" 2>&1)
  got=$("$P/.git/hooks/pre-commit" 2>/dev/null)
  if [ -L "$P/.git/hooks" ] && [ "$got" = from-the-tree ]; then
    echo "ok: pnpm $(node "$PNPM_CJS" --version) links the dependency \"../../../.git/hooks\" of packages/a over .git/hooks ($(readlink "$P/.git/hooks")), outside node_modules"
  else
    echo "FAIL: pnpm did not place the dependency \"../../../.git/hooks\" at .git/hooks (pre-commit says '$got'): $(tail -1 "$P/log")"; rc=1
  fi
fi
# Every git command below runs in this scratch copy only: stop if it could not be made.
mkdir "$R/repo" && git -C "$src" archive "$rev" | tar -x -C "$R/repo" && cd "$R/repo" || { echo "FAIL: could not extract $rev into $R/repo"; exit 1; }
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base || { echo "FAIL: could not commit the scratch copy"; exit 1; }
base='better-sqlite3@13.0.3: allowlisted package without its pinned registry integrity'
case_() {  # case_ <label> <expect refused: 1|0> [dependency and project name]
  git reset -q --hard HEAD && git clean -qfdx
  if [ -n "${3:-}" ]; then
    python3 -I - "$3" <<'PY'
import json, re, sys
name = sys.argv[1]
t = open("pnpm-lock.yaml").read()
t, n = re.subn(r"(\n  packages/cli:\n    dependencies:\n)", lambda g: g.group(1) + "      '%s':\n        specifier: workspace:*\n        version: link:../hooks\n" % name, t, count=1)
assert n == 1, "packages/cli importer not found"
t, n = re.subn(r"(\n  packages/core:\n)", lambda g: "\n  packages/hooks: {}\n" + g.group(1), t, count=1)
assert n == 1, "packages/core importer not found"
open("pnpm-lock.yaml", "w").write(t)
m = open("packages/cli/package.json").read()
m, k = re.subn(r'("dependencies": \{\n)', lambda g: g.group(1) + "    %s: \"workspace:*\",\n" % json.dumps(name), m, count=1)
assert k == 1, "dependencies not found in packages/cli/package.json"
open("packages/cli/package.json", "w").write(m)
PY
    mkdir -p packages/hooks
    printf '{\n  "name": "%s",\n  "version": "0.0.0",\n  "private": true\n}\n' "$3" > packages/hooks/package.json
    printf '#!/bin/sh\necho "pre-commit from the tree under test"\n' > packages/hooks/pre-commit; chmod +x packages/hooks/pre-commit
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
    [ "$2" = 0 ] && echo "ok: $1: accepted" || { echo "FAIL: $1: accepted (pnpm links the dependency at path.join(packages/cli/node_modules, name), outside node_modules); the guard's only FAIL lines: $(grep '^FAIL' <<<"$out" | paste -sd '|')"; rc=1; }
  fi
  git reset -q --hard HEAD~1
}
case_ 'packages/cli dependency "../../../.git/hooks" (workspace:*, link:../hooks, project packages/hooks of that name)' 1 '../../../.git/hooks'
case_ 'packages/cli dependency "../../../../attessa-r20-outside" (workspace:*, link:../hooks), a link outside the checkout' 1 '../../../../attessa-r20-outside'
case_ 'the committed lockfile' 0
exit $rc
