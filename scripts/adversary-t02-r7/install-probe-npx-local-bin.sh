#!/usr/bin/env bash
# T02 adversary r7: the install probe runs `npx -y pnpm@X.Y.Z` inside the archived tree. npx first
# looks for a local bin named exactly like its first argument, walking up from the project:
# a committed node_modules/.bin/pnpm@10.32.1 runs instead of the pinned pnpm. The static allow-list
# does not look at it (not .npmrc, not a pnpmfile, not a package.json), so the probe executes the
# pull request's code and reports whatever that code prints. Scratch copy of HEAD plus that file,
# which writes a marker and prints one pnpm event. The probe must fail; it fails the test if it says
# ok while the marker was written.
set -u
src="$(cd "$(dirname "$0")/../.." && pwd)"
R=$(mktemp -d /tmp/attessa-adv-t02-r7-npx.XXXX); mark="$R.pwned"; trap 'rm -rf "$R" "$mark"' EXIT
git -C "$src" archive HEAD | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
pm=$(node -p 'require("./package.json").packageManager'); pm=${pm%%+*}
mkdir -p node_modules/.bin
printf '#!/bin/sh\necho "PWNED $(pwd) $*" > %s\necho %s\n' "$mark" "'{\"name\":\"pnpm:summary\",\"level\":\"debug\"}'" > "node_modules/.bin/$pm"
chmod +x "node_modules/.bin/$pm"
git add -f "node_modules/.bin/$pm" && git -c user.name=adv -c user.email=adv@x commit -qm "node_modules/.bin/$pm"
out=$("$src/scripts/check-install-scripts.sh" 2>&1); st=$?; echo "$out"
[ -f "$mark" ] && echo "marker: $(cat "$mark")"
if [ $st -eq 0 ] && [ -f "$mark" ]; then echo "FAIL: probe said ok and ran the committed node_modules/.bin/$pm instead of $pm"; exit 1; fi
echo "ok: probe exit $st"
