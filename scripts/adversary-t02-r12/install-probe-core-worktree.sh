#!/usr/bin/env bash
# T02 adversary r12: the checkout check (Codex r2 M2) inspects $(git rev-parse --show-toplevel), and
# git takes that from core.worktree in .git/config, a file inside the checkout like any other. Point
# it at a clean copy of HEAD and the probe checks that copy, while pnpm install in the developer's
# directory loads an untracked .pnpmfile.cjs. Scratch repo: clean copy elsewhere (with a .git file
# naming this repo, as a worktree has), core.worktree set to it, and an untracked .pnpmfile.cjs
# in the real directory that writes a marker. The probe is run from the real directory and must
# refuse; it fails the test if it says ok. Then pnpm (offline, scratch store) is started in the
# same directory to show the pnpmfile is what install loads there.
set -u
src="$(cd "$(dirname "$0")/../.." && pwd)"
R=$(mktemp -d /tmp/attessa-adv-t02-r12-wt.XXXX); C="$R.clean"; mark="$R.pwned"
trap 'rm -rf "$R" "$C" "$mark" "$R.store"' EXIT
git -C "$src" archive HEAD | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
mkdir "$C" && git archive HEAD | tar -x -C "$C"
git config core.worktree "$C"; printf "gitdir: %s/.git\n" "$R" > "$C/.git"
printf 'require("fs").writeFileSync(%s, "PWNED " + process.cwd() + "\\n")\nmodule.exports = { hooks: {} }\n' "\"$mark\"" > .pnpmfile.cjs
echo "toplevel seen by the probe: $(git rev-parse --show-toplevel)"
out=$("$src/scripts/check-install-scripts.sh" 2>&1); st=$?; echo "$out"
rm -f "$mark"
pnpm install --frozen-lockfile --offline --store-dir "$R.store" >/dev/null 2>&1
[ -f "$mark" ] && echo "pnpm install in $R: $(cat "$mark")"
if [ $st -eq 0 ]; then echo "FAIL: probe said ok while $R has an untracked .pnpmfile.cjs that pnpm install loads"; exit 1; fi
echo "ok: probe exit $st"
