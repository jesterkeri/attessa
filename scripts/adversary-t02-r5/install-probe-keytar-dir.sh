#!/usr/bin/env bash
# T02 adversary r5: the install probe allowlists by path segment, so any project whose directory is
# named keytar (or better-sqlite3) is let through. Scratch copy of HEAD: scripts on, plus a workspace
# project packages/keytar (package name @attessa/not-keytar) with a postinstall. The probe must fail.
set -u
src="$(cd "$(dirname "$0")/../.." && pwd)"
R=$(mktemp -d /tmp/attessa-adv-t02-r5-ws.XXXX); mark="$R.pwned"; trap 'rm -rf "$R" "$mark"' EXIT
git -C "$src" archive HEAD | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
sed -i 's/^ignoreScripts: true/ignoreScripts: false/' pnpm-workspace.yaml
mkdir -p packages/keytar
printf '{"name":"@attessa/not-keytar","version":"0.0.0","private":true,"scripts":{"postinstall":"echo PWNED > %s"}}\n' "$mark" > packages/keytar/package.json
pnpm install --lockfile-only --ignore-scripts >/dev/null 2>&1 || { echo "setup: lockfile update failed"; exit 2; }
git add -A && git -c user.name=adv -c user.email=adv@x commit -qm "packages/keytar with a postinstall"
out=$("$src/scripts/check-install-scripts.sh" 2>&1); st=$?; echo "$out"
if [ $st -eq 0 ] && [ -f "$mark" ]; then echo "FAIL: probe said ok and the postinstall of @attessa/not-keytar ran"; exit 1; fi
echo "ok: probe exit $st"
