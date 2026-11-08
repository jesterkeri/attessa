#!/usr/bin/env bash
# Install allow-list adversary r23 lead: the guard reads pnpm-lock.yaml with PyYAML, a YAML 1.1 reader, and pnpm
# 10.32.1 with js-yaml, a YAML 1.2 reader. YAML 1.1 counts NEL (U+0085), LS (U+2028) and PS (U+2029) as line
# breaks; YAML 1.2 counts only CR and LF. So the same quoted lockfile scalar names two different folders:
#   - `version: "link:../a<U+0085>b"`: PyYAML folds the NEL to a space and reads "link:../a b"; pnpm keeps the
#     NEL and links to the folder "a<U+0085>b".
#   - `version: "link:../a <U+2028> b"`: PyYAML keeps the LS but strips the spaces around it as line-break
#     padding and reads "link:../a<U+2028>b"; pnpm keeps every character and links to "a <U+2028> b".
# Both folder names are valid UTF-8, so the r22 rule (paths that are not UTF-8) does not apply. The guard matches
# its reading to the workspace project in the folder it names, while pnpm, under --frozen-lockfile, links the
# dependency as written to a different, plain folder with no manifest that is no workspace project at all.
# Contract: the guard's lockfile comment "Every package comes from the default registry by integrity (no tarball,
# file, directory, git, link or other registry)" and its importer rule "each dependency is either the workspace
# project of that name (workspace: specifier, link: to its folder) or the registry snapshot of that name".
# Cases (each breaks the better-sqlite3 integrity so the probe never reaches pnpm or the network):
#   1. project packages/attessa-r23 n (name attessa-r23-nel), plain folder packages/attessa-r23<U+0085>n, link
#      "../attessa-r23<U+0085>n": must be refused.
#   2. project packages/attessa-r23<U+2028>l (name attessa-r23-ls), plain folder packages/attessa-r23 <U+2028> l,
#      link "../attessa-r23 <U+2028> l": must be refused.
#   3. project packages/attessa-r23-<U+00E9> (NFC), link "../attessa-r23-e<U+0301>" (NFD): must be refused (pnpm
#      links the NFD spelling, a folder that does not exist on Linux).
#   4. project packages/attessa-r23-e<U+0301> (NFD), link "../attessa-r23-<U+00E9>" (NFC): must be refused.
#   5. control: project packages/attessa-r23-<U+00E9>, link "../attessa-r23-<U+00E9>": must be accepted.
#   6. the committed lockfile: must be accepted.
# With PNPM_CJS set to a pnpm 10.32.1 bin/pnpm.cjs, it first shows pnpm's reading with no network: in a scratch
# workspace with the folders of case 1 (then case 2), `pnpm ls -r` lists the project, and
# `install --frozen-lockfile --offline` links packages/cli/node_modules/x to the plain folder.
# Expected: 6 "ok:" lines (8 with PNPM_CJS) and exit 0.
# Usage: $0 <repo> [commit under test, default HEAD]
set -u
src="${1:?repo}"; rev="${2:-HEAD}"
R=$(mktemp -d "${TMPDIR:-/tmp}/attessa-adv-breaks-r23.XXXX") && [ -d "$R" ] || { echo "FAIL: no scratch folder"; exit 1; }
trap 'rm -rf "$R"' EXIT
rc=0
# The cases' folder names and link bodies, by key, so no shell quoting touches the characters under test:
# (project folder, project name, link body written raw into a YAML double-quoted scalar, plain folder or "").
CASES='{
 "nel":  ["attessa-r23 n", "attessa-r23-nel", "attessa-r23\u0085n", "attessa-r23\u0085n"],
 "ls":   ["attessa-r23\u2028l", "attessa-r23-ls", "attessa-r23 \u2028 l", "attessa-r23 \u2028 l"],
 "nfd":  ["attessa-r23-\u00e9", "attessa-r23-nfd", "attessa-r23-e\u0301", ""],
 "nfc":  ["attessa-r23-e\u0301", "attessa-r23-nfc", "attessa-r23-\u00e9", ""],
 "same": ["attessa-r23-\u00e9", "attessa-r23-e", "attessa-r23-\u00e9", ""],
 "ws-nel": ["a b", "x", "a\u0085b", "a\u0085b"],
 "ws-ls":  ["a\u2028b", "x", "a \u2028 b", "a \u2028 b"]
}'
export CASES
# mkcase <root> <key> <add the dependency to packages/cli and its lockfile importer: 1|0>: the project folder with
# a package.json, the plain folder holding only index.js, and (with 1) the dependency on the project's name.
mkcase() {
  python3 -I - "$@" <<'PY'
import json, os, re, sys
root, key, edit = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
proj, name, link, plain = json.loads(os.environ["CASES"])[key]
pk = os.path.join(root, "packages")
os.makedirs(os.path.join(pk, proj))
with open(os.path.join(pk, proj, "package.json"), "w", encoding="utf-8") as f: f.write(json.dumps({"name": name, "version": "0.0.0", "private": True}, indent=2) + "\n")
if plain:
    os.makedirs(os.path.join(pk, plain))
    with open(os.path.join(pk, plain, "index.js"), "w") as f: f.write("module.exports = 'a plain folder, no workspace project'\n")
if edit:
    lp = os.path.join(root, "pnpm-lock.yaml")
    t = open(lp, encoding="utf-8").read()
    t, n = re.subn(r"(\n  packages/cli:\n    dependencies:\n)", lambda g: g.group(1) + "      %s:\n        specifier: workspace:*\n        version: \"link:../%s\"\n" % (name, link), t, count=1)
    assert n == 1, "packages/cli importer not found"
    open(lp, "w", encoding="utf-8").write(t)
    mp = os.path.join(root, "packages/cli/package.json")
    m = open(mp, encoding="utf-8").read()
    m, k = re.subn(r'("dependencies": \{\n)', lambda g: g.group(1) + "    %s: \"workspace:*\",\n" % json.dumps(name), m, count=1)
    assert k == 1, "dependencies not found in packages/cli/package.json"
    open(mp, "w", encoding="utf-8").write(m)
PY
}
if [ -n "${PNPM_CJS:-}" ]; then
  for key in ws-nel ws-ls; do
    P="$R/$key"; mkdir -p "$P/packages/cli"
    mkcase "$P" "$key" 0 || { echo "FAIL: could not make the scratch workspace"; exit 1; }
    printf '{"name":"probe","private":true}\n' > "$P/package.json"
    printf 'packages:\n  - packages/*\nignoreScripts: true\n' > "$P/pnpm-workspace.yaml"
    printf '{"name":"cli","version":"1.0.0","dependencies":{"x":"workspace:*"}}\n' > "$P/packages/cli/package.json"
    python3 -I - "$P" "$key" <<'PY'
