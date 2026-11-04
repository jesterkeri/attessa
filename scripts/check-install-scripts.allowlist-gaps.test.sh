#!/usr/bin/env bash
# Install allow-list adversary r5: checks in the workspace-manifest allowance that no case of
# scripts/check-install-scripts.allowlist.test.sh exercises. Each case below is something the
# header forbids and the guard at 2eb7a4a refuses; each one is also accepted by a one-line mutant
# of the guard that the allow-list test's 21 cases all pass against (named per case).
# Each case also breaks the better-sqlite3 integrity, so the probe stops at the static stage and
# runs no pnpm. Usage: $0 <repo root at the commit under test> [guard to run, default its own].
set -u
src="${1:?repo root}"; guard="${2:-$src/scripts/check-install-scripts.sh}"
R=$(mktemp -d /tmp/attessa-adv-allowlist-r5.XXXX); trap 'rm -rf "$R"' EXIT
git -C "$src" archive HEAD | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
rc=0
# run <manifest> <python edit of m> [shell command after git add]; prints the FAIL lines for <manifest>
run() {
  git reset -q --hard HEAD && git clean -qfdx
  python3 -I -c 'import json, sys; m = json.load(open(sys.argv[1])); exec(sys.argv[2]); open(sys.argv[1], "w").write(json.dumps(m, indent=2) + "\n")' "$1" "$2"
  sed -i 's#integrity: sha512-RbOBxmLBG8uvFUc15X9#integrity: sha512-AbOBxmLBG8uvFUc15X9#' pnpm-lock.yaml
  git add -A; [ -n "${3:-}" ] && eval "$3"
  git -c user.name=adv -c user.email=adv@x commit -qm case
  out=$("$guard" 2>&1)
  git reset -q --hard HEAD~1
  grep "^FAIL $1:" <<<"$out"
}
refused() { got=$(run "$@"); if [ -n "$got" ]; then echo "ok: refused $2"; else echo "FAIL: accepted $2"; rc=1; fi; }
C=packages/cli/package.json K=packages/core/package.json S=packages/sdk/package.json H=packages/seller-host/package.json
# bin: ".js files under that package's dist/" (mutant m01: the .js suffix made optional)
refused $C 'm["bin"]["attessa"] = "dist/bin.sh"'
refused $C 'm["bin"]["attessa"] = "dist/bin"'
# engines: a node range, at most major.minor.patch (mutant m10: any number of parts)
refused $S 'm["engines"]["node"] = ">=22.13.0.1"'
# scripts: `node` on a file, no other node option (mutant m12: any one option before the file)
refused $K 'm["scripts"]["gen:vectors"] = "node --require=/tmp/x.js scripts/gen-vectors.ts"'
refused $K 'm["scripts"]["gen:vectors"] = "node /tmp/x.js scripts/gen-vectors.ts"'
# scripts: a file under scripts/, not elsewhere in the package (mutant m13: any folder)
refused $K 'm["scripts"]["gen:vectors"] = "node src/binding.ts"'
# scripts: a .ts, .js or .mjs file (mutant m14: any extension)
refused $K 'm["scripts"]["gen:vectors"] = "node scripts/gen.sh"; open("packages/core/scripts/gen.sh", "w").write("")'
# scripts: a file of that package, not another package's (mutant m15: any package's scripts/)
refused $H 'm["scripts"]["render-units"] = "node scripts/gen-vectors.ts"'
# scripts: a tracked 100644 or 100755 file, not a gitlink (mutant m16: any tracked mode)
refused $K 'm["scripts"]["gen:vectors"] = "node scripts/sub.ts"' \
  'git update-index --add --cacheinfo 160000,$(git rev-parse HEAD),packages/core/scripts/sub.ts'
# dependency specs: ASCII digits only, as 4ea81d9 made them (mutant m23: Python's Unicode \d back)
refused $K 'm["dependencies"]["tr46"] = "５.1.1"'
exit $rc
