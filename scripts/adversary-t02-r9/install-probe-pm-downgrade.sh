#!/usr/bin/env bash
# T02 adversary r9: the probe accepts any packageManager pnpm@X.Y.Z and never checks engines, so a
# PR can pin pnpm 9, which does not read ignoreScripts from pnpm-workspace.yaml (pnpm 10 then switches
# to the pinned version too). pnpm-lock.yaml is not checked, so keytar@7.9.0 can resolve to a
# tracked local tarball whose install script is the PR's code; it runs in the virtual store
# directory the probe allowlists as keytar. Scratch copy of HEAD with those changes; the tarball's
# install script writes a marker. The probe must fail; it fails the test if it says ok while the
# marker was written.
set -u
src="$(cd "$(dirname "$0")/../.." && pwd)"
R=$(mktemp -d /tmp/attessa-adv-t02-r9-pm.XXXX); mark="$R.pwned"; trap 'rm -rf "$R" "$mark"' EXIT
git -C "$src" archive HEAD | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
mkdir -p vendor/t/package
printf '{"name":"keytar","version":"7.9.0","scripts":{"install":"echo PWNED $PWD > %s"}}\n' "$mark" > vendor/t/package/package.json
tar -czf vendor/keytar-7.9.0.tgz -C vendor/t package && rm -rf vendor/t
sri="sha512-$(openssl dgst -sha512 -binary vendor/keytar-7.9.0.tgz | base64 -w0)"
node -e '
const fs = require("fs"); const m = JSON.parse(fs.readFileSync("package.json"));
m.packageManager = "pnpm@9.15.9"; m.engines.pnpm = ">=9.15.9"; m.devDependencies.keytar = "7.9.0";
fs.writeFileSync("package.json", JSON.stringify(m, null, 2) + "\n");'
python3 -I - "$sri" <<'P'
import sys
s = open("pnpm-lock.yaml").read()
s = s.replace("      typescript:\n        specifier: ^5.6.0", "      keytar:\n        specifier: 7.9.0\n        version: 7.9.0\n      typescript:\n        specifier: ^5.6.0", 1)
s = s.replace("packages:\n\n", "packages:\n\n  keytar@7.9.0:\n    resolution: {integrity: %s, tarball: file:vendor/keytar-7.9.0.tgz}\n\n" % sys.argv[1], 1)
s = s.replace("snapshots:\n\n", "snapshots:\n\n  keytar@7.9.0: {}\n\n", 1)
open("pnpm-lock.yaml", "w").write(s)
P
git add -A && git -c user.name=adv -c user.email=adv@x commit -qm "pnpm 9, keytar from a tracked tarball"
out=$("$src/scripts/check-install-scripts.sh" 2>&1); st=$?; echo "$out"
[ -f "$mark" ] && echo "marker: $(cat "$mark")"
if [ $st -eq 0 ] && [ -f "$mark" ]; then echo "FAIL: probe said ok and the tracked tarball's install script ran as keytar"; exit 1; fi
echo "ok: probe exit $st"
