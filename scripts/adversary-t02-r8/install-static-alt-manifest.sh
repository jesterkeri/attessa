#!/usr/bin/env bash
# T02 r8: pnpm 10.32.1 reads package.yaml and package.json5 as project manifests (MANIFEST_BASE_NAMES),
# but the static allow-list only parsed package.json, so a workspace project with a package.yaml
# escaped every manifest rule. Corepack (CI's and AGENTS.md's pnpm) reads .corepack.env from the
# project, which can point it at another registry. Scratch copy of HEAD plus each file in turn.
# The probe must name the file and fail.
set -u
src="$(cd "$(dirname "$0")/../.." && pwd)"
R=$(mktemp -d /tmp/attessa-adv-t02-r8-alt.XXXX); trap 'rm -rf "$R"' EXIT
git -C "$src" archive HEAD | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
rc=0
for f in packages/evil/package.yaml packages/evil5/package.json5 .corepack.env; do
  git reset -q --hard HEAD && git clean -qfdx
  mkdir -p "$(dirname "$f")"
  case $f in
    *.yaml) printf 'name: evil\ndependencies:\n  x: "file:../../x"\n' > "$f" ;;
    *.json5) printf '{name: "evil5", dependencies: {x: "file:../../x"}}\n' > "$f" ;;
    *) printf 'COREPACK_NPM_REGISTRY=http://127.0.0.1:9\n' > "$f" ;;
  esac
  git add -f "$f" && git -c user.name=adv -c user.email=adv@x commit -qm "$f"
  out=$("$src/scripts/check-install-scripts.sh" 2>&1); st=$?
  if [ $st -eq 0 ] || ! grep -q "^FAIL $f:" <<<"$out"; then
    echo "$out" | tail -3; echo "FAIL: static allow-list did not refuse $f (probe exit $st)"; rc=1
  else echo "ok: $f refused"; fi
  git reset -q --hard HEAD~1
done
exit $rc
