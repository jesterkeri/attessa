#!/usr/bin/env bash
# Refuse any install config outside an explicit allow-list (pnpmfiles, .npmrc, manifest keys,
# scripts, dependency specs, pnpm-workspace.yaml), then install HEAD with the pinned pnpm
# (packageManager), a fresh store and no side-effects cache, and fail if any install-time script
# runs other than a registry copy of the allowlist (better-sqlite3, keytar).
# Nothing is resolved from the tree under test: pnpm, its store, config and log live beside the
# archive, never inside it, and PATH keeps absolute entries only.
set -u
# The one pnpm the probe runs. packageManager must name exactly this: pnpm 10 would otherwise switch
# to whatever version a pull request pins (pnpm 9 ignores ignoreScripts in pnpm-workspace.yaml).
pnpm_version=10.32.1
PATH=$(printf %s "$PATH" | tr ':' '\n' | grep '^/' | paste -sd:)
root=$(git rev-parse --show-toplevel)
# The proof below is about HEAD, so it only holds for this checkout when every file pnpm reads at
# install here is HEAD's. Refuse, by path, any .npmrc, pnpmfile or .corepack.env anywhere outside
# node_modules (found by name only; a .npmrc is never opened), and any root or packages/* manifest,
# lockfile or pnpm-workspace.yaml that is untracked, ignored, modified, missing or not a regular file.
python3 -I - "$root" <<'PY' || { echo "FAIL: the checkout differs from HEAD in files pnpm reads at install"; exit 1; }
import os, re, subprocess, sys
root = sys.argv[1]
git = lambda *a: subprocess.run(["git", "-C", root, *a], capture_output=True, check=True).stdout
never = lambda b: b in (".npmrc", ".corepack.env") or re.fullmatch(r"\.?pnpmfile\.[cm]?js", b)
MANIFESTS = ("package.json", "package.json5", "package.yaml")
ROOT_FILES = MANIFESTS + ("pnpm-lock.yaml", "pnpm-workspace.yaml")
bad = []
# Submodules and other worktrees nested in this one are separate checkouts that pnpm does not read.
nested = {os.path.realpath(os.path.join(root, os.fsdecode(e.split(b"\t", 1)[1])))
          for e in git("ls-files", "-s", "-z").split(b"\0") if e.startswith(b"160000 ")}
nested |= {os.path.realpath(os.fsdecode(l[9:])) for l in git("worktree", "list", "--porcelain").split(b"\n") if l.startswith(b"worktree ")}
nested.discard(os.path.realpath(root))
for d, dirs, files in os.walk(root):
    for n in dirs + files:
        if never(n.lower()): bad.append(os.path.relpath(os.path.join(d, n), root) + ": not allowed in the checkout")
    dirs[:] = [n for n in dirs if n not in ("node_modules", ".git") and os.path.realpath(os.path.join(d, n)) not in nested]
# Every manifest pnpm can read here, in the checkout or in HEAD, must be byte-for-byte HEAD.
head = {os.fsdecode(p) for p in git("ls-tree", "-r", "-z", "--name-only", "HEAD").split(b"\0") if p}
want = {p for p in head if p in ROOT_FILES or re.fullmatch(r"packages/[^/]+/(%s)" % "|".join(map(re.escape, MANIFESTS)), p)}
want |= {n for n in ROOT_FILES if os.path.lexists(os.path.join(root, n))}
pk = os.path.join(root, "packages")
if os.path.islink(pk): bad.append("packages: a symlink in the checkout")
elif os.path.isdir(pk):
    for d in os.listdir(pk):
        if os.path.islink(os.path.join(pk, d)): bad.append(f"packages/{d}: a symlink in the checkout")
        want |= {f"packages/{d}/{m}" for m in MANIFESTS if os.path.lexists(os.path.join(pk, d, m))}