import json, os, sys
link = json.loads(os.environ["CASES"])[sys.argv[2]][2]
open(os.path.join(sys.argv[1], "pnpm-lock.yaml"), "w", encoding="utf-8").write(
    "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n\n"
    "  packages/cli:\n    dependencies:\n      x:\n        specifier: workspace:*\n        version: \"link:../%s\"\n" % link)
PY
    # pnpm rewrites the lockfile at install (the NEL as a \N escape), so the guard's reading is taken first.
    cp "$P/pnpm-lock.yaml" "$P/lock-before.yaml"
    env=(npm_config_userconfig=/dev/null XDG_CONFIG_HOME="$P/cfg")
    (cd "$P" && env "${env[@]}" node "$PNPM_CJS" ls -r --depth -1 --json >"$P/ls.json" 2>/dev/null)
    (cd "$P" && env "${env[@]}" node "$PNPM_CJS" install --frozen-lockfile --offline --store-dir "$P/store" --no-side-effects-cache >"$P/log" 2>&1)
    ist=$?
    got=$(python3 -I - "$P" "$key" <<'PY'
import json, os, sys, yaml
P, key = sys.argv[1], sys.argv[2]
proj, _, _, plain = json.loads(os.environ["CASES"])[key]
x = os.path.join(P, "packages/cli/node_modules/x")
r = os.path.realpath(P)
try: projects = sorted(os.path.relpath(e["path"], r) for e in json.load(open(os.path.join(P, "ls.json"))))
except (OSError, ValueError, KeyError, TypeError): projects = None
guard = yaml.safe_load(open(os.path.join(P, "lock-before.yaml"), "rb"))["importers"]["packages/cli"]["dependencies"]["x"]["version"]
ok = (os.path.islink(x) and os.readlink(x) == "../../" + plain and not os.path.exists(os.path.join(x, "package.json"))
      and os.path.isfile(os.path.join(x, "index.js")) and guard == "link:../" + proj
      and projects == sorted([".", "packages/cli", "packages/" + proj]))
print(("ok " if ok else "differs ") + "pnpm lists %s as workspace projects; PyYAML reads %s, pnpm links x -> %s" % (ascii(projects), ascii(guard), ascii(os.readlink(x)) if os.path.islink(x) else "nothing"))
PY
)
    if [ $ist -eq 0 ] && [ "${got%% *}" = ok ]; then
      echo "ok: pnpm $(node "$PNPM_CJS" --version) ($key): ${got#ok }, a plain folder, under --frozen-lockfile"
    else
      echo "FAIL: pnpm's reading differs ($key): install exit $ist, $got: $(tail -1 "$P/log")"; rc=1
    fi
  done
