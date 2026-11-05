#!/usr/bin/env bash
# Install allow-list adversary r22 lead: the guard's workspace projects are keyed by git's path decoded with
# os.fsdecode (surrogateescape), so a tracked packages/<d>/package.json whose folder name is not UTF-8, say the
# bytes "a\xff", becomes the project "packages/a\udcff". pnpm 10.32.1 reads folder names through node, which
# decodes them as UTF-8 with U+FFFD for each bad byte, so it never finds that manifest (findPackages drops the
# ENOENT) and lists no such project. The lockfile may still spell the lone surrogate with a YAML "\udcff"
# escape, which PyYAML and js-yaml both accept: the guard then matches `version: "link:../a\udcff"` to its
# project, while pnpm encodes the same string as UTF-8 (U+FFFD, bytes ef bf bd) and links the dependency to the
# folder "a\xef\xbf\xbd", a different, plain folder with no manifest that is no workspace project at all. Under
# --frozen-lockfile pnpm links it as written, with no integrity check, and it is outside `pnpm -r`.
# Contract: the guard's lockfile comment "Every package comes from the default registry by integrity (no tarball,
# file, directory, git, link or other registry)" and its importer rule "each dependency is either the workspace
# project of that name (workspace: specifier, link: to its folder) or the registry snapshot of that name".
# Cases (each breaks the better-sqlite3 integrity so the probe never reaches pnpm or the network):
#   1. packages/attessa-r22<ff> named attessa-r22-bytes plus a plain folder packages/attessa-r22<ef bf bd>
#      holding only index.js; packages/cli depends on attessa-r22-bytes via link:"../attessa-r22\udcff": must
#      be refused.
#   2. control: packages/attessa-r22-<U+00E9> (valid UTF-8, a project pnpm lists), link:../attessa-r22-<U+00E9>:
#      must be accepted.
#   3. the committed lockfile: must be accepted.
# With PNPM_CJS set to a pnpm 10.32.1 bin/pnpm.cjs, it first shows pnpm's reading with no network: in a scratch
# workspace, `pnpm ls -r` does not list packages/a<ff>, and `install --frozen-lockfile --offline` links
# packages/cli/node_modules/x to packages/a<ef bf bd>, the plain folder.
# Expected: 3 "ok:" lines (4 with PNPM_CJS) and exit 0.
# Usage: $0 <repo> [commit under test, default HEAD]
set -u
src="${1:?repo}"; rev="${2:-HEAD}"
R=$(mktemp -d "${TMPDIR:-/tmp}/attessa-adv-bytes-r22.XXXX") && [ -d "$R" ] || { echo "FAIL: no scratch folder"; exit 1; }
trap 'rm -rf "$R"' EXIT
rc=0
# mkfolders <root> <folder bytes, Python escapes> <project name> [plain folder bytes]: a project folder with a
# package.json named <project name>, and optionally a plain folder holding only index.js.
mkfolders() {
  python3 -I - "$@" <<'PY'
import ast, json, os, sys
root = os.fsencode(sys.argv[1]) + b"/packages/"
d = ast.literal_eval("b'%s'" % sys.argv[2])
os.makedirs(root + d)
with open(root + d + b"/package.json", "w") as f: f.write(json.dumps({"name": sys.argv[3], "version": "0.0.0", "private": True}, indent=2) + "\n")
if len(sys.argv) > 4:
    plain = ast.literal_eval("b'%s'" % sys.argv[4])
    os.makedirs(root + plain)
    with open(root + plain + b"/index.js", "w") as f: f.write("module.exports = 'a plain folder, no workspace project'\n")
PY
}
if [ -n "${PNPM_CJS:-}" ]; then
  P="$R/ws"; mkdir -p "$P/packages/cli"
  mkfolders "$P" 'a\xff' x 'a\xef\xbf\xbd' || { echo "FAIL: could not make the scratch workspace"; exit 1; }
  printf '{"name":"probe","private":true}\n' > "$P/package.json"
  printf 'packages:\n  - packages/*\nignoreScripts: true\n' > "$P/pnpm-workspace.yaml"
  printf '{"name":"cli","version":"1.0.0","dependencies":{"x":"workspace:*"}}\n' > "$P/packages/cli/package.json"
  printf "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n\n  packages/cli:\n    dependencies:\n      x:\n        specifier: workspace:*\n        version: \"link:../a%s\"\n" '\udcff' > "$P/pnpm-lock.yaml"
  env=(npm_config_userconfig=/dev/null XDG_CONFIG_HOME="$P/cfg")
  projects=$(cd "$P" && env "${env[@]}" node "$PNPM_CJS" ls -r --depth -1 --json 2>/dev/null \
    | python3 -I -c 'import json, os, sys; r = sys.argv[1]; print(" ".join(sorted(os.path.relpath(x["path"], r) for x in json.load(sys.stdin))))' "$(cd "$P" && pwd -P)")
  (cd "$P" && env "${env[@]}" node "$PNPM_CJS" install --frozen-lockfile --offline --store-dir "$P/store" --no-side-effects-cache >"$P/log" 2>&1)
  ist=$?
  target=$(readlink "$P/packages/cli/node_modules/x" | od -An -c | tr -s ' ' | sed 's/^ //')
  if [ "$projects" = ". packages/cli" ] && [ $ist -eq 0 ] && [ "$target" = '. . / . . / a 357 277 275 \n' ] \
     && [ ! -e "$P/packages/cli/node_modules/x/package.json" ] && [ -f "$P/packages/cli/node_modules/x/index.js" ]; then
    echo "ok: pnpm $(node "$PNPM_CJS" --version) lists only '$projects' as workspace projects (not packages/a<ff>), yet links x -> packages/a<ef bf bd>, a plain folder, under --frozen-lockfile"
  else
    echo "FAIL: pnpm's reading differs: projects '$projects', install exit $ist, x -> '$target': $(tail -1 "$P/log")"; rc=1
  fi
