#!/usr/bin/env bash
# T02 r14: the same partial-clone setup as install-probe-lazy-fetch.sh, with a missing tree
# (HEAD:packages) instead of a blob. ls-tree, which every later step of the probe uses, fetches a
# missing tree on demand too, running the promisor remote's uploadpack. A control copy shows that
# plain `git ls-tree -r HEAD` does fetch it; the probe must refuse the repository before any tree
# listing, so its marker is never written.
set -u
src="$(cd "$(dirname "$0")/../.." && pwd)"
R=$(mktemp -d /tmp/attessa-adv-t02-r14-tree.XXXX); mark="$R.pwned"; cmark="$R.control"
trap 'rm -rf "$R" "$R.full" "$R.ctl" "$mark" "$cmark"' EXIT
git -C "$src" archive HEAD | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
git clone -q --bare "$R" "$R.full"
oid=$(git rev-parse HEAD:packages); rm ".git/objects/${oid:0:2}/${oid:2}"
git cat-file -e "$oid" 2>/dev/null && { echo "setup: tree $oid still present"; exit 2; }
git config core.repositoryformatversion 1
git config extensions.partialClone origin
git remote add origin "$R.full"
git config remote.origin.promisor true
cp -a "$R" "$R.ctl"
git -C "$R.ctl" config remote.origin.uploadpack "sh -c 'echo FETCHED > $cmark; exec git-upload-pack \"\$0\"'"
git config remote.origin.uploadpack "sh -c 'echo PWNED \$PWD > $mark; exec git-upload-pack \"\$0\"'"
git -C "$R.ctl" ls-tree -r HEAD >/dev/null 2>&1
if [ -f "$cmark" ]; then echo "control: git ls-tree -r HEAD fetched the missing tree through uploadpack"
else echo "FAIL: control: ls-tree did not fetch the missing tree, so this case proves nothing"; exit 1; fi
out=$("$src/scripts/check-install-scripts.sh" 2>&1); st=$?; echo "$out"
[ -f "$mark" ] && echo "marker: $(cat "$mark")"
if [ -f "$mark" ]; then echo "FAIL: the probe ran remote.origin.uploadpack from .git/config (probe exit $st)"; exit 1; fi
if [ $st -eq 0 ]; then echo "FAIL: the probe said ok for a repository that can fetch objects on demand"; exit 1; fi
echo "ok: probe exit $st"
