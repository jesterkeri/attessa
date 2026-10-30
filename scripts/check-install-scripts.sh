#!/usr/bin/env bash
# Refuse any install config outside an explicit allow-list (pnpmfiles, .npmrc, manifest keys,
# scripts, dependency specs, pnpm-workspace.yaml), then install HEAD with the pinned pnpm
# (packageManager), a fresh store and no side-effects cache, and fail if any install-time script
# runs other than a registry copy of the allowlist (better-sqlite3, keytar).
set -u
root=$(git rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git -C "$root" archive HEAD | tar -x -C "$work"
cd "$work"
# Static allow-list first: install-time code can also come from a pnpmfile, a config file or a
# manifest field that no lifecycle event reports, so only the config this repo uses is accepted.
git -C "$root" ls-tree -r --name-only HEAD | python3 -I -c '
import json, re, sys, yaml
bad = []
for p in sys.stdin.read().splitlines():
    b = p.rsplit("/", 1)[-1].lower()
    # .gitattributes is refused too: export-ignore would hide a file from the archive installed below.
    if b in (".npmrc", ".gitattributes") or re.fullmatch(r"\.?pnpmfile\.[cm]?js", b):
        bad.append(f"{p}: not allowed (pnpm reads it at install)")
    if b == "package.json":
        m = json.load(open(p))
        if p == "package.json":
            keys = {"name", "private", "packageManager", "engines", "devDependencies", "pnpm"}
            if set(m.get("pnpm", {})) - {"onlyBuiltDependencies"}: bad.append(f"{p}: pnpm keys other than onlyBuiltDependencies")
            if set(m.get("pnpm", {}).get("onlyBuiltDependencies", [])) - {"better-sqlite3", "keytar"}: bad.append(f"{p}: onlyBuiltDependencies beyond better-sqlite3, keytar")
        else:
            keys = {"name", "version", "private", "type", "main", "types", "scripts", "dependencies", "devDependencies"}
        extra = set(m) - keys
        if extra: bad.append(f"{p}: keys not allowed: {sorted(extra)}")
        scripts = set(m.get("scripts", {})) - ({"build", "lint", "typecheck", "test"} if p != "package.json" else set())
        if scripts: bad.append(f"{p}: scripts not allowed: {sorted(scripts)}")
        for k in ("dependencies", "devDependencies"):
            for n, v in m.get(k, {}).items():
                if not re.fullmatch(r"workspace:[*^~]|[\^~]?\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?", str(v)): bad.append(f"{p}: {n}@{v} is not a registry version or workspace:")
w = yaml.safe_load(open("pnpm-workspace.yaml"))
if w != {"packages": ["packages/*"], "ignoreScripts": True}: bad.append(f"pnpm-workspace.yaml: must be exactly packages [packages/*] and ignoreScripts true, got {w!r}")
for x in bad: print("FAIL " + x)
sys.exit(1 if bad else 0)
' || { echo "FAIL: repo install config is outside the allow-list"; exit 1; }
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
