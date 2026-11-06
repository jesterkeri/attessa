#!/usr/bin/env bash
# Install allow-list adversary r11: the header of scripts/check-install-scripts.sh says "Nothing is
# resolved from the tree under test ... PATH keeps only absolute entries outside the checked
# folder", and its PATH comment says the filter runs "with builtins alone (no command is looked up
# on PATH before this)". The guard's own interpreter is looked up on PATH before the filter: its
# shebang is `#!/usr/bin/env bash`, so env picks the first `bash` on the unfiltered PATH, and a
# tracked bash in the tree runs the whole guard. Two cases, one per entry kind the filter drops:
#   1. a tracked bin/bash with the absolute entry $root/bin on PATH (the r10 premise)
#   2. a tracked bash at the root with an empty PATH entry (the current folder)
# Each fake bash records that it ran, then hands over to the real bash. Each case also breaks the
# better-sqlite3 integrity, so the probe stops at the static stage and runs no pnpm.
# Expected against a guard that keeps the tree out: 2 "ok:" lines and exit 0. Against 42b97df:
# 2 "FAIL:" lines and exit 1.
# Usage: $0 <repo> [commit under test, default HEAD]
set -u
src="${1:?repo}"; rev="${2:-HEAD}"
realbash=$(command -v bash)
R=$(mktemp -d /tmp/attessa-adv-path-r11.XXXX); S=$(mktemp -d /tmp/attessa-adv-path-r11-s.XXXX)
trap 'rm -rf "$R" "$S"' EXIT
git -C "$src" archive "$rev" | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
rc=0
case_() {  # case_ <dir inside the tree> <PATH to run under> <label>
  git reset -q --hard HEAD && git clean -qfdx; rm -f "$S/ran"
  mkdir -p "$1"
  printf '#!/bin/sh\necho "$0 $*" >> %s/ran\nexec %s "$@"\n' "$S" "$realbash" > "$1/bash"; chmod 755 "$1/bash"
  sed -i 's#integrity: sha512-RbOBxmLBG8uvFUc15X9#integrity: sha512-AbOBxmLBG8uvFUc15X9#' pnpm-lock.yaml
  git add -f -A && git -c user.name=adv -c user.email=adv@x commit -qm case
  out=$(PATH="$2" ./scripts/check-install-scripts.sh 2>&1); st=$?
  grep -q '^FAIL pnpm-lock.yaml: better-sqlite3@13.0.3: allowlisted' <<<"$out" \
    || echo "PRECONDITION: $3: static stage did not finish: ${out##*$'\n'}"
  if [ -e "$S/ran" ]; then
    echo "FAIL: $3: the tree's $1/bash ran the guard (guard exit $st), call: $(head -1 "$S/ran")"; rc=1
  else echo "ok: $3: the tree's $1/bash never ran (guard exit $st)"; fi
  git reset -q --hard HEAD~1
}
case_ bin "$R/bin:$PATH" 'PATH entry $root/bin'
case_ . ":$PATH" 'empty PATH entry'
exit $rc
