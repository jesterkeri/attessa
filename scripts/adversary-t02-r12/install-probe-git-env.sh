#!/usr/bin/env bash
# T02 r12: the same redirection as install-probe-core-worktree.sh, through the environment instead of
# .git/config. GIT_WORK_TREE (with GIT_DIR) names a clean copy of HEAD while the directory the probe
# runs in has an untracked .pnpmfile.cjs. The probe checks the folder it is run from, never the one
# git variables name, so it must refuse; it fails the test if it says ok.
set -u
src="$(cd "$(dirname "$0")/../.." && pwd)"
R=$(mktemp -d /tmp/attessa-adv-t02-r12-env.XXXX); C="$R.clean"
trap 'rm -rf "$R" "$C"' EXIT
git -C "$src" archive HEAD | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
mkdir "$C" && git archive HEAD | tar -x -C "$C"
printf 'module.exports = { hooks: {} }\n' > .pnpmfile.cjs
echo "toplevel git reports with the variables: $(GIT_DIR="$R/.git" GIT_WORK_TREE="$C" git rev-parse --show-toplevel)"
out=$(GIT_DIR="$R/.git" GIT_WORK_TREE="$C" "$src/scripts/check-install-scripts.sh" 2>&1); st=$?; echo "$out"
if [ $st -eq 0 ]; then echo "FAIL: probe said ok while $R has an untracked .pnpmfile.cjs"; exit 1; fi
grep -q '^FAIL .pnpmfile.cjs: not allowed in the checkout' <<<"$out" || { echo "FAIL: probe refused, but not for $R/.pnpmfile.cjs"; exit 1; }
echo "ok: probe exit $st"
