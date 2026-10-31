#!/usr/bin/env bash
# T02 r7: git ls-tree quotes non-ASCII paths ("docs/caf\303\251/package.json"), so the static
# allow-list saw a basename of package.json" and skipped the file. Scratch copy of HEAD plus a
# package.json with a key outside the allow-list under a non-ASCII directory. The probe must
# name that file and fail.
set -u
src="$(cd "$(dirname "$0")/../.." && pwd)"
R=$(mktemp -d /tmp/attessa-adv-t02-r7-nonascii.XXXX); trap 'rm -rf "$R"' EXIT
git -C "$src" archive HEAD | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
d=$(printf 'docs/caf\303\251'); mkdir -p "$d"
printf '{"name":"x","pnpm":{"overrides":{"typescript":"5.9.3"}}}\n' > "$d/package.json"
git add -f "$d/package.json" && git -c user.name=adv -c user.email=adv@x commit -qm nonascii
out=$("$src/scripts/check-install-scripts.sh" 2>&1); st=$?; echo "$out"
if [ $st -eq 0 ] || ! grep -q "FAIL $d/package.json: keys not allowed" <<<"$out"; then
  echo "FAIL: static allow-list skipped $d/package.json (probe exit $st)"; exit 1
fi
echo "ok: probe exit $st"