fi
# Every git command below runs in this scratch copy only: stop if it could not be made.
mkdir "$R/repo" && git -C "$src" archive "$rev" | tar -x -C "$R/repo" && cd "$R/repo" || { echo "FAIL: could not extract $rev into $R/repo"; exit 1; }
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base || { echo "FAIL: could not commit the scratch copy"; exit 1; }
base='better-sqlite3@13.0.3: allowlisted package without its pinned registry integrity'
case_() {  # case_ <label> <expect refused: 1|0> [case key]
  git reset -q --hard HEAD && git clean -qfdx
  if [ -n "${3:-}" ]; then mkcase "$PWD" "$3" 1 || { echo "FAIL: $1: could not make the folders"; rc=1; return; }; fi
  sed -i 's#integrity: sha512-RbOBxmLBG8uvFUc15X9#integrity: sha512-AbOBxmLBG8uvFUc15X9#' pnpm-lock.yaml
  git add -A && git -c user.name=adv -c user.email=adv@x commit -qm case
  out=$(./scripts/check-install-scripts.sh 2>&1)
  other=$(grep -a '^FAIL ' <<<"$out" | grep -avF "$base")
  if ! grep -qaF "$base" <<<"$out"; then
    echo "FAIL: $1: the static stage did not run to the lockfile check: ${out##*$'\n'}"; rc=1
  elif [ -n "$other" ]; then
    [ "$2" = 1 ] && echo "ok: $1: refused" || { echo "FAIL: $1: refused: $(head -1 <<<"$other")"; rc=1; }
  else
    [ "$2" = 0 ] && echo "ok: $1: accepted" || { echo "FAIL: $1: accepted (PyYAML reads the link as the project's folder, while pnpm, a YAML 1.2 reader, keeps the characters PyYAML treats as line breaks and links the dependency to the plain folder); the guard's only FAIL lines: $(grep -a '^FAIL' <<<"$out" | paste -sd '|')"; rc=1; }
  fi
  git reset -q --hard HEAD~1 && git clean -qfdx
}
case_ 'packages/cli dependency attessa-r23-nel (workspace:*, link:"../attessa-r23<U+0085>n"), PyYAML reads ../attessa-r23 n' 1 nel
case_ 'packages/cli dependency attessa-r23-ls (workspace:*, link:"../attessa-r23 <U+2028> l"), PyYAML reads ../attessa-r23<U+2028>l' 1 ls
case_ 'packages/cli dependency attessa-r23-nfd (workspace:*, link:../attessa-r23-e<U+0301>), project folder NFC' 1 nfd
case_ 'packages/cli dependency attessa-r23-nfc (workspace:*, link:../attessa-r23-<U+00E9>), project folder NFD' 1 nfc
case_ 'control: packages/cli dependency attessa-r23-e (workspace:*, link:../attessa-r23-<U+00E9>), a workspace project' 0 same
case_ 'the committed lockfile' 0
exit $rc
