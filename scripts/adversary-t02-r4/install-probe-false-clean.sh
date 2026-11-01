#!/usr/bin/env bash
# T02 adversary r4: check-install-scripts.sh must fail when the real pnpm (packageManager) would run a
# non-allowlisted install script. Opens every build (ignoreScripts false, esbuild allowed) in a scratch
# copy of HEAD, then runs the probe and the real pnpm. The probe must not say ok.
set -u
src="$(cd "$(dirname "$0")/../.." && pwd)"
R=$(mktemp -d /tmp/attessa-adv-t02-r4-inst.XXXX); trap 'rm -rf "$R"' EXIT
git -C "$src" archive HEAD | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
python3 -I - <<'P'
import json
p=json.load(open("package.json")); p["pnpm"]={"onlyBuiltDependencies":["esbuild"],"dangerouslyAllowAllBuilds":True}
json.dump(p,open("package.json","w"),indent=2)
w=open("pnpm-workspace.yaml").read().replace("ignoreScripts: true","ignoreScripts: false"); open("pnpm-workspace.yaml","w").write(w)
P
git -c user.name=adv -c user.email=adv@x commit -qam "allow all builds"
echo "== real pnpm $(pnpm --version):"; pnpm install --frozen-lockfile --reporter=append-only 2>&1 | grep -E 'install\$' || echo "(no install script ran)"
echo "== probe:"
if "$src/scripts/check-install-scripts.sh"; then echo "FAIL: probe said ok while a non-allowlisted install script runs"; exit 1; fi
echo "ok: probe refused"
