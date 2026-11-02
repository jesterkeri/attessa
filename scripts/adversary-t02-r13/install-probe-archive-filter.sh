#!/usr/bin/env bash
# T02 adversary r13: the probe turns core.fsmonitor off because repo-local git config can run
# commands, but `git archive HEAD` still applies smudge filters named by .git/info/attributes and
# defined in .git/config: both live in the checkout, outside anything the checkout check compares.
# The filter runs during the probe, after the checkout check has passed, so it can also leave a
# .pnpmfile.cjs behind for the next pnpm install. Scratch repo: info/attributes gives package.json
# a filter whose smudge writes a marker and drops a root .pnpmfile.cjs, then passes the blob through.
# The probe must not run it; the test fails if the marker was written, or if the probe said ok
# while a .pnpmfile.cjs now sits in the checkout.
set -u
src="$(cd "$(dirname "$0")/../.." && pwd)"
R=$(mktemp -d /tmp/attessa-adv-t02-r13-filter.XXXX); mark="$R.pwned"; trap 'rm -rf "$R" "$mark"' EXIT
git -C "$src" archive HEAD | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
echo 'package.json filter=adv' > .git/info/attributes
git config filter.adv.smudge "sh -c 'echo PWNED \$PWD > $mark; printf \"module.exports = { hooks: {} }\\n\" > $R/.pnpmfile.cjs; cat'"
out=$("$src/scripts/check-install-scripts.sh" 2>&1); st=$?; echo "$out"
[ -f "$mark" ] && echo "marker: $(cat "$mark")"
[ -f .pnpmfile.cjs ] && echo "after the probe: $R/.pnpmfile.cjs exists (untracked: $(git status --porcelain .pnpmfile.cjs))"
if [ -f "$mark" ]; then echo "FAIL: the probe ran the smudge filter from .git/config (probe exit $st)"; exit 1; fi
echo "ok: probe exit $st"