for p in sorted(want):
    f = os.path.join(root, p)
    if p not in head: bad.append(f"{p}: untracked or ignored in the checkout")
    elif not os.path.lexists(f): bad.append(f"{p}: missing from the checkout")
    elif os.path.islink(f) or not os.path.isfile(f): bad.append(f"{p}: not a regular file in the checkout")
    elif open(f, "rb").read() != git("cat-file", "blob", "HEAD:" + p): bad.append(f"{p}: modified in the checkout")
for x in bad: print("FAIL " + x.encode("utf-8", "surrogateescape").decode("utf-8", "backslashreplace"))
sys.exit(1 if bad else 0)
PY
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
V, ALLOW = sys.argv[2], ("better-sqlite3", "keytar")
# The allowlisted packages pnpm may build, as name@version: the integrity the default registry
# publishes. Adding one to the lockfile means pinning its registry integrity here first.
PINNED = {}
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
            if set(m.get("pnpm", {}).get("onlyBuiltDependencies", [])) - set(ALLOW): bad.append(f"{p}: onlyBuiltDependencies beyond better-sqlite3, keytar")
            pmv = m.get("packageManager")
            if pmv != f"pnpm@{V}": bad.append(f"{p}: packageManager must be exactly pnpm@{V}, got {pmv!r}")
            e = m.get("engines", {})
            if set(e) - {"node", "pnpm"} or e.get("pnpm", f">={V}") not in (V, f">={V}"): bad.append(f"{p}: engines must be node and pnpm {V} or >={V} only, got {e!r}")
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
# Every package comes from the default registry by integrity (no tarball, file, directory, git,
# link or other registry), so pnpm installs the registry copy or fails the integrity check.
L = yaml.safe_load(blob(reg["pnpm-lock.yaml"])) if "pnpm-lock.yaml" in reg else {}
if not isinstance(L, dict) or L.get("lockfileVersion") != "9.0" or L.get("settings") != {"autoInstallPeers": True, "excludeLinksFromLockfile": False}:
    bad.append("pnpm-lock.yaml: must be lockfileVersion 9.0 with the default settings")
    L = {}
semver = r"(@[A-Za-z0-9._~-]+/)?[A-Za-z0-9._~-]+@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?"
for k, v in (L.get("packages") or {}).items():
    r = (v or {}).get("resolution")
    if not re.fullmatch(semver, str(k)) or not isinstance(r, dict) or set(r) != {"integrity"} or not re.fullmatch(r"sha512-[A-Za-z0-9+/]+={0,2}", str(r["integrity"])):
        bad.append(f"pnpm-lock.yaml: {k}: resolution must be the default registry with a sha512 integrity only, got {r!r}")
    elif str(k).rsplit("@", 1)[0] in ALLOW and PINNED.get(k) != r["integrity"]:
        bad.append(f"pnpm-lock.yaml: {k}: allowlisted package without its pinned registry integrity")
# Dependency versions never point into the tree: link: only for a workspace: specifier.
for i, deps in (L.get("importers") or {}).items():
    for f, d in (deps or {}).items():
        for n, x in (d or {}).items():
            xv = str(x.get("version"))
            if ":" in xv and not (xv.startswith("link:") and str(x.get("specifier")).startswith("workspace:")):
                bad.append(f"pnpm-lock.yaml: importer {i} {n}: version {xv!r} is not a registry version")
for k, v in (L.get("snapshots") or {}).items():
    for f in ("dependencies", "optionalDependencies"):
        for n, x in ((v or {}).get(f) or {}).items():
            if ":" in str(x): bad.append(f"pnpm-lock.yaml: snapshot {k} {n}: version {x!r} is not a registry version")
for x in bad: print("FAIL " + x.encode("utf-8", "surrogateescape").decode("utf-8", "backslashreplace"))
if bad: sys.exit(1)
print(json.loads(blob(reg["package.json"])).get("packageManager", ""))
' "$root" "$pnpm_version") || { echo "$pm"; echo "FAIL: repo install config is outside the allow-list"; exit 1; }
[ "$pm" = "pnpm@$pnpm_version" ] || { echo "FAIL: packageManager is not pnpm@$pnpm_version: '$pm'"; exit 1; }
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
