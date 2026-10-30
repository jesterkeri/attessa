#!/usr/bin/env bash
# T02 r7: the install probe pointed pnpm's user config at XDG_CONFIG_HOME=<archive>/.cfg, so a
# committed .cfg/pnpm/rc is read as the global rc. Its global-pnpmfile resolves against the
# workspace root, so a committed hook.js (not named like a pnpmfile) runs at install without any
# lifecycle event. Scratch copy of HEAD plus those two files. The probe must not run hook.js.
set -u
src="$(cd "$(dirname "$0")/../.." && pwd)"
R=$(mktemp -d /tmp/attessa-adv-t02-r7-xdg.XXXX); mark="$R.pwned"; trap 'rm -rf "$R" "$mark"' EXIT
git -C "$src" archive HEAD | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
mkdir -p .cfg/pnpm
printf 'global-pnpmfile=hook.js\n' > .cfg/pnpm/rc
printf 'require("fs").writeFileSync(%s, "PWNED " + process.cwd());\nmodule.exports = { hooks: {} };\n' "'$mark'" > hook.js
git add -f .cfg/pnpm/rc hook.js && git -c user.name=adv -c user.email=adv@x commit -qm "global rc"
out=$("$src/scripts/check-install-scripts.sh" 2>&1); st=$?; echo "$out"
[ -f "$mark" ] && echo "marker: $(cat "$mark")"
if [ -f "$mark" ]; then echo "FAIL: probe ran the committed hook.js through a committed .cfg/pnpm/rc (probe exit $st)"; exit 1; fi
echo "ok: probe exit $st"
