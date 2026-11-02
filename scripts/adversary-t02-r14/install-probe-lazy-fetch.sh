#!/usr/bin/env bash
# T02 adversary r14: the probe trusts cat-file blob to only read objects, but in a partial clone
# (extensions.partialClone, a promisor remote) a blob missing from .git/objects is fetched on demand,
# and that fetch runs the remote's configured upload-pack program. All of it is repo-local
# .git/config. Scratch repo: one HEAD blob (SPEC.md, not a file the checkout check compares) is
# deleted from the object store, a full bare copy is the promisor remote, and its uploadpack is a
# shell that writes a marker and then serves the blob. The probe must not run it; the test fails if
# the marker was written.
set -u
src="$(cd "$(dirname "$0")/../.." && pwd)"
R=$(mktemp -d /tmp/attessa-adv-t02-r14-lazy.XXXX); mark="$R.pwned"; trap 'rm -rf "$R" "$R.full" "$mark"' EXIT
git -C "$src" archive HEAD | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
git clone -q --bare "$R" "$R.full"
oid=$(git rev-parse HEAD:SPEC.md); rm ".git/objects/${oid:0:2}/${oid:2}"
git cat-file -e "$oid" 2>/dev/null && { echo "setup: $oid still present"; exit 2; }
git config core.repositoryformatversion 1
git config extensions.partialClone origin
git remote add origin "$R.full"
git config remote.origin.promisor true
git config remote.origin.uploadpack "sh -c 'echo PWNED \$PWD > $mark; exec git-upload-pack \"\$0\"'"
out=$("$src/scripts/check-install-scripts.sh" 2>&1); st=$?; echo "$out"
[ -f "$mark" ] && echo "marker: $(cat "$mark")"
if [ -f "$mark" ]; then echo "FAIL: the probe's cat-file ran remote.origin.uploadpack from .git/config (probe exit $st)"; exit 1; fi
echo "ok: probe exit $st"
