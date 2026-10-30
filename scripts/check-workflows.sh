#!/usr/bin/env bash
# Workflow allow-list. Every file in the workflows directory is parsed and must use only the
# triggers, keys, actions and expressions this repo uses today; anything else fails, so a new
# trick fails by default. To use something new, add it here in the same change, deliberately.
#   - files: .yml or .yaml only (any other name or case fails, so nothing goes unscanned).
#   - top level: name, on, permissions (exactly contents: read), concurrency, jobs.
#   - triggers: pull_request, push, each with branches only.
#   - jobs: name, runs-on, timeout-minutes, steps. Steps: name, id, uses, with, run, env,
#     working-directory. No local ./ actions, no docker://, no reusable workflows.
#   - uses: only the actions below, pinned to a full commit sha, with only the inputs listed.
#   - ${{ }}: free inside env: values (the safe pattern: env, then "$VAR" in the script); in
#     with: inputs and concurrency.group only the expressions in EXPR; nowhere else, run: included.
# Keys are compared exactly, and a duplicate key (in any letter case) fails.
set -uo pipefail
D="${1:-.github/workflows}"; [ -d "$D" ] || { echo "no workflows at $D"; exit 0; }
python3 -I -c '
import pathlib, re, sys
try:
    import yaml
except ImportError:
    print("FAIL: PyYAML (python3-yaml) is required to parse workflows"); sys.exit(1)

ACTIONS = {  # action -> inputs it may be given
    "actions/checkout": {"persist-credentials", "submodules", "fetch-depth"},
    "actions/setup-node": {"node-version-file"},
    "foundry-rs/foundry-toolchain": {"version"},
}
EXPR = re.compile(r"github\.ref|github\.base_ref \|\| \x27main\x27|steps\.[a-z][a-z0-9_-]*\.outputs\.[a-z][a-z0-9_-]*")
TOP = {"name", "on", "permissions", "concurrency", "jobs"}
TRIGGERS = {"pull_request", "push"}
JOB = {"name", "runs-on", "timeout-minutes", "steps"}
STEP = {"name", "id", "uses", "with", "run", "env", "working-directory"}

class Loader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        self.flatten_mapping(node)
        keys = [str(self.construct_object(k, deep=True)).lower() for k, _ in node.value]
        dup = sorted({k for k in keys if keys.count(k) > 1})
        if dup:
            raise yaml.MarkedYAMLError(problem=f"duplicate key {dup}", problem_mark=node.start_mark)
        return super().construct_mapping(node, deep)

bad = 0
def fail(where, msg):
    global bad
    print(f"FAIL {where}: {msg}"); bad = 1

def keys(where, m, allowed):
    if not isinstance(m, dict): fail(where, f"must be a mapping, got {m!r}"); return {}
    for k in m:
        if k not in allowed: fail(where, f"key {k!r} is not on the allow-list {sorted(allowed)}")
    return m

def scalar(where, v, expr=None):  # expr: None = no ${{ }}, "free", or "list" = only EXPR
    if not isinstance(v, (str, int, float, bool)) or (v is None):
        fail(where, f"must be a scalar, got {v!r}"); return
    if not isinstance(v, str) or "${{" not in v or expr == "free": return
    bodies = re.findall(r"\$\{\{(.*?)\}\}", v, re.S)
    if expr != "list" or v.count("${{") != len(bodies) or not all(EXPR.fullmatch(b.strip()) for b in bodies):
        fail(where, f"expression not allowed here: {v[:120]!r} (use env: and \"$VAR\")")

def step(where, s):
    keys(where, s, STEP)
    if ("uses" in s) == ("run" in s): fail(where, "a step needs exactly one of uses or run"); return
    for k in ("name", "id", "working-directory", "run"):
        if k in s: scalar(f"{where}.{k}", s[k])
    for k, v in keys(f"{where}.env", s.get("env", {}), set(s.get("env", {}) or {})).items():
        scalar(f"{where}.env.{k}", v, "free")
    if "uses" in s:
        u = s["uses"]; m = re.fullmatch(r"([\w.-]+/[\w.-]+)@[0-9a-f]{40}", u) if isinstance(u, str) else None
        if not m or m.group(1) not in ACTIONS:
            fail(f"{where}.uses", f"{u!r} is not an allowed action pinned to a 40-character sha {sorted(ACTIONS)}"); return
        for k, v in keys(f"{where}.with", s.get("with", {}), ACTIONS[m.group(1)]).items():
            scalar(f"{where}.with.{k}", v, "list")
    elif "with" in s: fail(where, "with: without uses:")

files = sorted(pathlib.Path(sys.argv[1]).iterdir())
for f in files:
    if not (f.is_file() and f.suffix in (".yml", ".yaml")):
        fail(f, "only .yml or .yaml files may live in the workflows directory"); continue
    try:
        docs = list(yaml.load_all(f.read_text(), Loader=Loader))
    except yaml.YAMLError as e:
        fail(f, f"cannot parse: {e}"); continue
    if len(docs) != 1: fail(f, "exactly one YAML document expected"); continue
    d = docs[0]
    if not isinstance(d, dict): fail(f, "must be a mapping"); continue
    if True in d and "on" in d: fail(f, "on: appears twice"); continue
    if True in d: d ={("on" if k is True else k): v for k, v in d.items()}  # YAML 1.1 reads on: as true
    keys(f, d, TOP)
    if "name" in d: scalar(f"{f}.name", d["name"])
    if d.get("permissions") != {"contents": "read"}: fail(f, "permissions must be exactly {contents: read}")
    for t, v in keys(f"{f}.on", d.get("on"), TRIGGERS).items():
        if v is not None:
            for b in keys(f"{f}.on.{t}", v, {"branches"}).get("branches", []): scalar(f"{f}.on.{t}.branches", b)
    c = keys(f"{f}.concurrency", d.get("concurrency", {}), {"group", "cancel-in-progress"})
    for k, v in c.items(): scalar(f"{f}.concurrency.{k}", v, "list" if k == "group" else None)
    for j, job in keys(f"{f}.jobs", d.get("jobs"), set(d.get("jobs") or {})).items():
        keys(f"{f}.jobs.{j}", job, JOB)
        for k in ("name", "runs-on", "timeout-minutes"):
            if k in job: scalar(f"{f}.jobs.{j}.{k}", job[k])
        steps = job.get("steps")
        if not isinstance(steps, list) or not steps: fail(f"{f}.jobs.{j}", "steps must be a non-empty list"); continue
        for i, s in enumerate(steps): step(f"{f}.jobs.{j}.steps[{i}]", s)
if not files: print(f"no workflows at {sys.argv[1]}")
if not bad: print("workflows clean")
sys.exit(bad)
' "$D"
