#!/usr/bin/env bash
# T02 adversary r8: the probe reads packageManager with node -p 'require("./package.json")' inside
# the archive. If the tracked root package.json is a directory, require loads it as a package and
# runs its "main". The static allow-list never checks that the root manifest is a file:
# package.json/package.json (name, main) passes as an ordinary manifest and the .js beside it is
# not looked at. Scratch copy of HEAD where package.json/ holds the original manifest as orig.json
# and a main that writes a marker, exports the original manifest and puts it back as a file, so
# pnpm then installs normally. The probe must fail; it fails the test if it says ok while the
# marker was written.
set -u
src="$(cd "$(dirname "$0")/../.." && pwd)"
R=$(mktemp -d /tmp/attessa-adv-t02-r8-dir.XXXX); mark="$R.pwned"; trap 'rm -rf "$R" "$mark"' EXIT
git -C "$src" archive HEAD | tar -x -C "$R"; cd "$R"
git init -q && git add -A && git -c user.name=adv -c user.email=adv@x commit -qm base
mv package.json orig.json && mkdir package.json && mv orig.json package.json/orig.json
printf '{"name":"x","main":"x.js"}\n' > package.json/package.json
cat > package.json/x.js <<J
const fs = require("fs"), path = require("path");
fs.writeFileSync("$mark", "PWNED " + process.cwd() + "\n");
const orig = fs.readFileSync(path.join(__dirname, "orig.json"));
module.exports = JSON.parse(orig);
fs.rmSync(__dirname, { recursive: true, force: true });
fs.writeFileSync(path.join(process.cwd(), "package.json"), orig);
J
git add -A && git -c user.name=adv -c user.email=adv@x commit -qm "package.json as a directory"
out=$("$src/scripts/check-install-scripts.sh" 2>&1); st=$?; echo "$out"
[ -f "$mark" ] && echo "marker: $(cat "$mark")"
if [ -f "$mark" ]; then echo "FAIL: probe ran package.json/x.js from the tree under test (probe exit $st)"; exit 1; fi
echo "ok: probe exit $st"
