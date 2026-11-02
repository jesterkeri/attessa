#!/usr/bin/env bash
# T02 Codex r2 M2: the install probe proves HEAD, but pnpm install reads the checkout. Three cases,
# each in its own scratch copy of HEAD: an untracked root .pnpmfile.cjs (runs hooks despite
# ignoreScripts), a gitignored root .npmrc, and a modified package.json. The probe must refuse
# each one by path before claiming a result. The .npmrc is only ever written here, never read.
set -u
src="$(cd "$(dirname "$0")/../.." && pwd)"
rc=0
case_run() {  # name, expected path in the FAIL line, shell snippet that dirties the copy
  local R mark out st
  R=$(mktemp -d /tmp/attessa-adv-t02-codex-r2.XXXX); mark="$R.pwned"
  git -C "$src" archive HEAD | tar -x -C "$R"
  ( cd "$R" && git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base && eval "$3" ) \
    || { echo "FAIL $1: could not set up the case"; rc=1; rm -rf "$R" "$mark"; return; }
  out=$(cd "$R" && "$src/scripts/check-install-scripts.sh" 2>&1); st=$?
  if [ $st -eq 0 ] || ! grep -q "^FAIL $2:" <<<"$out"; then
    echo "$out" | tail -3; echo "FAIL $1: probe did not refuse the checkout's $2 (probe exit $st)"; rc=1
  else echo "ok   $1: $(grep -m1 "^FAIL $2:" <<<"$out")"; fi
  rm -rf "$R" "$mark"
}
case_run untracked-pnpmfile .pnpmfile.cjs \
  'printf "require(\"fs\").writeFileSync(\"%s\", \"PWNED\");\nmodule.exports = { hooks: {} };\n" "$mark" > .pnpmfile.cjs; [ -z "$(git ls-files .pnpmfile.cjs)" ]'
case_run ignored-npmrc .npmrc \
  'printf "ignore-scripts=false\n" > .npmrc; git check-ignore -q .npmrc'
case_run modified-package-json package.json \
  'python3 -I -c "import json; m = json.load(open(\"package.json\")); m[\"devDependencies\"][\"left-pad\"] = \"1.3.0\"; open(\"package.json\", \"w\").write(json.dumps(m, indent=2) + \"\n\")"; ! git diff --quiet -- package.json'
exit $rc
