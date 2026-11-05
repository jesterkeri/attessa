#!/usr/bin/env bash
# Install allow-list adversary r17 lead: a pnpm-lock.yaml `packages` entry may carry its own
# `dependencies`, and those are the ones pnpm installs. pnpm 10.32.1's convertToLockfileObject builds each
# package as Object.assign(snapshot, packages[removeSuffix(key)]), so every field of the packages entry
# overwrites the snapshot's, `dependencies` included, and headless getChildrenPaths turns a `link:` (or
# `file:`) value into a symlink to that path under the lockfile's folder. The guard refuses a ":" only in
# snapshots[*].dependencies and optionalDependencies, and under packages checks the key and `resolution`
# alone, so `tr46@5.1.1: {resolution: {integrity: ...}, dependencies: {punycode: link:vendor/punycode}}`
# passes, and pnpm gives the registry copy of tr46 a punycode that is a folder of the tree under test,
# with no integrity: tr46's require("punycode/") then loads vendor/punycode/punycode.js.
# Cases: the link in the packages entry (must be refused with a FAIL line naming punycode, vendor/ or
# tr46), the same link in the snapshot (the guard already refuses it: the control), and the committed
# lockfile (must not be refused). Each case breaks the better-sqlite3 integrity so the probe never reaches
# pnpm or the network.
# With PNPM_CJS set to a pnpm 10.32.1 bin/pnpm.cjs, it also shows pnpm's reading with no network: a
# scratch project takes probe-parent@1.0.0 from a localhost registry by integrity (the lockfile shape the
# guard accepts), and its packages entry's dependencies link probe-child to the project's vendor/probe-child
# under --frozen-lockfile, although the snapshot says probe-child 1.0.0.
# Expected: 3 "ok:" lines (4 with PNPM_CJS) and exit 0.
# Usage: $0 <repo> [commit under test, default HEAD]
set -u
src="${1:?repo}"; rev="${2:-HEAD}"
R=$(mktemp -d "${TMPDIR:-/tmp}/attessa-adv-lock-r17.XXXX"); trap 'kill $srv 2>/dev/null; rm -rf "$R"' EXIT
srv=
rc=0
if [ -n "${PNPM_CJS:-}" ]; then
  P="$R/pnpm-probe"; mkdir -p "$P/tb/package" "$P/vendor/probe-child" "$P/reg"
  printf '{"name":"probe-parent","version":"1.0.0","main":"index.js"}\n' > "$P/tb/package/package.json"
  printf 'module.exports = require("probe-child");\n' > "$P/tb/package/index.js"
  tar -czf "$P/reg/probe-parent-1.0.0.tgz" -C "$P/tb" package
  I=$(node -e 'console.log("sha512-" + require("crypto").createHash("sha512").update(require("fs").readFileSync(process.argv[1])).digest("base64"))' "$P/reg/probe-parent-1.0.0.tgz")
  printf '{"name":"probe-child","version":"1.0.0","main":"index.js"}\n' > "$P/vendor/probe-child/package.json"
  printf 'module.exports = "from the tree under test";\n' > "$P/vendor/probe-child/index.js"
  printf '{"name":"probe","private":true,"dependencies":{"probe-parent":"1.0.0"}}\n' > "$P/package.json"
  printf 'packages:\n  - packages/*\nignoreScripts: true\n' > "$P/pnpm-workspace.yaml"
  printf "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    dependencies:\n      probe-parent:\n        specifier: 1.0.0\n        version: 1.0.0\n\npackages:\n\n  probe-parent@1.0.0:\n    resolution: {integrity: %s}\n    dependencies:\n      probe-child: link:vendor/probe-child\n\nsnapshots:\n\n  probe-parent@1.0.0:\n    dependencies:\n      probe-child: 1.0.0\n" "$I" > "$P/pnpm-lock.yaml"
  # A localhost registry that serves only the tarballs in reg/: the default registry's role, offline.
  node -e '
const http = require("http"), fs = require("fs"), path = require("path");
const s = http.createServer((q, r) => { const f = path.join(process.argv[1], path.basename(q.url));
  if (q.url.endsWith(".tgz") && fs.existsSync(f)) r.end(fs.readFileSync(f)); else { r.statusCode = 404; r.end(); } });
