#!/usr/bin/env bash
# Install HEAD with the pinned pnpm (packageManager), a fresh store and no side-effects cache,
# and fail if any install-time script runs other than a registry copy of the allowlist
# (better-sqlite3, keytar).
set -u
root=$(git rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git -C "$root" archive HEAD | tar -x -C "$work"
cd "$work"
pm=$(node -p 'require("./package.json").packageManager || ""'); pm=${pm%%+*}
[[ $pm =~ ^pnpm@[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "FAIL: packageManager is not pnpm@X.Y.Z: '$pm'"; exit 1; }
# User-level config is kept out so only the repo's own settings decide what runs.
npm_config_userconfig=/dev/null XDG_CONFIG_HOME="$work/.cfg" npx -y "$pm" install --frozen-lockfile \
  --reporter=ndjson --store-dir "$work/.store" --no-side-effects-cache > "$work/.log" 2>&1
st=$?
# pnpm reports every script it runs (any stage; root and workspace projects included) as a
# pnpm:lifecycle event with its directory. Only <name>@<semver>/node_modules/<name> in the
# virtual store passes: pnpm names that from the lockfile's registry resolution, so a directory
# or a package.json that merely says keytar does not.
ran=$(python3 -I -c '
import json, os, re, sys
work = os.path.realpath(sys.argv[1])
ok = re.compile(r"node_modules/\.pnpm/(better-sqlite3|keytar)@\d+\.\d+\.\d+[^/]*/node_modules/\1")
events = 0
for line in open(sys.argv[2], errors="replace"):
    try: e = json.loads(line)
    except ValueError: continue
    if not isinstance(e, dict) or not str(e.get("name", "")).startswith("pnpm:"): continue
    events += 1
    if e["name"] != "pnpm:lifecycle" or not e.get("script"): continue
    wd = os.path.relpath(os.path.realpath(e.get("wd") or "/"), work)
    if not ok.fullmatch(wd): print("%s %s$ %s" % (wd, e.get("stage"), e["script"]))
sys.exit(0 if events else 1)  # no pnpm events at all means the log format changed, not "clean"
' "$work" "$work/.log") || { echo "FAIL: could not read the install log"; exit 1; }
if [ -n "$ran" ]; then echo "FAIL: non-allowlisted install script ran:"; echo "$ran"; exit 1; fi
# A failed install proves nothing either way, so it fails the probe.
if [ $st -ne 0 ]; then
  echo "FAIL: $pm install failed (exit $st); no evidence either way:"
  tail -5 "$work/.log"
  exit 1
fi
echo "$pm install ran no non-allowlisted install script: ok"
