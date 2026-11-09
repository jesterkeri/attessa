#!/usr/bin/env bash
# The credential scan must find a planted credential, and must refuse to pass when it scanned nothing.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
scan="$here/check-secrets.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fails=0
want() { # name, expected exit, args...
  local name="$1" exp="$2"; shift 2
  ( cd "$tmp" && "$scan" "$@" >/dev/null 2>&1 ); local got=$?
  if [ "$got" -eq "$exp" ]; then echo "ok $name"; else echo "not ok $name: exit $got, wanted $exp"; fails=$((fails + 1)); fi
}
mkdir -p "$tmp/clean" "$tmp/dirty" "$tmp/empty" "$tmp/second"
echo "nothing here" > "$tmp/clean/a.js"
echo "nothing here" > "$tmp/second/a.js"
# Built at run time, so this file itself isn't credential-shaped.
printf 'const k = "%s%s";\n' 'sk_live_' 'abc123' > "$tmp/dirty/a.js"
want 'a clean directory passes' 0 clean
want 'a planted credential fails' 1 dirty
want 'a missing named directory fails' 2 missing
want 'an empty named directory fails' 2 empty
want 'one missing among several fails' 2 clean missing
want 'a credential in the second directory fails' 1 second dirty
want 'no arguments and no usual output fails' 2
mkdir -p "$tmp/dist"; echo "nothing here" > "$tmp/dist/a.js"
want 'no arguments finds dist' 0
[ "$fails" -eq 0 ] && echo "check-secrets: all passed"
exit "$fails"
