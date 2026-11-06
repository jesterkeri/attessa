#!/usr/bin/env bash
# Install allow-list adversary r24 lead: the guard reads pnpm-lock.yaml with PyYAML (YAML 1.1 resolvers) and pnpm
# 10.32.1 with @zkochan/js-yaml 0.0.11 (YAML 1.2 core schema), then String(key). The guard's rule "every mapping
# key must be a string" holds only for PyYAML: some plain keys are strings in YAML 1.1 and numbers in YAML 1.2,
# and those numbers print as a different name:
#   1e3  -> PyYAML "1e3",  pnpm 1000 -> "1000"   (1.1 floats need a dot; 1.2 core reads 1e3 as a float)
#   0o17 -> PyYAML "0o17", pnpm 15   -> "15"     (0o is the 1.2 octal prefix, a plain string in 1.1)
#   08   -> PyYAML "08",   pnpm 8    -> "8"      (1.1 octal needs digits 0-7; 1.2 core reads 08 as decimal 8)
# Each of these is a valid npm package name, so it passes the guard's NAME check. An importer dependency keyed
# `1e3:` with `version: link:../<folder of the project named 1e3>` is, for the guard, the workspace project of
# that name; for pnpm it is the dependency "1000" (what package.json asks for, so --frozen-lockfile agrees), and
# pnpm links node_modules/1000 to the folder of a project whose name is "1e3", not "1000".
# Contract: the guard's importer rule "each dependency is either the workspace project of that name (workspace:
# specifier, link: to its folder) or the registry snapshot of that name", and its own premise, line 270-271:
# "every mapping key in the lockfile must be a string for the two to name the same thing".
# Cases (each breaks the better-sqlite3 integrity so the probe never reaches pnpm or the network):
#   1. packages/cli depends on "1000": workspace:*; project packages/attessa-r24-a named "1e3"; lockfile importer
#      packages/cli key `1e3:`, link:../attessa-r24-a. Must be refused.
#   2. the same with "15", project named "0o17", key `0o17:`. Must be refused.
#   3. the same with "8", project named "08", key `08:`. Must be refused.
#   4. control: "attessa-r24-ctl", project of that name, key `attessa-r24-ctl:`. Must be accepted.
#   5. the committed lockfile. Must be accepted.
# With PNPM_CJS set to a pnpm 10.32.1 bin/pnpm.cjs, it first shows pnpm's reading with no network: in a scratch
# workspace with case 1, `install --frozen-lockfile --offline` succeeds and links packages/cli/node_modules/1000
# to ../../a, the project named "1e3", leaving the lockfile unchanged.
# Expected: 5 "ok:" lines (6 with PNPM_CJS) and exit 0.
# Usage: $0 <repo> [commit under test, default HEAD]
set -u
src="${1:?repo}"; rev="${2:-HEAD}"
R=$(mktemp -d "${TMPDIR:-/tmp}/attessa-adv-numeric-r24.XXXX") && [ -d "$R" ] || { echo "FAIL: no scratch folder"; exit 1; }
trap 'rm -rf "$R"' EXIT
rc=0
if [ -n "${PNPM_CJS:-}" ]; then
  P="$R/ws"; mkdir -p "$P/packages/cli" "$P/packages/a"
  printf '{"name":"probe","private":true}\n' > "$P/package.json"
  printf 'packages:\n  - packages/*\nignoreScripts: true\n' > "$P/pnpm-workspace.yaml"
  printf '{"name":"cli","version":"1.0.0","dependencies":{"1000":"workspace:*"}}\n' > "$P/packages/cli/package.json"
  printf '{"name":"1e3","version":"0.0.0","private":true}\n' > "$P/packages/a/package.json"
  printf "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n\n  packages/a: {}\n\n  packages/cli:\n    dependencies:\n      1e3:\n        specifier: workspace:*\n        version: link:../a\n" > "$P/pnpm-lock.yaml"
  cp "$P/pnpm-lock.yaml" "$P/lock-before.yaml"
  (cd "$P" && env npm_config_userconfig=/dev/null XDG_CONFIG_HOME="$P/cfg" node "$PNPM_CJS" install --frozen-lockfile --offline --store-dir "$P/store" --no-side-effects-cache >"$P/log" 2>&1)
  ist=$?
  guard=$(python3 -I -c 'import sys, yaml; print(sorted(yaml.safe_load(open(sys.argv[1], "rb"))["importers"]["packages/cli"]["dependencies"]))' "$P/lock-before.yaml")
  l="$P/packages/cli/node_modules/1000"
  if [ $ist -eq 0 ] && [ -L "$l" ] && [ "$(readlink "$l")" = ../../a ] && [ "$guard" = "['1e3']" ] && cmp -s "$P/lock-before.yaml" "$P/pnpm-lock.yaml"; then
    echo "ok: pnpm $(node "$PNPM_CJS" --version): PyYAML reads the dependency as $guard, pnpm links node_modules/1000 -> ../../a (the project named 1e3) under --frozen-lockfile"
  else
    echo "FAIL: pnpm's reading differs: install exit $ist, PyYAML $guard, node_modules/1000 -> $(readlink "$l" 2>/dev/null || echo nothing): $(tail -1 "$P/log")"; rc=1
  fi
