#!/usr/bin/env bash
# Install allow-list adversary r9: the guard's header (scripts/check-install-scripts.sh:6-9) says
# workspace manifests may add "the scripts gen:vectors and render-units, each `node` on a tracked
# file under the package's scripts/" and "engines with a node range only". Each `allowed` case
# below is exactly that, and the guard refuses it. The `refused` cases check DONE.md's adversary
# r6 note ("scripts as a list or string ... are all refused"): the guard accepts them.
# Each case also breaks the better-sqlite3 integrity, so the probe stops at the static stage and
# runs no pnpm. Usage: $0 <repo root at the commit under test> [guard to run, default its own].
set -u
src="${1:?repo root}"; guard="${2:-$src/scripts/check-install-scripts.sh}"
R=$(mktemp -d /tmp/attessa-adv-allowlist-r9.XXXX); trap 'rm -rf "$R"' EXIT
git -C "$src" archive HEAD | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
rc=0
# run <manifest> <python edit of m>; prints the FAIL lines for <manifest>
run() {
  git reset -q --hard HEAD && git clean -qfdx
  python3 -I -c 'import json, os, shutil, sys; m = json.load(open(sys.argv[1])); exec(sys.argv[2]); open(sys.argv[1], "w").write(json.dumps(m, indent=2) + "\n")' "$1" "$2"
  sed -i 's#integrity: sha512-RbOBxmLBG8uvFUc15X9#integrity: sha512-AbOBxmLBG8uvFUc15X9#' pnpm-lock.yaml
  git add -A; git -c user.name=adv -c user.email=adv@x commit -qm case
  out=$("$guard" 2>&1)
  git reset -q --hard HEAD~1
  # The static stage must have run to its end: the integrity line is always there.
  grep -q '^FAIL pnpm-lock.yaml: better-sqlite3@13.0.3: allowlisted' <<<"$out" || echo "PRECONDITION: static stage did not finish: ${out##*$'\n'}"
  grep "^FAIL $1:" <<<"$out"
}
allowed() { got=$(run "$@"); if [ -z "$got" ]; then echo "ok: accepted $2"; else echo "FAIL: refused $2"; echo "  $got"; rc=1; fi; }
refused() { got=$(run "$@"); if [ -n "$got" ] && ! grep -q PRECONDITION <<<"$got"; then echo "ok: refused $2"; else echo "FAIL: accepted $2 ${got}"; rc=1; fi; }
K=packages/core/package.json S=packages/sdk/package.json
G=packages/core/scripts/gen-vectors.ts
# Header 8-9: `node` on a tracked file under the package's scripts/. A sub-folder is still under
# it, as dist/ sub-folders are for bin (guard line 189); the header names no file grammar.
allowed $K 'os.makedirs("packages/core/scripts/vectors"); shutil.copy("'$G'", "packages/core/scripts/vectors/gen.ts"); m["scripts"]["gen:vectors"] = "node scripts/vectors/gen.ts"'
allowed $K 'shutil.copy("'$G'", "packages/core/scripts/gen.vectors.ts"); m["scripts"]["gen:vectors"] = "node scripts/gen.vectors.ts"'
allowed $K 'shutil.copy("'$G'", "packages/core/scripts/gen-vectors.cjs"); m["scripts"]["gen:vectors"] = "node scripts/gen-vectors.cjs"'
# Header 8: engines with a node range (each a valid semver range).
allowed $S 'm["engines"]["node"] = ">22.12.0"'
allowed $S 'm["engines"]["node"] = ">=22.13.0 <25"'
allowed $S 'm["engines"]["node"] = "22.x"'
# DONE.md, adversary r6 note: "scripts as a list or string ... are all refused".
refused $K 'm["scripts"] = ["test"]'
refused $K 'm["scripts"] = ""'
exit $rc