s.listen(0, "127.0.0.1", () => fs.writeFileSync(process.argv[2], String(s.address().port)));' "$P/reg" "$P/port" &
  srv=$!
  for _ in $(seq 50); do [ -s "$P/port" ] && break; sleep 0.1; done
  (cd "$P" && npm_config_userconfig=/dev/null XDG_CONFIG_HOME="$P/cfg" node "$PNPM_CJS" install --frozen-lockfile \
    --config.registry="http://127.0.0.1:$(cat "$P/port")/" --store-dir "$P/store" --no-side-effects-cache >/dev/null 2>&1)
  got=$(cd "$P" && node -e 'console.log(require("probe-parent"))' 2>/dev/null)
  kill $srv 2>/dev/null; srv=
  [ "$got" = 'from the tree under test' ] \
    && echo "ok: pnpm $(node "$PNPM_CJS" --version) gives the registry copy of probe-parent@1.0.0 the probe-child in vendor/probe-child, from its packages entry's dependencies" \
    || { echo "FAIL: pnpm did not link probe-child from the packages entry, so it reads a package's dependencies from its snapshot only (got '$got')"; rc=1; }
fi
mkdir "$R/repo"; git -C "$src" archive "$rev" | tar -x -C "$R/repo"; cd "$R/repo"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
case_() {  # case_ <label> <expect refused: 1|0> [where the link goes: packages|snapshots]
  git reset -q --hard HEAD && git clean -qfdx
  if [ -n "${3:-}" ]; then
    # tr46@5.1.1 is a registry package of packages/core whose snapshot depends on punycode 2.3.1. The link
    # goes either into its packages entry (as a dependencies field of its own) or into its snapshot.
    python3 -I - "$3" <<'PY'
import re, sys
t = open("pnpm-lock.yaml").read()
if sys.argv[1] == "packages":
    t, n = re.subn(r"(\n  tr46@5\.1\.1:\n    resolution: \{integrity: sha512-[^}]+\}\n(    [^\n]+\n)*)", r"\1    dependencies:\n      punycode: link:vendor/punycode\n", t, count=1)
else:
    t, n = re.subn(r"(\n  tr46@5\.1\.1:\n    dependencies:\n      punycode: )2\.3\.1\n", r"\1link:vendor/punycode\n", t, count=1)
assert n == 1, "tr46@5.1.1 entry not found in " + sys.argv[1]
open("pnpm-lock.yaml", "w").write(t)
PY
    mkdir -p vendor/punycode
    printf '{\n  "name": "punycode",\n  "version": "2.3.1",\n  "main": "punycode.js"\n}\n' > vendor/punycode/package.json
    printf 'module.exports = { toASCII: () => "from the tree under test" };\n' > vendor/punycode/punycode.js
  fi
  sed -i 's#integrity: sha512-RbOBxmLBG8uvFUc15X9#integrity: sha512-AbOBxmLBG8uvFUc15X9#' pnpm-lock.yaml
  git add -A && git -c user.name=adv -c user.email=adv@x commit -qm case
  out=$(./scripts/check-install-scripts.sh 2>&1)
  if ! grep -q 'better-sqlite3@13.0.3: allowlisted package without its pinned registry integrity' <<<"$out"; then
    echo "FAIL: $1: the static stage did not run to the lockfile check: ${out##*$'\n'}"; rc=1
  elif grep -qE '^FAIL .*(punycode|tr46|vendor/)' <<<"$out"; then
    [ "$2" = 1 ] && echo "ok: $1: refused" || { echo "FAIL: $1: refused: $(grep -E '^FAIL .*(punycode|tr46|vendor/)' <<<"$out" | head -1)"; rc=1; }
  else
    [ "$2" = 0 ] && echo "ok: $1: accepted" || { echo "FAIL: $1: accepted (pnpm links tr46's punycode to vendor/punycode in the tree, not the registry by integrity); the guard's only FAIL lines: $(grep '^FAIL' <<<"$out" | paste -sd '|')"; rc=1; }
  fi
  git reset -q --hard HEAD~1
}
case_ 'tr46@5.1.1 packages entry with dependencies punycode: link:vendor/punycode' 1 packages
case_ 'tr46@5.1.1 snapshot with dependencies punycode: link:vendor/punycode (control)' 1 snapshots
case_ 'the committed lockfile' 0
exit $rc