fi
# Every git command below runs in this scratch copy only: stop if it could not be made.
mkdir "$R/repo" && git -C "$src" archive "$rev" | tar -x -C "$R/repo" && cd "$R/repo" || { echo "FAIL: could not extract $rev into $R/repo"; exit 1; }
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base || { echo "FAIL: could not commit the scratch copy"; exit 1; }
base='better-sqlite3@13.0.3: allowlisted package without its pinned registry integrity'
# mkcase <dependency name pnpm reads> <project name and plain lockfile key>: the project packages/attessa-r24-a,
# the dependency in packages/cli/package.json, and the key written plain (unquoted) in its lockfile importer.
mkcase() {
  python3 -I - "$PWD" "$1" "$2" <<'PY'
import json, os, re, sys
root, dep, key = sys.argv[1], sys.argv[2], sys.argv[3]
d = os.path.join(root, "packages/attessa-r24-a"); os.makedirs(d)
with open(os.path.join(d, "package.json"), "w") as f: f.write(json.dumps({"name": key, "version": "0.0.0", "private": True}, indent=2) + "\n")
lp = os.path.join(root, "pnpm-lock.yaml"); t = open(lp).read()
t, n = re.subn(r"(\n  packages/cli:\n    dependencies:\n)", lambda g: g.group(1) + "      %s:\n        specifier: workspace:*\n        version: link:../attessa-r24-a\n" % key, t, count=1)
assert n == 1, "packages/cli importer not found"
open(lp, "w").write(t)
mp = os.path.join(root, "packages/cli/package.json"); m = open(mp).read()
m, k = re.subn(r'("dependencies": \{\n)', lambda g: g.group(1) + "    %s: \"workspace:*\",\n" % json.dumps(dep), m, count=1)
assert k == 1, "dependencies not found in packages/cli/package.json"
open(mp, "w").write(m)
PY
}
case_() {  # case_ <label> <expect refused: 1|0> [dependency name, project name and key]
  git reset -q --hard HEAD && git clean -qfdx
  if [ -n "${3:-}" ]; then mkcase "$3" "$4" || { echo "FAIL: $1: could not make the case"; rc=1; return; }; fi
  sed -i 's#integrity: sha512-RbOBxmLBG8uvFUc15X9#integrity: sha512-AbOBxmLBG8uvFUc15X9#' pnpm-lock.yaml
  git add -A && git -c user.name=adv -c user.email=adv@x commit -qm case
  out=$(./scripts/check-install-scripts.sh 2>&1)
  other=$(grep -a '^FAIL ' <<<"$out" | grep -avF "$base")
  if ! grep -qaF "$base" <<<"$out"; then
    echo "FAIL: $1: the static stage did not run to the lockfile check: ${out##*$'\n'}"; rc=1
  elif [ -n "$other" ]; then
    [ "$2" = 1 ] && echo "ok: $1: refused" || { echo "FAIL: $1: refused: $(head -1 <<<"$other")"; rc=1; }
  else
    [ "$2" = 0 ] && echo "ok: $1: accepted" || { echo "FAIL: $1: accepted (PyYAML reads the key as the string '$4', the project's name; pnpm, a YAML 1.2 reader, reads a number and links dependency '$3' to that project's folder); the guard's only FAIL lines: $(grep -a '^FAIL' <<<"$out" | paste -sd '|')"; rc=1; }
  fi
  git reset -q --hard HEAD~1 && git clean -qfdx
}
case_ 'packages/cli dependency 1000 (workspace:*), lockfile key 1e3 (link:../attessa-r24-a, project named 1e3)' 1 1000 1e3
case_ 'packages/cli dependency 15 (workspace:*), lockfile key 0o17 (link:../attessa-r24-a, project named 0o17)' 1 15 0o17
case_ 'packages/cli dependency 8 (workspace:*), lockfile key 08 (link:../attessa-r24-a, project named 08)' 1 8 08
case_ 'control: packages/cli dependency attessa-r24-ctl, lockfile key attessa-r24-ctl, project of that name' 0 attessa-r24-ctl attessa-r24-ctl
case_ 'the committed lockfile' 0
exit $rc
