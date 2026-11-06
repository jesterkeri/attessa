#!/usr/bin/env bash
# Install allow-list adversary r18 lead: an importer's dependency `version` in pnpm-lock.yaml decides what
# pnpm links, and pnpm 10.32.1 under --frozen-lockfile checks only the specifier against package.json.
# satisfiesPackageManifest compares importer specifiers with the manifest, and compares the version with the
# range only when the version is plain semver, so:
#   - `link:<any path>` under a `workspace:` specifier is linked as is (headless getChildrenPaths), whether
#     the path is a workspace project or not: a folder of the tree that is no project, or a folder outside
#     the repository. The guard's rule ("link: only for a workspace: specifier") checks the prefix only.
#   - `<other-name>@<version>` (pnpm's own alias form, no ":") makes the dependency the snapshot of another
#     registry package, though the manifest names a plain registry version (the guard refuses npm: aliases
#     in manifests). The guard refuses a version only when it holds a ":".
# Cases (each must be refused with a FAIL line naming the dependency or the path), then the committed
# lockfile (must not be refused). Each case breaks the better-sqlite3 integrity so the probe never reaches
# pnpm or the network.
#   1. packages/cli viem: "workspace:*" in the manifest, `link:../../vendor/viem` in the lockfile, with a
#      tracked vendor/viem whose package.json passes the manifest rules: viem becomes a tree folder.
#   2. packages/cli @attessa/core: `link:/opt/attessa-r18-outside`, a folder outside the repository.
#   3. packages/cli viem: manifest unchanged (2.57.13), lockfile version `typescript@5.9.3`: viem becomes
#      the typescript package.
# With PNPM_CJS set to a pnpm 10.32.1 bin/pnpm.cjs, it also shows pnpm's reading with no network: a
# workspace:* dependency b (a workspace project) linked to vendor/b (no project), the same linked to a folder
# outside the project, a workspace:* dependency viem that names no project linked to vendor/viem, and (from
# a localhost registry by integrity) a dependency `probe-parent: 1.0.0` installed as probe-other.
# Expected: 4 "ok:" lines (8 with PNPM_CJS) and exit 0.
# Usage: $0 <repo> [commit under test, default HEAD]
set -u
src="${1:?repo}"; rev="${2:-HEAD}"
R=$(mktemp -d "${TMPDIR:-/tmp}/attessa-adv-imp-r18.XXXX") && [ -d "$R" ] || { echo "FAIL: no scratch folder"; exit 1; }
srv=; trap 'kill $srv 2>/dev/null; rm -rf "$R"' EXIT
rc=0
if [ -n "${PNPM_CJS:-}" ]; then
  pn() {  # pn <project> [registry port]: frozen install of <project> with the pinned pnpm, user config kept out
    (cd "$1" && npm_config_userconfig=/dev/null XDG_CONFIG_HOME="$1/cfg" node "$PNPM_CJS" install --frozen-lockfile \
      ${2:+--config.registry=http://127.0.0.1:$2/} --store-dir "$1/store" --no-side-effects-cache >"$1/log" 2>&1)
  }
  head9="lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n"
  mkdir -p "$R/outside/b"
  printf '{"name":"b","version":"1.0.0","main":"index.js"}\n' > "$R/outside/b/package.json"
  printf 'module.exports = "outside-the-project";\n' > "$R/outside/b/index.js"
  # <dependency name> <link target> <what require() must return>: b is a workspace project, viem is none.
  for v in "b ../../vendor/b from-the-tree" "b $R/outside/b outside-the-project" "viem ../../vendor/viem from-the-tree"; do
    read -r dn to want <<<"$v"
    P="$R/ws-$dn-${want%%-*}"; mkdir -p "$P/packages/a" "$P/packages/b" "$P/vendor/$dn"
    printf '{"name":"probe","private":true}\n' > "$P/package.json"
    printf 'packages:\n  - packages/*\nignoreScripts: true\n' > "$P/pnpm-workspace.yaml"
    printf '{"name":"a","version":"1.0.0","dependencies":{"%s":"workspace:*"}}\n' "$dn" > "$P/packages/a/package.json"
    printf '{"name":"b","version":"1.0.0","main":"index.js"}\n' > "$P/packages/b/package.json"
    printf 'module.exports = "the-workspace-project";\n' > "$P/packages/b/index.js"
    printf '{"name":"%s","version":"1.0.0","main":"index.js"}\n' "$dn" > "$P/vendor/$dn/package.json"
    printf 'module.exports = "from-the-tree";\n' > "$P/vendor/$dn/index.js"
    printf "$head9  .: {}\n\n  packages/a:\n    dependencies:\n      %s:\n        specifier: workspace:*\n        version: link:%s\n\n  packages/b: {}\n" "$dn" "$to" > "$P/pnpm-lock.yaml"
    pn "$P"
    got=$(cd "$P/packages/a" && node -e 'console.log(require(process.argv[1]))' "$dn" 2>/dev/null)
    [ "$got" = "$want" ] \
      && echo "ok: pnpm $(node "$PNPM_CJS" --version) links the workspace:* dependency $dn to link:$to ($want)" \
      || { echo "FAIL: pnpm did not follow link:$to for the workspace:* dependency $dn (got '$got'): $(tail -1 "$P/log")"; rc=1; }
  done
  P="$R/alias"; mkdir -p "$P/tb/package" "$P/reg"
  printf '{"name":"probe-other","version":"1.0.0","main":"index.js"}\n' > "$P/tb/package/package.json"
  printf 'module.exports = "probe-other";\n' > "$P/tb/package/index.js"
  tar -czf "$P/reg/probe-other-1.0.0.tgz" -C "$P/tb" package
  I=$(node -e 'console.log("sha512-" + require("crypto").createHash("sha512").update(require("fs").readFileSync(process.argv[1])).digest("base64"))' "$P/reg/probe-other-1.0.0.tgz")
  printf '{"name":"probe","private":true,"dependencies":{"probe-parent":"1.0.0"}}\n' > "$P/package.json"
  printf 'packages:\n  - packages/*\nignoreScripts: true\n' > "$P/pnpm-workspace.yaml"
  printf "$head9  .:\n    dependencies:\n      probe-parent:\n        specifier: 1.0.0\n        version: probe-other@1.0.0\n\npackages:\n\n  probe-other@1.0.0:\n    resolution: {integrity: %s}\n\nsnapshots:\n\n  probe-other@1.0.0: {}\n" "$I" > "$P/pnpm-lock.yaml"
  # A localhost registry that serves only the tarballs in reg/: the default registry's role, offline.
  node -e '
const http = require("http"), fs = require("fs"), path = require("path");
const s = http.createServer((q, r) => { const f = path.join(process.argv[1], path.basename(q.url));
  if (q.url.endsWith(".tgz") && fs.existsSync(f)) r.end(fs.readFileSync(f)); else { r.statusCode = 404; r.end(); } });
s.listen(0, "127.0.0.1", () => fs.writeFileSync(process.argv[2], String(s.address().port)));' "$P/reg" "$P/port" &
  srv=$!
  for _ in $(seq 50); do [ -s "$P/port" ] && break; sleep 0.1; done
  pn "$P" "$(cat "$P/port")"
  got=$(cd "$P" && node -e 'console.log(require("probe-parent"))' 2>/dev/null)
  kill $srv 2>/dev/null; srv=
  [ "$got" = 'probe-other' ] \
    && echo "ok: pnpm installs probe-other@1.0.0 as the dependency probe-parent (manifest 1.0.0) from the importer version probe-other@1.0.0" \
    || { echo "FAIL: pnpm did not install the importer version probe-other@1.0.0 as probe-parent (got '$got'): $(tail -1 "$P/log")"; rc=1; }
fi
# Every git command below runs in this scratch copy only: stop if it could not be made.
mkdir "$R/repo" && git -C "$src" archive "$rev" | tar -x -C "$R/repo" && cd "$R/repo" || { echo "FAIL: could not extract $rev into $R/repo"; exit 1; }
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
case_() {  # case_ <label> <expect refused: 1|0> [case number]
  git reset -q --hard HEAD && git clean -qfdx
  if [ -n "${3:-}" ]; then
    python3 -I - "$3" <<'PY'
import re, sys
c = sys.argv[1]
t = open("pnpm-lock.yaml").read()
cli = r"(\n  packages/cli:\n    dependencies:\n(      [^\n]+\n)*?"
if c == "1":
    t, n = re.subn(cli + r"      viem:\n)        specifier: 2\.57\.13\n        version: 2\.57\.13\(typescript@5\.9\.3\)\n",
                   r"\1        specifier: workspace:*\n        version: link:../../vendor/viem\n", t, count=1)
    m = open("packages/cli/package.json").read()
    m, k = re.subn(r'"viem": "2\.57\.13"', '"viem": "workspace:*"', m, count=1)
    assert k == 1, "viem not found in packages/cli/package.json"
    open("packages/cli/package.json", "w").write(m)
elif c == "2":
    t, n = re.subn(cli + r"      '@attessa/core':\n        specifier: workspace:\*\n)        version: link:\.\./core\n",
                   r"\1        version: link:/opt/attessa-r18-outside\n", t, count=1)
else:
    t, n = re.subn(cli + r"      viem:\n        specifier: 2\.57\.13\n)        version: 2\.57\.13\(typescript@5\.9\.3\)\n",
                   r"\1        version: typescript@5.9.3\n", t, count=1)
assert n == 1, "packages/cli entry not found for case " + c
open("pnpm-lock.yaml", "w").write(t)
PY
    if [ "$3" = 1 ]; then
      mkdir -p vendor/viem
      printf '{\n  "name": "viem",\n  "version": "2.57.13",\n  "main": "index.js"\n}\n' > vendor/viem/package.json
      printf 'module.exports = { from: "the tree under test" };\n' > vendor/viem/index.js
    fi
  fi
  sed -i 's#integrity: sha512-RbOBxmLBG8uvFUc15X9#integrity: sha512-AbOBxmLBG8uvFUc15X9#' pnpm-lock.yaml
  git add -A && git -c user.name=adv -c user.email=adv@x commit -qm case
  out=$(./scripts/check-install-scripts.sh 2>&1)
  pat='^FAIL .*(viem|@attessa/core|vendor/|/opt/|typescript@)'
  if ! grep -q 'better-sqlite3@13.0.3: allowlisted package without its pinned registry integrity' <<<"$out"; then
    echo "FAIL: $1: the static stage did not run to the lockfile check: ${out##*$'\n'}"; rc=1
  elif grep -qE "$pat" <<<"$out"; then
    [ "$2" = 1 ] && echo "ok: $1: refused" || { echo "FAIL: $1: refused: $(grep -E "$pat" <<<"$out" | head -1)"; rc=1; }
  else
    [ "$2" = 0 ] && echo "ok: $1: accepted" || { echo "FAIL: $1: accepted (pnpm installs that version as is under --frozen-lockfile); the guard's only FAIL lines: $(grep '^FAIL' <<<"$out" | paste -sd '|')"; rc=1; }
  fi
  git reset -q --hard HEAD~1
}
case_ 'packages/cli viem workspace:* linked to link:../../vendor/viem, a tree folder that is no workspace project' 1 1
case_ 'packages/cli @attessa/core linked to link:/opt/attessa-r18-outside, outside the repository' 1 2
case_ 'packages/cli viem 2.57.13 with importer version typescript@5.9.3, another registry package' 1 3
case_ 'the committed lockfile' 0
exit $rc
