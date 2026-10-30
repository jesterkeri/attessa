#!/usr/bin/env bash
# Two checks that catch the pipeline mistakes an agent reliably makes.
set -uo pipefail
D="${1:-.github/workflows}"; [ -d "$D" ] || { echo "no workflows at $D"; exit 0; }
fail=0

# 1. attacker-controlled context interpolated into a shell step
if grep -rnE '\$\{\{[[:space:]]*github\.event\.(issue|pull_request|comment|review|discussion)\.[a-z_.]*(title|body|name|login)' "$D" 2>/dev/null | grep -v 'env:'; then
  echo "FAIL: attacker-controlled context interpolated directly. Pass it through env: and quote the variable."
  fail=1
fi
if grep -rnE '\$\{\{[[:space:]]*github\.head_ref' "$D" 2>/dev/null | grep -v 'env:'; then
  echo "FAIL: github.head_ref is a fork-controlled branch name. Route it through env:."
  fail=1
fi

# 2. pull_request_target at all
if grep -rn 'pull_request_target' "$D" 2>/dev/null; then
  echo "FAIL: pull_request_target runs with secrets against a fork's pull request. Use pull_request, or justify it in a comment on the line and remove this check."
  fail=1
fi

# 3. every action pinned to a full commit sha, first-party included: tags move, and that is
#    how the known compromises worked. Parses the YAML (quoted keys, ? explicit keys, flow
#    mappings, anchors) and walks every workflow, every action file under .github/, and every
#    local ./ action they call, recursively. docker:// refs need an @sha256: digest.
if ! python3 -I -c '
import pathlib, re, sys
try:
    import yaml
except ImportError:
    print("FAIL: PyYAML (python3-yaml) is required to parse workflows"); sys.exit(1)
todo = sorted(pathlib.Path(sys.argv[1]).glob("*.y*ml")) + sorted(pathlib.Path(".github").rglob("action.y*ml"))
seen, bad = set(), 0
def check(f, ref):
    global bad
    if ref.startswith("./"):
        p = pathlib.Path(ref)
        hit = [p] if p.is_file() else [q for q in (p / "action.yml", p / "action.yaml") if q.is_file()]
        if not hit:
            print(f"FAIL local action not found in {f}: {ref}"); bad = 1
        todo.extend(hit)
    elif ref.startswith("docker://"):
        if not re.search(r"@sha256:[0-9a-f]{64}$", ref):
            print(f"FAIL unpinned docker image in {f}: {ref}")
            print("     Pin to a digest, e.g. docker://image@sha256:<64 hex>"); bad = 1
    elif not re.search(r"@[0-9a-f]{40}$", ref):
        print(f"FAIL unpinned action in {f}: {ref}")
        print("     Pin to a full 40-character commit sha, e.g. owner/repo@<sha> # v1.2.3"); bad = 1
def walk(f, n):
    global bad
    if isinstance(n, dict):
        for k, v in n.items():
            if k == "uses" or (k == "image" and isinstance(v, str) and v.startswith("docker://")):
                if isinstance(v, str): check(f, v.strip())
                else: print(f"FAIL non-string {k} in {f}: {v!r}"); bad = 1
            walk(f, v)
    elif isinstance(n, list):
        for v in n: walk(f, v)
while todo:
    f = todo.pop().resolve()
    if f in seen: continue
    seen.add(f)
    try:
        docs = list(yaml.safe_load_all(f.read_text()))
    except yaml.YAMLError as e:
        print(f"FAIL cannot parse {f}: {e}"); bad = 1; continue
    for d in docs: walk(f, d)
sys.exit(bad)
' "$D"; then fail=1; fi

[ "$fail" -eq 0 ] && echo "workflows clean"
exit $fail
