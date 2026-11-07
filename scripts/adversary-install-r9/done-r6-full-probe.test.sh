#!/usr/bin/env bash
# Install allow-list adversary r9, full probe (take the heavy lock): DONE.md's adversary r6 note says
# "scripts as a list or string, a null bin, `__proto__`, BOM or UTF-16 manifests ... are all
# refused". One scratch commit of HEAD with packages/core's scripts as a list and packages/sdk's
# manifest saved with a UTF-8 BOM (nothing else changed); this test fails if the whole probe
# accepts it (exit 0 and its ok line). Usage: $0 <repo root at the commit under test>.
set -u
src="${1:?repo root}"; guard="$src/scripts/check-install-scripts.sh"
R=$(mktemp -d /tmp/attessa-adv-allowlist-r9full.XXXX); trap 'rm -rf "$R"' EXIT
git -C "$src" archive HEAD | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
python3 -I - <<'PY'
import json
p = "packages/core/package.json"; m = json.load(open(p)); m["scripts"] = ["test"]
open(p, "w").write(json.dumps(m, indent=2) + "\n")
p = "packages/sdk/package.json"; b = open(p, "rb").read(); open(p, "wb").write(b"\xef\xbb\xbf" + b)
PY
git -c user.name=adv -c user.email=adv@x commit -qam "scripts list in core, BOM in sdk"
head -c 3 packages/sdk/package.json | od -An -tx1
out=$("$guard" 2>&1); st=$?
echo "probe exit $st: ${out##*$'\n'}"
if [ $st -eq 0 ] && grep -q 'install ran no non-allowlisted install script: ok' <<<"$out"; then
  echo "FAIL: the probe accepted a scripts list and a BOM manifest, which DONE.md says are refused"; exit 1
fi
echo "ok: refused"; exit 0