fi
# Every git command below runs in this scratch copy only: stop if it could not be made.
mkdir "$R/repo" && git -C "$src" archive "$rev" | tar -x -C "$R/repo" && cd "$R/repo" || { echo "FAIL: could not extract $rev into $R/repo"; exit 1; }
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base || { echo "FAIL: could not commit the scratch copy"; exit 1; }
base='better-sqlite3@13.0.3: allowlisted package without its pinned registry integrity'
case_() {  # case_ <label> <expect refused: 1|0> [folder bytes] [project name] [link target as a YAML double-quoted body] [plain folder bytes]
  git reset -q --hard HEAD && git clean -qfdx
  if [ -n "${3:-}" ]; then
    python3 -I - "$4" "$5" <<'PY'
import json, re, sys
name, target = sys.argv[1], sys.argv[2]
t = open("pnpm-lock.yaml", encoding="utf-8").read()
t, n = re.subn(r"(\n  packages/cli:\n    dependencies:\n)", lambda g: g.group(1) + "      %s:\n        specifier: workspace:*\n        version: \"link:../%s\"\n" % (name, target), t, count=1)
assert n == 1, "packages/cli importer not found"
open("pnpm-lock.yaml", "w", encoding="utf-8").write(t)
m = open("packages/cli/package.json", encoding="utf-8").read()
m, k = re.subn(r'("dependencies": \{\n)', lambda g: g.group(1) + "    %s: \"workspace:*\",\n" % json.dumps(name), m, count=1)
assert k == 1, "dependencies not found in packages/cli/package.json"
open("packages/cli/package.json", "w", encoding="utf-8").write(m)
PY
    mkfolders "$PWD" "$3" "$4" ${6:+"$6"} || { echo "FAIL: $1: could not make the folders"; rc=1; return; }
  fi
  sed -i 's#integrity: sha512-RbOBxmLBG8uvFUc15X9#integrity: sha512-AbOBxmLBG8uvFUc15X9#' pnpm-lock.yaml
  git add -A && git -c user.name=adv -c user.email=adv@x commit -qm case
  out=$(./scripts/check-install-scripts.sh 2>&1)
  other=$(grep -a '^FAIL ' <<<"$out" | grep -avF "$base")
  if ! grep -qaF "$base" <<<"$out"; then
    echo "FAIL: $1: the static stage did not run to the lockfile check: ${out##*$'\n'}"; rc=1
  elif [ -n "$other" ]; then
    [ "$2" = 1 ] && echo "ok: $1: refused" || { echo "FAIL: $1: refused: $(head -1 <<<"$other")"; rc=1; }
  else
    [ "$2" = 0 ] && echo "ok: $1: accepted" || { echo "FAIL: $1: accepted (pnpm decodes the folder name as UTF-8 with U+FFFD, lists no such project, and links the dependency to the plain folder packages/attessa-r22<ef bf bd>); the guard's only FAIL lines: $(grep -a '^FAIL' <<<"$out" | paste -sd '|')"; rc=1; }
  fi
  git reset -q --hard HEAD~1 && git clean -qfdx
}
case_ 'packages/cli dependency attessa-r22-bytes (workspace:*, link:"../attessa-r22\udcff"), a folder name that is not UTF-8' 1 'attessa-r22\xff' attessa-r22-bytes 'attessa-r22\udcff' 'attessa-r22\xef\xbf\xbd'
case_ 'control: packages/cli dependency attessa-r22-e (workspace:*, link:../attessa-r22-<U+00E9>), a workspace project' 0 'attessa-r22-\xc3\xa9' attessa-r22-e 'attessa-r22-\u00e9'
case_ 'the committed lockfile' 0
exit $rc
