#!/usr/bin/env bash
# The static allow-list accepts the workspace manifests' bin, engines and the gen:vectors and
# render-units scripts, and better-sqlite3@13.0.3 at its pinned integrity, and nothing next to them.
# Scratch copy of HEAD; each case changes one thing, and the probe must report exactly that one
# FAIL line. A case that also printed any of HEAD's own manifests or the lockfile would mean HEAD
# itself is refused, so every case also proves HEAD passes the static stage. Every case fails
# before the install except the executable-file case, which runs the full probe once (take the heavy lock).
set -u
src="$(cd "$(dirname "$0")/.." && pwd)"
R=$(mktemp -d /tmp/attessa-install-allowlist.XXXX); trap 'rm -rf "$R"' EXIT
git -C "$src" archive HEAD | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=t -c user.email=t@x commit -qm base
# set <file> <python expression on m> : edit one manifest as JSON.
set_json() { python3 -I - "$1" "$2" <<'PY'
import json, sys
m = json.load(open(sys.argv[1])); exec(sys.argv[2]); open(sys.argv[1], "w").write(json.dumps(m, indent=2) + "\n")
PY
}
rc=0; n=0
# check <name> <expected FAIL line> <command that makes the change>
check() {
  name=$1 want=$2; shift 2
  git reset -q --hard HEAD && git clean -qfdx
  "$@" && git -c user.name=t -c user.email=t@x commit -qam "$name"
  out=$("$src/scripts/check-install-scripts.sh" 2>&1); st=$?
  got=$(grep '^FAIL [^:]*:' <<<"$out")
  n=$((n + 1))
  if [ $st -ne 0 ] && [ "$got" = "$want" ]; then echo "ok: $name"
  else echo "FAIL: $name (probe exit $st)"; echo "  want: $want"; echo "  got:  ${got//$'\n'/$'\n'        }"; rc=1; fi
  git reset -q --hard HEAD~1
}
C=packages/cli/package.json
check "bin outside dist/" "FAIL $C: bin must map command names to .js files under dist/, got {'attessa': 'src/bin.js', 'attest': 'dist/bin.js'}" \
  set_json $C 'm["bin"]["attessa"] = "src/bin.js"'
check "bin with .. out of dist/" "FAIL $C: bin must map command names to .js files under dist/, got {'attessa': 'dist/../../../evil.js', 'attest': 'dist/bin.js'}" \
  set_json $C 'm["bin"]["attessa"] = "dist/../../../evil.js"'
check "bin absolute" "FAIL $C: bin must map command names to .js files under dist/, got {'attessa': '/tmp/dist/bin.js', 'attest': 'dist/bin.js'}" \
  set_json $C 'm["bin"]["attessa"] = "/tmp/dist/bin.js"'
check "bin as a string" "FAIL $C: bin must map command names to .js files under dist/, got 'dist/bin.js'" \
  set_json $C 'm["bin"] = "dist/bin.js"'
check "bin command name with a path" "FAIL $C: bin must map command names to .js files under dist/, got {'attessa': 'dist/bin.js', 'attest': 'dist/bin.js', '../x': 'dist/bin.js'}" \
  set_json $C 'm["bin"]["../x"] = "dist/bin.js"'
for b in node tsc sh; do
  check "bin shadowing $b" "FAIL $C: bin must map command names to .js files under dist/, got {'attessa': 'dist/bin.js', 'attest': 'dist/bin.js', '$b': 'dist/bin.js'}" \
    set_json $C "m['bin']['$b'] = 'dist/bin.js'"
done
S=packages/sdk/package.json
check "engines beyond node" "FAIL $S: engines must be a node range only, got {'node': '>=22.13.0', 'pnpm': '9'}" \
  set_json $S 'm["engines"]["pnpm"] = "9"'
check "engines node not a range" "FAIL $S: engines must be a node range only, got {'node': '>=22 || file:x'}" \
  set_json $S 'm["engines"]["node"] = ">=22 || file:x"'
# Python's \d also matches non-ASCII digits; pnpm's semver does not.
check "engines node with fullwidth digits" "FAIL $S: engines must be a node range only, got {'node': '>=２２'}" \
  set_json $S 'm["engines"]["node"] = ">=２２"'
G=packages/gateway/package.json
check "extra unknown key" "FAIL $G: keys not allowed: ['pnpm']" \
  set_json $G 'm["pnpm"] = {"overrides": {"typescript": "5.9.3"}}'
K=packages/core/package.json
for s in preinstall install postinstall prepare; do
  check "$s script" "FAIL $K: scripts not allowed: ['$s']" set_json $K "m['scripts']['$s'] = 'node scripts/gen-vectors.ts'"
done
check "gen:vectors running more than node" "FAIL $K: scripts not allowed: ['gen:vectors']" \
  set_json $K 'm["scripts"]["gen:vectors"] = "node scripts/gen-vectors.ts && curl http://127.0.0.1:9"'
check "gen:vectors in the root manifest" "FAIL package.json: keys not allowed: ['scripts']
FAIL package.json: scripts not allowed: ['gen:vectors']" \
  set_json package.json 'm["scripts"] = {"gen:vectors": "node scripts/gen-vectors.ts"}'
H=packages/seller-host/package.json
check "render-units on an untracked file" "FAIL $H: script render-units must run a tracked regular file of its package, not packages/seller-host/scripts/missing.ts" \
  set_json $H 'm["scripts"]["render-units"] = "node --experimental-strip-types scripts/missing.ts"'
# An executable (100755) script file is still a tracked regular file; node runs it either way.
n=$((n + 1)); git reset -q --hard HEAD && git clean -qfdx
chmod +x packages/core/scripts/gen-vectors.ts && git -c user.name=t -c user.email=t@x commit -qam "executable gen-vectors"
# Accepted means the whole probe passed: exit 0 and its ok line, not merely no "FAIL path:" line.
out=$("$src/scripts/check-install-scripts.sh" 2>&1); st=$?
if [ $st -eq 0 ] && grep -q 'install ran no non-allowlisted install script: ok' <<<"$out"; then echo "ok: gen:vectors on a tracked executable file accepted"
else echo "FAIL: gen:vectors on a tracked executable file refused (probe exit $st)"; echo "${out##*$'\n'}"; rc=1; fi
git reset -q --hard HEAD~1
check "wrong better-sqlite3 integrity" "FAIL pnpm-lock.yaml: better-sqlite3@13.0.3: allowlisted package without its pinned registry integrity" \
  sed -i 's#integrity: sha512-RbOBxmLBG8uvFUc15X9#integrity: sha512-AbOBxmLBG8uvFUc15X9#' pnpm-lock.yaml
echo "$n cases, rc=$rc"
exit $rc
