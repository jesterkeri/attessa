#!/usr/bin/env bash
# Checks that catch the pipeline mistakes an agent reliably makes. Parses the YAML (quoted keys,
# ? explicit keys, flow mappings, anchors) and walks every workflow, every action file under
# .github/, and every local ./ action they call, recursively:
#   1. no ${{ }} expression inside a run: script. GitHub expands it before the shell sees it, so
#      event text (titles, branch names) becomes code. Set it in env: and use "$VAR" instead.
#   2. no pull_request_target: it runs with secrets against a fork's pull request.
#   3. every action pinned to a full commit sha, first-party included: tags move, and that is how
#      the known compromises worked. docker:// refs need an @sha256: digest.
# Keys are compared case-insensitively and a duplicate key fails, so the parser and GitHub
# cannot disagree about which value counts.
set -uo pipefail
D="${1:-.github/workflows}"; [ -d "$D" ] || { echo "no workflows at $D"; exit 0; }
python3 -I -c '
import pathlib, re, sys
try:
    import yaml
except ImportError:
    print("FAIL: PyYAML (python3-yaml) is required to parse workflows"); sys.exit(1)

class Loader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        self.flatten_mapping(node)
        keys = [str(self.construct_object(k, deep=True)).lower() for k, _ in node.value]
        dup = sorted({k for k in keys if keys.count(k) > 1})
        if dup:
            raise yaml.MarkedYAMLError(problem=f"duplicate key {dup}", problem_mark=node.start_mark)
        return super().construct_mapping(node, deep)

todo = sorted(pathlib.Path(sys.argv[1]).glob("*.y*ml")) + sorted(pathlib.Path(".github").rglob("action.y*ml"))
seen, bad = set(), 0
def fail(msg, hint=None):
    global bad
    print("FAIL " + msg)
    if hint: print("     " + hint)
    bad = 1

def check_ref(f, ref):
    if ref.startswith("./"):
        p = pathlib.Path(ref)
        hit = [p] if p.is_file() else [q for q in (p / "action.yml", p / "action.yaml") if q.is_file()]
        if not hit: fail(f"local action not found in {f}: {ref}")
        todo.extend(hit)
    elif ref.startswith("docker://"):
        if not re.search(r"@sha256:[0-9a-f]{64}$", ref):
            fail(f"unpinned docker image in {f}: {ref}", "Pin to a digest, e.g. docker://image@sha256:<64 hex>")
    elif not re.search(r"@[0-9a-f]{40}$", ref):
        fail(f"unpinned action in {f}: {ref}", "Pin to a full 40-character commit sha, e.g. owner/repo@<sha> # v1.2.3")

def walk(f, n):
    if isinstance(n, dict):
        for k, v in n.items():
            k = str(k).lower()
            if k == "uses" or (k == "image" and isinstance(v, str) and v.startswith("docker://")):
                if isinstance(v, str): check_ref(f, v.strip())
                else: fail(f"non-string {k} in {f}: {v!r}")
            elif k == "run" and isinstance(v, str) and "${{" in v:
                fail(f"expression in a run: script in {f}: {v.strip()[:120]!r}",
                     "Set it in the step env: (NAME: ${{ ... }}) and use \"$NAME\" in the script.")
            if k == "pull_request_target":
                fail(f"pull_request_target in {f}", "Use pull_request.")
            walk(f, v)
    elif isinstance(n, list):
        for v in n: walk(f, v)
    elif n == "pull_request_target":
        fail(f"pull_request_target in {f}", "Use pull_request.")

while todo:
    f = todo.pop().resolve()
    if f in seen: continue
    seen.add(f)
    try:
        docs = list(yaml.load_all(f.read_text(), Loader=Loader))
    except yaml.YAMLError as e:
        fail(f"cannot parse {f}: {e}"); continue
    for d in docs: walk(f, d)
if not bad: print("workflows clean")
sys.exit(bad)
' "$D"
