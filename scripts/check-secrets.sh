#!/usr/bin/env bash
# Fails if anything that looks like a live credential reached the client bundle.
# The Supabase anon key is expected here and is not a finding; RLS is what protects it.
set -uo pipefail
# Fails closed: a named directory that is missing or empty means nothing was scanned, and that is not a pass.
# With no arguments it looks for the usual outputs, and at least one of them must exist.
PATTERN='service_role|sk_live_|sk_test_|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJhbGciOi[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*'
scanned=0
found=0
if [ "$#" -gt 0 ]; then DIRS=("$@"); REQUIRE_EACH=1; else DIRS=(.next dist build out); REQUIRE_EACH=0; fi
for d in "${DIRS[@]}"; do
  # A name starting with a dash must never reach find or grep as an option (`-L` scanned the wrong place and passed).
  # An empty name is a missing directory, not the current one.
  case "$d" in /*) ;; "") ;; *) d="./$d" ;; esac
  if [ ! -d "$d" ] || [ -z "$(find "$d" -type f -print -quit 2>/dev/null)" ]; then
    if [ "$REQUIRE_EACH" -eq 1 ]; then echo "FAIL $d is missing or empty: nothing was scanned"; exit 2; fi
    continue
  fi
  scanned=$((scanned + 1))
  # -a and the C locale: a binary asset ships to the browser too, and a credential inside it still counts.
  # -R, not -r: a symlink in the output can ship its target, so it is read. A dangling one is a read failure, not a pass.
  hits=$(LC_ALL=C grep -RlaE -e "$PATTERN" -- "$d"); rc=$?
  if [ "$rc" -gt 1 ]; then echo "FAIL could not read $d (grep exit $rc)"; exit 2; fi
  if [ -n "$hits" ]; then
    while IFS= read -r hit; do echo "FAIL $hit"; done <<<"$(head -20 <<<"$hits")"
    found=1
  fi
done
if [ "$scanned" -eq 0 ]; then echo "FAIL none of ${DIRS[*]} exists: nothing was scanned"; exit 2; fi
if [ "$found" -eq 1 ]; then
  echo ""
  echo "Credential-shaped strings found in a build output that ships to the browser."
  echo "Anything behind NEXT_PUBLIC_ or VITE_ is public regardless of its name."
  echo "A Supabase anon key here is expected; a service_role key is an incident."
  exit 1
fi
echo "no credential-shaped strings in client output"
