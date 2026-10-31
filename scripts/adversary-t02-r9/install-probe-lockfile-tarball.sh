#!/usr/bin/env bash
# T02 r9 control: the r9 attack without the pnpm downgrade. packageManager stays pnpm@10.32.1 and
# only pnpm-lock.yaml points keytar@7.9.0 at a tracked tarball whose install script writes a marker.
# Prints whether the script ran (on 10.32.1, ignoreScripts decides that), and fails unless the probe
# refuses the lockfile entry by name: a resolution other than the default registry is never accepted.
set -u
src="$(cd "$(dirname "$0")/../.." && pwd)"
R=$(mktemp -d /tmp/attessa-adv-t02-r9-lock.XXXX); mark="$R.pwned"; trap 'rm -rf "$R" "$mark"' EXIT
git -C "$src" archive HEAD | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
mkdir -p vendor/t/package
printf '{"name":"keytar","version":"7.9.0","scripts":{"install":"echo PWNED $PWD > %s"}}\n' "$mark" > vendor/t/package/package.json
tar -czf vendor/keytar-7.9.0.tgz -C vendor/t package && rm -rf vendor/t
sri="sha512-$(openssl dgst -sha512 -binary vendor/keytar-7.9.0.tgz | base64 -w0)"
node -e '
const fs = require("fs"); const m = JSON.parse(fs.readFileSync("package.json"));
m.devDependencies.keytar = "7.9.0";
fs.writeFileSync("package.json", JSON.stringify(m, null, 2) + "\n");'
python3 -I - "$sri" <<'P'
import sys
s = open("pnpm-lock.yaml").read()
s = s.replace("      typescript:\n        specifier: ^5.6.0", "      keytar:\n        specifier: 7.9.0\n        version: 7.9.0\n      typescript:\n        specifier: ^5.6.0", 1)
s = s.replace("packages:\n\n", "packages:\n\n  keytar@7.9.0:\n    resolution: {integrity: %s, tarball: file:vendor/keytar-7.9.0.tgz}\n\n" % sys.argv[1], 1)
s = s.replace("snapshots:\n\n", "snapshots:\n\n  keytar@7.9.0: {}\n\n", 1)
open("pnpm-lock.yaml", "w").write(s)
P
git add -A && git -c user.name=adv -c user.email=adv@x commit -qm "keytar from a tracked tarball, pnpm 10.32.1"
out=$("$src/scripts/check-install-scripts.sh" 2>&1); st=$?; echo "$out"
if [ -f "$mark" ]; then echo "control: tarball install script ran on pnpm 10.32.1: $(cat "$mark")"; else echo "control: tarball install script did not run"; fi
if [ $st -eq 0 ] || ! grep -q "^FAIL pnpm-lock.yaml: keytar@7.9.0" <<<"$out"; then
  echo "FAIL: probe did not refuse the lockfile's tarball resolution for keytar@7.9.0 (probe exit $st)"; exit 1
fi
echo "ok: probe exit $st"
