#!/usr/bin/env bash
# T02 adversary r6: the install probe fails a root postinstall, but the same install-time code in a
# root .pnpmfile.cjs runs on every pnpm install (ignoreScripts does not stop it) and emits no
# pnpm:lifecycle event. Scratch copy of HEAD plus a .pnpmfile.cjs that writes a marker. The probe
# must fail; it fails the test if it says ok while the marker was written.
set -u
src="$(cd "$(dirname "$0")/../.." && pwd)"
R=$(mktemp -d /tmp/attessa-adv-t02-r6-pf.XXXX); mark="$R.pwned"; trap 'rm -rf "$R" "$mark"' EXIT
git -C "$src" archive HEAD | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
printf 'require("fs").writeFileSync(%s, "PWNED " + process.cwd() + "\\n")\nmodule.exports = { hooks: {} }\n' "\"$mark\"" > .pnpmfile.cjs
pnpm install --lockfile-only >/dev/null 2>&1 || { echo "setup: lockfile update failed"; exit 2; }
rm -f "$mark"
git add -A && git -c user.name=adv -c user.email=adv@x commit -qm ".pnpmfile.cjs"
out=$("$src/scripts/check-install-scripts.sh" 2>&1); st=$?; echo "$out"
[ -f "$mark" ] && echo "marker: $(cat "$mark")"
if [ $st -eq 0 ] && [ -f "$mark" ]; then echo "FAIL: probe said ok and .pnpmfile.cjs ran code at install"; exit 1; fi
echo "ok: probe exit $st"
