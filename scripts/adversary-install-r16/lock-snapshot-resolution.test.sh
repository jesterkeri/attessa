#!/usr/bin/env bash
# Install allow-list adversary r16 lead: a pnpm-lock.yaml snapshot with no matching `packages` entry
# keeps its own `resolution`. pnpm 10.32.1's convertToLockfileObject builds each package as
# Object.assign(snapshot, packages[removeSuffix(key)]), so when packages has no such key the snapshot's
# resolution stands, and pnpm installs it. The guard checks resolution only under `packages` and, under
# `snapshots`, only the dependencies and optionalDependencies values, so a snapshot
# `keytar@7.9.0: {resolution: {directory: vendor/keytar, type: directory}}` passes, and pnpm installs
# keytar from a folder of the tree under test, with no integrity, into
# node_modules/.pnpm/keytar@7.9.0/node_modules/keytar: the very path the lifecycle check accepts as a
# registry copy of keytar. Only ignoreScripts: true then stops its install script.
# Cases: the snapshot-only keytar from vendor/keytar (must be refused with a FAIL line naming keytar) and
# the committed lockfile (must not be). Each case breaks the better-sqlite3 integrity so the probe never
# reaches pnpm or the network.
# With PNPM_CJS set to a pnpm 10.32.1 bin/pnpm.cjs, it also shows pnpm's reading offline: a scratch
# project with the same lockfile shape installs keytar from its own vendor/keytar under --frozen-lockfile.
# Expected: 2 "ok:" lines (3 with PNPM_CJS) and exit 0.
# Usage: $0 <repo> [commit under test, default HEAD]
set -u
src="${1:?repo}"; rev="${2:-HEAD}"
R=$(mktemp -d "${TMPDIR:-/tmp}/attessa-adv-lock-r16.XXXX"); trap 'rm -rf "$R"' EXIT
snap=$'\nsnapshots:\n\n  keytar@7.9.0:\n    resolution: {directory: vendor/keytar, type: directory}\n'
rc=0
if [ -n "${PNPM_CJS:-}" ]; then
  P="$R/pnpm-probe"; mkdir -p "$P/vendor/keytar"
  printf '{"name":"probe","private":true,"dependencies":{"keytar":"7.9.0"}}\n' > "$P/package.json"
  printf 'packages:\n  - packages/*\nignoreScripts: true\n' > "$P/pnpm-workspace.yaml"
  printf '{"name":"keytar","version":"7.9.0"}\n' > "$P/vendor/keytar/package.json"
  printf 'module.exports = "from the tree under test";\n' > "$P/vendor/keytar/index.js"
  printf "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    dependencies:\n      keytar:\n        specifier: 7.9.0\n        version: 7.9.0\n%s" "$snap" > "$P/pnpm-lock.yaml"
  (cd "$P" && npm_config_userconfig=/dev/null XDG_CONFIG_HOME="$P/cfg" node "$PNPM_CJS" install --frozen-lockfile --offline --store-dir "$P/store" --no-side-effects-cache >/dev/null 2>&1)
  got=$(cat "$P/node_modules/.pnpm/keytar@7.9.0/node_modules/keytar/index.js" 2>/dev/null)
  [ "$got" = 'module.exports = "from the tree under test";' ] \
    && echo "ok: pnpm $(node "$PNPM_CJS" --version) installs the snapshot-only keytar@7.9.0 from vendor/keytar in the tree" \
    || { echo "FAIL: pnpm did not install keytar from vendor/keytar, so it ignores a snapshot's own resolution"; rc=1; }
fi
mkdir "$R/repo"; git -C "$src" archive "$rev" | tar -x -C "$R/repo"; cd "$R/repo"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
case_() {  # case_ <label> <expect refused: 1|0> [attack: 1]
  git reset -q --hard HEAD && git clean -qfdx
  if [ "${3:-0}" = 1 ]; then
    # The root takes keytar 7.9.0 (a registry version spec), the importer resolves it to 7.9.0 (no colon),
    # and only a snapshot, with no packages entry, says where 7.9.0 comes from.
    python3 -I - <<'PY'
import json, re
m = json.load(open("package.json")); m["devDependencies"]["keytar"] = "7.9.0"
open("package.json", "w").write(json.dumps(m, indent=2) + "\n")
t = open("pnpm-lock.yaml").read()
t, n = re.subn(r"(\n  \.:\n    devDependencies:\n)", r"\1      keytar:\n        specifier: 7.9.0\n        version: 7.9.0\n", t, count=1)
assert n == 1, "root importer devDependencies not found"
assert "keytar@" not in t, "the committed lockfile already names keytar"
open("pnpm-lock.yaml", "w").write(t)
PY
    t=$(cat pnpm-lock.yaml); printf '%s\n%s' "$t" "$snap" > pnpm-lock.yaml
    mkdir -p vendor/keytar
    printf '{\n  "name": "keytar",\n  "version": "7.9.0"\n}\n' > vendor/keytar/package.json
    printf 'module.exports = "from the tree under test";\n' > vendor/keytar/index.js
  fi
  sed -i 's#integrity: sha512-RbOBxmLBG8uvFUc15X9#integrity: sha512-AbOBxmLBG8uvFUc15X9#' pnpm-lock.yaml
  git add -A && git -c user.name=adv -c user.email=adv@x commit -qm case
  out=$(./scripts/check-install-scripts.sh 2>&1)
  if ! grep -q 'better-sqlite3@13.0.3: allowlisted package without its pinned registry integrity' <<<"$out"; then
    echo "FAIL: $1: the static stage did not run to the lockfile check: ${out##*$'\n'}"; rc=1
  elif grep -qE '^FAIL .*(keytar|vendor/)' <<<"$out"; then
    [ "$2" = 1 ] && echo "ok: $1: refused" || { echo "FAIL: $1: refused: $(grep -E '^FAIL .*(keytar|vendor/)' <<<"$out" | head -1)"; rc=1; }
  else
    [ "$2" = 0 ] && echo "ok: $1: accepted" || { echo "FAIL: $1: accepted (pnpm installs keytar@7.9.0 from vendor/keytar, not the registry by integrity); the guard's only FAIL lines: $(grep '^FAIL' <<<"$out" | paste -sd '|')"; rc=1; }
  fi
  git reset -q --hard HEAD~1
}
case_ 'snapshot-only keytar@7.9.0 resolved from vendor/keytar' 1 1
case_ 'the committed lockfile' 0
exit $rc
