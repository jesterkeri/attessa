#!/bin/bash -p
# Refuse any install config outside an explicit allow-list (pnpmfiles, .npmrc, manifest keys,
# scripts, dependency specs, pnpm-workspace.yaml), then install HEAD with the pinned pnpm
# (packageManager), a fresh store and no side-effects cache, and fail if any install-time script
# runs other than a registry copy of the allowlist (better-sqlite3, keytar).
# Workspace manifests may add only: bin (attest or attessa[-name] commands, so no bin shadows a
# tool such as node or tsc in other packages' scripts, to .js files under the package's dist/),
# engines with a node semver range only (ASCII digits with no leading zero, or x/X/*, at most major.minor.patch, the
# operators < <= > >= = ^ ~, hyphen ranges and ||), and the scripts gen:vectors and render-units,
# each `node` (optionally --experimental-strip-types) on a tracked .ts, .js, .mjs or .cjs file under
# the package's scripts/; none of these runs at install. Each manifest is a UTF-8 JSON object with
# no byte-order mark, and its scripts and dependency maps are objects.
# These rules hold for every tracked package.json at any depth, not only pnpm's workspace projects:
# none is needed elsewhere, and refusing one costs less than proving which ones pnpm or node read.
# Nothing is resolved from the tree under test: pnpm, its store, config and log live beside the
# snapshot, never inside it, and PATH keeps only absolute entries outside the checked folder.
# Git runs no program the repository configures. In order, git is asked only for:
#   1. rev-parse --show-toplevel and --git-common-dir: path resolution from config, no objects.
#   2. config --includes --list: parses config files and runs nothing. The repository is refused
#      here if it can fetch objects on demand (any extensions.*, a promisor remote or partial-clone
#      filter, repositoryformatversion other than 0, a promisor pack), because a missing object
#      would then be fetched through the remote's configured upload-pack. GIT_NO_LAZY_FETCH=1 is
#      also set, for gits from 2.45. Only after this gate:
#   3. ls-tree and worktree list: tree objects and worktree metadata. No blob is ever read through
#      git (no cat-file): each file is read from the checkout and its blob id computed here.
# None of these reads the index or applies attributes, so no fsmonitor, filter, textconv, diff or
# merge driver, hook or pager runs. Never add status, diff, archive, checkout, ls-files or cat-file.
set -u
# The one pnpm the probe runs. packageManager must name exactly this: pnpm 10 would otherwise switch
# to whatever version a pull request pins (pnpm 9 ignores ignoreScripts in pnpm-workspace.yaml).
pnpm_version=10.32.1
# PATH keeps only absolute entries outside the checked folder, found with builtins alone (no
# command is looked up on PATH before this; the interpreter is /bin/bash itself, not env's lookup, and -p
# keeps it from sourcing BASH_ENV or importing functions from the environment): an entry such as $PWD/node_modules/.bin would
# otherwise resolve git, python3 or node from files the tree under test ships.
root=$(pwd -P); keep=
IFS=: read -ra entries <<<"$PATH"
for e in "${entries[@]}"; do
  [[ $e == /* ]] || continue
  r=$(cd -- "$e" 2>/dev/null && pwd -P) || continue
  [[ $r/ == "$root"/* ]] && continue
  keep=${keep:+$keep:}$e
done
# An empty PATH would mean the current folder, which is the checkout itself.
[ -n "$keep" ] || { echo "FAIL: no PATH entry outside the checked folder"; exit 1; }
PATH=$keep
# mktemp's folder must be absolute: the probe later cds into the snapshot and removes $tmp.
[[ ${TMPDIR:-/tmp} == /* ]] || unset TMPDIR
# git reads $XDG_CONFIG_HOME/git/config and $HOME/.gitconfig: a relative one would resolve inside the checkout.
[[ ${XDG_CONFIG_HOME:-/} == /* ]] || unset XDG_CONFIG_HOME
[[ ${HOME:-} == /* ]] || { echo "FAIL: HOME must be an absolute path"; exit 1; }
# The checked folder is the one this is run from, where the developer runs pnpm install, and it
# must be the repository root. Git is never left to choose it: GIT_* variables are dropped, git's
# own toplevel (which core.worktree or a .git file can move) must be this same folder, and every
# later git call names --git-dir and --work-tree explicitly.
unset $(compgen -e | grep '^GIT_')
# Only here does git choose the folder itself (-C, no --work-tree): its answer must be this one.
top=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null) && top=$(realpath -e "$top" 2>/dev/null)
[ -e "$root/.git" ] && [ "$top" = "$root" ] \
  || { echo "FAIL: run this from the repository root; git's work tree is '$top', not '$root'"; exit 1; }
G=(git --git-dir="$root/.git" --work-tree="$root" -c core.fsmonitor=false)
export GIT_NO_LAZY_FETCH=1
# Gate (step 2 of the header), before any command that reads an object: refuse a repository that
# can fetch a missing object on demand. Key names only are printed; config values are never shown.
common=$("${G[@]}" rev-parse --git-common-dir) && common=$(cd "$root" && realpath -e "$common") \
  || { echo "FAIL: cannot find the repository's object store"; exit 1; }
gcfg=$(mktemp)
"${G[@]}" config --includes --list --show-scope -z > "$gcfg" && python3 -I - "$common" "$gcfg" <<'PY'
import glob, os, sys
t = open(sys.argv[2], "rb").read().split(b"\0")
bad = []
for scope, kv in zip(t[0::2], t[1::2]):
    k, _, v = kv.partition(b"\n"); k = k.decode("utf-8", "replace").lower(); v = v.decode("utf-8", "replace").strip().lower()
    where = scope.decode("utf-8", "replace")
    if k.startswith("extensions."): bad.append(f"{k} ({where} config): no repository extensions")
    elif k.startswith("remote.") and k.endswith(".promisor") and v not in ("false", "no", "off", "0"): bad.append(f"{k} ({where} config): a promisor remote")
    elif k.startswith("remote.") and k.endswith(".partialclonefilter"): bad.append(f"{k} ({where} config): a partial-clone filter")
    elif k == "core.repositoryformatversion" and v != "0": bad.append(f"{k} ({where} config): must be 0")
objects = os.path.join(sys.argv[1], "objects")
for f in [os.path.join(objects, "info", "promisor")] + glob.glob(os.path.join(objects, "pack", "*.promisor")):
    if os.path.lexists(f): bad.append(f"{os.path.relpath(f, sys.argv[1])}: promisor objects")
for x in bad: print("FAIL " + x)
sys.exit(1 if bad else 0)
PY
gst=$?; rm -f "$gcfg"
[ $gst -eq 0 ] || { echo "FAIL: the repository can fetch objects on demand; the probe reads only local objects"; exit 1; }
# The proof below is about HEAD, so it only holds for this checkout when every file pnpm reads at
# install here is HEAD's. Refuse, by path, any .npmrc, pnpmfile or .corepack.env anywhere outside
# node_modules (found by name only; a .npmrc is never opened), and any root or packages/* manifest,
# lockfile or pnpm-workspace.yaml that is untracked, ignored, modified, missing or not a regular file.
python3 -I - "$root" "$root/.git" <<'PY' || { echo "FAIL: the checkout differs from HEAD in files pnpm reads at install"; exit 1; }
import hashlib, os, re, subprocess, sys
root = sys.argv[1]
oid_of = lambda b: hashlib.sha1(b"blob %d\0" % len(b) + b).hexdigest()
git = lambda *a: subprocess.run(["git", "--git-dir=" + sys.argv[2], "--work-tree=" + root, "-c", "core.fsmonitor=false", *a], capture_output=True, check=True).stdout
never = lambda b: b in (".npmrc", ".corepack.env") or re.fullmatch(r"\.?pnpmfile\.[cm]?js", b)
MANIFESTS = ("package.json", "package.json5", "package.yaml")
ROOT_FILES = MANIFESTS + ("pnpm-lock.yaml", "pnpm-workspace.yaml")
bad = []
# Submodules and other worktrees nested in this one are separate checkouts that pnpm does not read.
nested = {os.path.realpath(os.path.join(root, os.fsdecode(e.split(b"\t", 1)[1])))
          for e in git("ls-tree", "-r", "-z", "--full-tree", "HEAD").split(b"\0") if e.startswith(b"160000 ")}
nested |= {os.path.realpath(os.fsdecode(l[9:])) for l in git("worktree", "list", "--porcelain").split(b"\n") if l.startswith(b"worktree ")}
nested.discard(os.path.realpath(root))
for d, dirs, files in os.walk(root):
    for n in dirs + files:
        if never(n.lower()): bad.append(os.path.relpath(os.path.join(d, n), root) + ": not allowed in the checkout")
    dirs[:] = [n for n in dirs if n not in ("node_modules", ".git") and os.path.realpath(os.path.join(d, n)) not in nested]
# Every manifest pnpm can read here, in the checkout or in HEAD, must be byte-for-byte HEAD.
head = {}
for e in git("ls-tree", "-r", "-z", "--full-tree", "HEAD").split(b"\0"):
    if e: meta, raw = e.split(b"\t", 1); head[os.fsdecode(raw)] = meta.decode().split()[2]
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
    elif oid_of(open(f, "rb").read()) != head[p]: bad.append(f"{p}: modified in the checkout")
for x in bad: print("FAIL " + x.encode("utf-8", "surrogateescape").decode("utf-8", "backslashreplace"))
sys.exit(1 if bad else 0)
PY
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
work="$tmp/src"; mkdir "$work" "$tmp/pm"
# The snapshot is HEAD's tree built from the checkout (see the header: no git archive, no cat-file):
# each file is copied only if its blob id equals HEAD's, so every tracked file must be committed.
# Regular files only; a submodule becomes an empty folder, as in an archive; a symlink, any other
# mode, or a file missing or changed in the checkout is refused.
python3 -I - "$root/.git" "$work" "$root" <<'PY' || { echo "FAIL: the checkout is not HEAD; the snapshot is built from it, so commit or restore these first"; exit 1; }
import hashlib, os, subprocess, sys
gd, work, root = sys.argv[1], sys.argv[2], sys.argv[3]
oid_of = lambda b: hashlib.sha1(b"blob %d\0" % len(b) + b).hexdigest()
git = lambda *a: subprocess.run(["git", "--git-dir=" + gd, "--work-tree=" + sys.argv[3], "-c", "core.fsmonitor=false", *a], capture_output=True, check=True).stdout
bad = []
for e in git("ls-tree", "-r", "-z", "--full-tree", "HEAD").split(b"\0"):
    if not e: continue
    meta, raw = e.split(b"\t", 1); mode, kind, oid = meta.decode().split()
    p = os.fsdecode(raw); parts = p.split("/")
    if any(c in ("", ".", "..") or c.lower() == ".git" for c in parts) or p.startswith("/"):
        bad.append(f"{p}: not a path inside the tree"); continue
    out = os.path.join(work, p)
    if mode == "160000" and kind == "commit": os.makedirs(out, exist_ok=True); continue
    if kind != "blob" or mode not in ("100644", "100755"):
        bad.append(f"{p}: a {kind} with mode {mode}; only regular files are installed"); continue
    src = os.path.join(root, p)
    if os.path.islink(src) or not os.path.isfile(src):
        bad.append(f"{p}: missing or not a regular file in the checkout"); continue
    with open(src, "rb") as f: data = f.read()
    if oid_of(data) != oid: bad.append(f"{p}: differs from HEAD in the checkout"); continue
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "xb") as f: f.write(data)
    if mode == "100755": os.chmod(out, 0o755)
for x in bad: print("FAIL " + x.encode("utf-8", "surrogateescape").decode("utf-8", "backslashreplace"))
sys.exit(1 if bad else 0)
PY
cd "$work"
# Static allow-list first: install-time code can also come from a pnpmfile, a config file or a
# manifest field that no lifecycle event reports, so only the config this repo uses is accepted.
# Manifests are read as data from the verified snapshot (each file hashed equal to its HEAD blob)
# and never evaluated, and every manifest name
# must be a regular file: as a directory, node would run its "main" and pnpm would read inside it.
# -z: without it git quotes non-ASCII paths and the basename checks below would miss them.
pm=$("${G[@]}" ls-tree -r -z --full-tree HEAD | python3 -I -c '
import json, os, re, subprocess, sys, yaml
V, ALLOW = sys.argv[2], ("better-sqlite3", "keytar")
# The allowlisted packages pnpm may build, as name@version: the integrity the default registry
# publishes. Adding one to the lockfile means pinning its registry integrity here first.
# better-sqlite3@13.0.3: pnpm-lock.yaml and `npm view better-sqlite3@13.0.3 dist.integrity` agreed on 2026-11-02.
PINNED = {"better-sqlite3@13.0.3": "sha512-RbOBxmLBG8uvFUc15X9+9SFemKcQ0WBuISBVkpuiaUB2qblC8UWlHEjdWVoZ8AdhSwmoEgsiXKfopX0CQxaACQ=="}
# A node semver range: comparator sets joined by ||, each a hyphen range or space-separated comparators.
_V = r"(0|[1-9][0-9]*|[xX*])(\.(0|[1-9][0-9]*|[xX*])){0,2}"
_SET = rf"{_V} - {_V}|((<=|>=|<|>|=|\^|~) *)?{_V}( +((<=|>=|<|>|=|\^|~) *)?{_V})*"
# pnpm joins node_modules with each dependency name, so a name is an npm package name: no "/" beyond its scope,
# no leading "." (so no ".."), nothing that makes it a path.
NAME = r"(@[A-Za-z0-9~-][A-Za-z0-9._~-]*/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*"
NODE_RANGE = rf"({_SET})( *\|\| *({_SET}))*"
blob = lambda p: open(os.path.join(sys.argv[4], p), "rb").read()
names = ("package.json", "package.json5", "package.yaml", "pnpm-workspace.yaml", "pnpm-lock.yaml")
bad, reg, later, files = [], {}, [], set()
for r in sys.stdin.buffer.read().split(b"\0"):
    if not r: continue
    meta, raw = r.split(b"\t", 1); mode, _, oid = meta.decode().split()
    p = os.fsdecode(raw); parts = p.split("/"); b = parts[-1].lower()
    if mode == "100644": reg[p] = oid
    if mode in ("100644", "100755"): files.add(p)  # a script that node runs may be executable
    # A tracked node_modules is read at install (bins, .modules.yaml, the virtual store).
    if "node_modules" in parts: bad.append(f"{p}: not allowed (tracked node_modules)")
    # Symlinks would make the install read a path other than the blob checked here.
    if mode == "120000": bad.append(f"{p}: not allowed (symlink)")
    if any(c.lower() in names for c in parts[:-1]) or (b in names and mode != "100644"):
        bad.append(f"{p}: not allowed (a manifest name that is not a regular file, mode {mode})")
    # .gitattributes is refused too: git applies it to every checkout and archive of this tree.
    # package.json5 and package.yaml are pnpm manifests these checks do not parse; corepack reads .corepack.env.
    if b in (".npmrc", ".gitattributes", ".corepack.env", "package.json5", "package.yaml") or re.fullmatch(r"\.?pnpmfile\.[cm]?js", b):
        bad.append(f"{p}: not allowed (read at install)")
    if b == "package.json" and p in reg:
        try: m = json.loads(blob(p).decode("utf-8"))  # str input: a BOM or UTF-16 is an error
        except ValueError: m = None
        if not isinstance(m, dict) or any(not isinstance(m.get(k, {}), dict) for k in ("scripts", "dependencies", "devDependencies")):
            bad.append(f"{p}: must be a UTF-8 JSON object with no byte-order mark, its scripts and dependencies objects"); continue
        if p == "package.json":
            keys = {"name", "private", "packageManager", "engines", "devDependencies", "pnpm"}
            if set(m.get("pnpm", {})) - {"onlyBuiltDependencies"}: bad.append(f"{p}: pnpm keys other than onlyBuiltDependencies")
            if set(m.get("pnpm", {}).get("onlyBuiltDependencies", [])) - set(ALLOW): bad.append(f"{p}: onlyBuiltDependencies beyond better-sqlite3, keytar")
            pmv = m.get("packageManager")
            if pmv != f"pnpm@{V}": bad.append(f"{p}: packageManager must be exactly pnpm@{V}, got {pmv!r}")
            e = m.get("engines", {})
            if set(e) - {"node", "pnpm"} or e.get("pnpm", f">={V}") not in (V, f">={V}"): bad.append(f"{p}: engines must be node and pnpm {V} or >={V} only, got {e!r}")
        else:
            keys = {"name", "version", "private", "type", "main", "types", "scripts", "dependencies", "devDependencies", "bin", "engines"}
            # pnpm links each bin into the node_modules/.bin of dependents: command names to files
            # under the dist/ of this package only (no absolute path, no ".", ".." or hidden component).
            bn = m.get("bin", {})
            if not isinstance(bn, dict) or any(not re.fullmatch(r"atte(st|ssa(-[a-z0-9]+)*)", c) or not isinstance(f, str) or not re.fullmatch(r"dist(/[A-Za-z0-9_][A-Za-z0-9_.-]*)+\.js", f) for c, f in bn.items()):
                bad.append(f"{p}: bin must map command names to .js files under dist/, got {bn!r}")
            e = m.get("engines", {})
            if not isinstance(e, dict) or set(e) - {"node"} or not isinstance(e.get("node", "0"), str) or not re.fullmatch(NODE_RANGE, e.get("node", "0")):
                bad.append(f"{p}: engines must be a node range only, got {e!r}")
        extra = set(m) - keys
        if extra: bad.append(f"{p}: keys not allowed: {sorted(extra)}")
        scripts = set(m.get("scripts", {})) - ({"build", "lint", "typecheck", "test"} if p != "package.json" else set())
        # Two named scripts that never run at install, each only as node on a tracked file of its
        # own package (checked after the walk, once every blob is listed).
        for s in scripts & ({"gen:vectors", "render-units"} if p != "package.json" else set()):
            c = re.fullmatch(r"node (--experimental-strip-types )?(scripts(/[A-Za-z0-9_][A-Za-z0-9_.-]*)+\.(ts|js|mjs|cjs))", str(m["scripts"][s]))
            if c: scripts.discard(s); later.append((p, s, os.path.dirname(p) + "/" + c.group(2)))
        if scripts: bad.append(f"{p}: scripts not allowed: {sorted(scripts)}")
        for k in ("dependencies", "devDependencies"):
            for n, v in m.get(k, {}).items():
                if not re.fullmatch(NAME, str(n)): bad.append(f"{p}: dependency name {n!r} is not an npm package name")
                if not re.fullmatch(r"workspace:[*^~]|[\^~]?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?", str(v)): bad.append(f"{p}: {n}@{v} is not a registry version or workspace:")
for p, s, f in later:
    if f not in files: bad.append(f"{p}: script {s} must run a tracked regular file of its package, not {f}")
for p in ("package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"):
    if p not in reg: bad.append(f"{p}: missing or not a regular file (mode 100644)")
# PyYAML and pnpm (@zkochan/js-yaml) resolve merge keys, anchors and tags differently (two << merges: the later
# wins in PyYAML, the earlier in pnpm), and pnpm never writes them, so neither YAML file may use them.
for p in ("pnpm-workspace.yaml", "pnpm-lock.yaml"):
    if p not in reg: continue
    try: toks = list(yaml.scan(blob(p)))
    except yaml.YAMLError: continue  # the load below reports it
    if any(isinstance(t, (yaml.AnchorToken, yaml.AliasToken, yaml.TagToken, yaml.DirectiveToken)) or (isinstance(t, yaml.ScalarToken) and t.value == "<<") for t in toks):
        bad.append(f"{p}: anchors, aliases, tags, directives and << merge keys are not allowed (PyYAML and pnpm resolve them differently)")
w = yaml.safe_load(blob("pnpm-workspace.yaml")) if "pnpm-workspace.yaml" in reg else None
# PyYAML reads YAML 1.1 (yes/on are true), pnpm 1.2 (strings), so past its comment lines the file is one exact text.
if w is not None and b"".join(l for l in blob("pnpm-workspace.yaml").splitlines(True) if not re.match(rb"[ \t]*#", l)) != b"packages:\n  - packages/*\nignoreScripts: true\n":
    bad.append("pnpm-workspace.yaml: past its comment lines it must be exactly `packages:`, `  - packages/*`, `ignoreScripts: true`, each ending in a newline")
if w != {"packages": ["packages/*"], "ignoreScripts": True}: bad.append(f"pnpm-workspace.yaml: must be exactly packages [packages/*] and ignoreScripts true, got {w!r}")
# Every package comes from the default registry by integrity (no tarball, file, directory, git,
# link or other registry), so pnpm installs the registry copy or fails the integrity check.
L = yaml.safe_load(blob("pnpm-lock.yaml")) if "pnpm-lock.yaml" in reg else {}
if not isinstance(L, dict) or L.get("lockfileVersion") != "9.0" or L.get("settings") != {"autoInstallPeers": True, "excludeLinksFromLockfile": False}:
    bad.append("pnpm-lock.yaml: must be lockfileVersion 9.0 with the default settings")
    L = {}
# PyYAML reads YAML 1.1 (a key null, ~, yes or 1 is no string), pnpm 1.2 and then String(key), so every
# mapping key in the lockfile must be a string for the two to name the same thing.
def keys(o):
    if isinstance(o, dict): return all(isinstance(k, str) and keys(v) for k, v in o.items())
    return all(keys(v) for v in o) if isinstance(o, list) else True
if not keys(L): bad.append("pnpm-lock.yaml: every mapping key must be a string (PyYAML and pnpm read null, ~, yes or 1 keys differently)")
semver = NAME + r"@[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?"
# pnpm merges each packages entry over its snapshot (its dependencies, version or id win) and reads top-level keys
# such as overrides, patchedDependencies or catalogs, so only the fields this lockfile uses are allowed.
extra = set(L) - {"lockfileVersion", "settings", "importers", "packages", "snapshots"}
if extra: bad.append(f"pnpm-lock.yaml: top-level keys not allowed: {sorted(extra)}")
for k, v in (L.get("packages") or {}).items():
    extra = set(v or {}) - {"resolution", "engines", "os", "cpu", "libc", "hasBin", "peerDependencies", "peerDependenciesMeta", "deprecated"}
    if extra: bad.append(f"pnpm-lock.yaml: {k}: keys not allowed: {sorted(extra)}")
for k, v in (L.get("packages") or {}).items():
    r = (v or {}).get("resolution")
    if not re.fullmatch(semver, str(k)) or not isinstance(r, dict) or set(r) != {"integrity"} or not re.fullmatch(r"sha512-[A-Za-z0-9+/]+={0,2}", str(r["integrity"])):
        bad.append(f"pnpm-lock.yaml: {k}: resolution must be the default registry with a sha512 integrity only, got {r!r}")
    elif str(k).rsplit("@", 1)[0] in ALLOW and PINNED.get(k) != r["integrity"]:
        bad.append(f"pnpm-lock.yaml: {k}: allowlisted package without its pinned registry integrity")
# pnpm under --frozen-lockfile checks only an importer specifier against package.json and links or installs its
# version as written, so each importer is the root or a workspace project, and each dependency is either the
# workspace project of that name (workspace: specifier, link: to its folder) or the registry snapshot of that name.
proj = {}
for p in reg:
    if re.fullmatch(r"packages/[^/]+/package\.json", p):
        # the pnpm packages/* glob skips dot folders and ignores bower_components (node_modules is refused above)
        if re.fullmatch(r"packages/(\.[^/]*|bower_components)/package\.json", p):
            bad.append(f"{p}: pnpm does not list this folder as a workspace project"); continue
        try: nm = json.loads(blob(p).decode("utf-8")).get("name")
        except (ValueError, AttributeError): nm = None
        if isinstance(nm, str) and re.fullmatch(NAME, nm): proj[os.path.dirname(p)] = nm
        else: bad.append(f"{p}: name {nm!r} is not an npm package name")
snaps = L.get("snapshots") or {}
for i, deps in (L.get("importers") or {}).items():
    if i != "." and i not in proj: bad.append(f"pnpm-lock.yaml: importer {i} is not the root or a workspace project")
    for f, d in (deps or {}).items():
        for n, x in (d or {}).items():
            if not re.fullmatch(NAME, str(n)): bad.append(f"pnpm-lock.yaml: importer {i}: dependency name {n!r} is not an npm package name")
            xv, sp = str(x.get("version")), str(x.get("specifier"))
            if xv.startswith("link:"): ok = sp.startswith("workspace:") and proj.get(os.path.normpath(os.path.join(str(i), xv[5:]))) == n
            else: ok = not sp.startswith("workspace:") and f"{n}@{xv}" in snaps
            if not ok: bad.append(f"pnpm-lock.yaml: importer {i} {n}: version {xv!r} is neither the workspace project {n} nor the registry package {n}")
# pnpm builds each package as the snapshot merged with packages[key minus its "(peers)" suffix], so a snapshot
# with no packages entry, or with fields of its own such as resolution, would install from wherever it says.
pkgs = L.get("packages") or {}
for k, v in (L.get("snapshots") or {}).items():
    if str(k).split("(", 1)[0] not in pkgs: bad.append(f"pnpm-lock.yaml: snapshot {k} has no packages entry")
    extra = set(v or {}) - {"dependencies", "optionalDependencies", "transitivePeerDependencies", "optional"}
    if extra: bad.append(f"pnpm-lock.yaml: snapshot {k}: keys not allowed: {sorted(extra)}")
    for f in ("dependencies", "optionalDependencies"):
        for n, x in ((v or {}).get(f) or {}).items():
            if not re.fullmatch(NAME, str(n)): bad.append(f"pnpm-lock.yaml: snapshot {k}: dependency name {n!r} is not an npm package name")
            if ":" in str(x): bad.append(f"pnpm-lock.yaml: snapshot {k} {n}: version {x!r} is not a registry version")
for x in bad: print("FAIL " + x.encode("utf-8", "surrogateescape").decode("utf-8", "backslashreplace"))
if bad: sys.exit(1)
print(json.loads(blob("package.json")).get("packageManager", ""))
' "$root/.git" "$pnpm_version" "$root" "$work") || { echo "$pm"; echo "FAIL: repo install config is outside the allow-list"; exit 1; }
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
ok = re.compile(r"node_modules/\.pnpm/(better-sqlite3|keytar)@[0-9]+\.[0-9]+\.[0-9]+[^/]*/node_modules/\1")
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
