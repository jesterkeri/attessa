#!/usr/bin/env bash
# Refuse any install config outside an explicit allow-list (pnpmfiles, .npmrc, manifest keys,
# scripts, dependency specs, pnpm-workspace.yaml), then install HEAD with the pinned pnpm
# (packageManager), a fresh store and no side-effects cache, and fail if any install-time script
# runs other than a registry copy of the allowlist (better-sqlite3, keytar).
# Nothing is resolved from the tree under test: pnpm, its store, config and log live beside the
# archive, never inside it, and PATH keeps absolute entries only.
set -u
PATH=$(printf %s "$PATH" | tr ':' '\n' | grep '^/' | paste -sd:)
root=$(git rev-parse --show-toplevel)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
work="$tmp/src"; mkdir "$work" "$tmp/pm"
git -C "$root" archive HEAD | tar -x -C "$work"
cd "$work"
# Static allow-list first: install-time code can also come from a pnpmfile, a config file or a
# manifest field that no lifecycle event reports, so only the config this repo uses is accepted.
# Manifests are read as data from git blobs, never through the archive, and every manifest name
# must be a regular file: as a directory, node would run its "main" and pnpm would read inside it.
# -z: without it git quotes non-ASCII paths and the basename checks below would miss them.
pm=$(git -C "$root" ls-tree -r -z --full-tree HEAD | python3 -I -c '
import json, os, re, subprocess, sys, yaml
blob = lambda oid: subprocess.run(["git", "-C", sys.argv[1], "cat-file", "blob", oid], capture_output=True, check=True).stdout
names = ("package.json", "package.json5", "package.yaml", "pnpm-workspace.yaml", "pnpm-lock.yaml")
bad, reg = [], {}
for r in sys.stdin.buffer.read().split(b"\0"):
    if not r: continue
    meta, raw = r.split(b"\t", 1); mode, _, oid = meta.decode().split()
    p = os.fsdecode(raw); parts = p.split("/"); b = parts[-1].lower()
    if mode == "100644": reg[p] = oid
    # A tracked node_modules is read at install (bins, .modules.yaml, the virtual store).
    if "node_modules" in parts: bad.append(f"{p}: not allowed (tracked node_modules)")
    # Symlinks would make the install read a path other than the blob checked here.
    if mode == "120000": bad.append(f"{p}: not allowed (symlink)")
    if any(c.lower() in names for c in parts[:-1]) or (b in names and mode != "100644"):
        bad.append(f"{p}: not allowed (a manifest name that is not a regular file, mode {mode})")
    # .gitattributes is refused too: export-ignore would hide a file from the archive installed below.
    # package.json5 and package.yaml are pnpm manifests these checks do not parse; corepack reads .corepack.env.
    if b in (".npmrc", ".gitattributes", ".corepack.env", "package.json5", "package.yaml") or re.fullmatch(r"\.?pnpmfile\.[cm]?js", b):
        bad.append(f"{p}: not allowed (read at install)")
    if b == "package.json" and p in reg:
        m = json.loads(blob(oid))
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
for p in ("package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"):
    if p not in reg: bad.append(f"{p}: missing or not a regular file (mode 100644)")
w = yaml.safe_load(blob(reg["pnpm-workspace.yaml"])) if "pnpm-workspace.yaml" in reg else None
if w != {"packages": ["packages/*"], "ignoreScripts": True}: bad.append(f"pnpm-workspace.yaml: must be exactly packages [packages/*] and ignoreScripts true, got {w!r}")
for x in bad: print("FAIL " + x.encode("utf-8", "surrogateescape").decode("utf-8", "backslashreplace"))
if bad: sys.exit(1)
print(json.loads(blob(reg["package.json"])).get("packageManager", ""))
' "$root") || { echo "$pm"; echo "FAIL: repo install config is outside the allow-list"; exit 1; }
pm=${pm%%+*}
[[ $pm =~ ^pnpm@[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "FAIL: packageManager is not pnpm@X.Y.Z: '$pm'"; exit 1; }
# The pinned pnpm is fetched into a folder outside the archive (npx would first run a
# node_modules/.bin/$pm found from the cwd) and must report exactly that version.
( cd "$tmp/pm" && npm_config_userconfig=/dev/null npm install --prefix "$tmp/pm" --ignore-scripts \
  --no-save --no-package-lock --no-audit --no-fund "$pm" ) > "$tmp/pm.log" 2>&1 \
  || { echo "FAIL: could not fetch $pm"; tail -5 "$tmp/pm.log"; exit 1; }
pnpm=("$(command -v node)" "$tmp/pm/node_modules/pnpm/bin/pnpm.cjs")
v=$(cd "$tmp/pm" && "${pnpm[@]}" --version 2>/dev/null)
[ "pnpm@$v" = "$pm" ] || { echo "FAIL: fetched pnpm reports '$v', not $pm"; exit 1; }
# User-level config is kept out so only the repo's own settings decide what runs.
npm_config_userconfig=/dev/null XDG_CONFIG_HOME="$tmp/cfg" "${pnpm[@]}" install --frozen-lockfile \
  --reporter=ndjson --store-dir "$tmp/store" --no-side-effects-cache > "$tmp/log" 2>&1
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
' "$work" "$tmp/log") || { echo "FAIL: could not read the install log"; exit 1; }
if [ -n "$ran" ]; then echo "FAIL: non-allowlisted install script ran:"; echo "$ran"; exit 1; fi
# A failed install proves nothing either way, so it fails the probe.
if [ $st -ne 0 ]; then
  echo "FAIL: $pm install failed (exit $st); no evidence either way:"
  tail -5 "$tmp/log"
  exit 1
fi
echo "$pm install ran no non-allowlisted install script: ok"
