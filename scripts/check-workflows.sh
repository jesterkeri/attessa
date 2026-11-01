#!/usr/bin/env bash
# Workflow allow-list. Every file in the workflows directory is parsed and must use only the
# triggers, keys, actions and expressions this repo uses today; anything else fails, so a new
# trick fails by default. To use something new, add it here in the same change, deliberately.
#   - files: .yml or .yaml only (any other name or case fails, so nothing goes unscanned).
#   - top level: name, on, permissions (exactly contents: read), concurrency, jobs.
#   - triggers: pull_request, push, each with branches only.
#   - jobs: name, runs-on (exactly ubuntu-latest: never a self-hosted or labelled runner),
#     timeout-minutes (required, an integer from 1 to the job's PIPELINE.md budget, looked up by
#     both its id and its name (which defaults to the id) and the smaller one taken: ts 4,
#     contracts 4, slither 3, enclave 5, guardrails 1, secrets / "no secrets in client output" 1;
#     an id or name not listed counts as 1, the strictest budget, so a renamed or new job is held
#     to 1 minute until it is added to BUDGET deliberately), steps. Steps: name, id, uses, with, run, env,
#     working-directory (a relative path inside the checkout). No local ./ actions, no docker://,
#     no reusable workflows. concurrency.cancel-in-progress is a boolean.
#   - uses: only the actions below, pinned to a full commit sha, with only the inputs listed and
#     only the values listed; actions/checkout always with persist-credentials: false.
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

ACTIONS = {  # action -> input it may be given -> the values it may take
    "actions/checkout": {
        "persist-credentials": lambda v: v is False,
        "submodules": lambda v: v == "recursive" or type(v) is bool,
        "fetch-depth": lambda v: type(v) is int and v >= 0,
    },
    "actions/setup-node": {"node-version-file": lambda v: v == ".nvmrc"},
    "foundry-rs/foundry-toolchain": {"version": lambda v: v == "${{ steps.foundry.outputs.version }}"},
}
EXPR = re.compile(r"github\.ref|github\.base_ref \|\| \x27main\x27|steps\.[a-z][a-z0-9_-]*\.outputs\.[a-z][a-z0-9_-]*")
TOP = {"name", "on", "permissions", "concurrency", "jobs"}
TRIGGERS = {"pull_request", "push"}
JOB = {"name", "runs-on", "timeout-minutes", "steps"}
# PIPELINE.md minutes per job, keyed by job id and by job name; anything not listed gets 1.
BUDGET = {"ts": 4, "contracts": 4, "slither": 3, "enclave": 5, "guardrails": 1, "secrets": 1, "no secrets in client output": 1}
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
    wd = s.get("working-directory")
    if "working-directory" in s and not (isinstance(wd, str) and re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*", wd)):
        fail(f"{where}.working-directory", f"{wd!r} must be a relative path inside the checkout")
    for k, v in keys(f"{where}.env", s.get("env", {}), set(s.get("env", {}) or {})).items():
        scalar(f"{where}.env.{k}", v, "free")
    if "uses" in s:
        u = s["uses"]; m = re.fullmatch(r"([\w.-]+/[\w.-]+)@[0-9a-f]{40}", u) if isinstance(u, str) else None
        if not m or m.group(1) not in ACTIONS:
            fail(f"{where}.uses", f"{u!r} is not an allowed action pinned to a 40-character sha {sorted(ACTIONS)}"); return
        for k, v in keys(f"{where}.with", s.get("with", {}), ACTIONS[m.group(1)]).items():
            scalar(f"{where}.with.{k}", v, "list")
            if k in ACTIONS[m.group(1)] and not ACTIONS[m.group(1)][k](v): fail(f"{where}.with.{k}", f"value {v!r} is not allowed")
        # checkout persists the token on disk unless told not to, where every later step can read it.
        if m.group(1) == "actions/checkout" and (s.get("with") or {}).get("persist-credentials") is not False:
            fail(f"{where}.with", "actions/checkout needs persist-credentials: false")
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
    if type(c.get("cancel-in-progress", True)) is not bool: fail(f"{f}.concurrency.cancel-in-progress", "must be true or false")
    for j, job in keys(f"{f}.jobs", d.get("jobs"), set(d.get("jobs") or {})).items():
        keys(f"{f}.jobs.{j}", job, JOB)
        for k in ("name", "runs-on", "timeout-minutes"):
            if k in job: scalar(f"{f}.jobs.{j}.{k}", job[k])
        # A pull_request job runs fork code: only a fresh GitHub-hosted runner, never a persistent one.
        ro = job.get("runs-on")
        if ro != "ubuntu-latest": fail(f"{f}.jobs.{j}.runs-on", f"must be exactly ubuntu-latest, got {ro!r}")
        # Required: without it GitHub applies its own default of hours, not a bound of ours.
        tm = job.get("timeout-minutes")
        cap = min(BUDGET.get(str(j), 1), BUDGET.get(str(job.get("name", j)), 1))
        if type(tm) is not int or not 1 <= tm <= cap: fail(f"{f}.jobs.{j}.timeout-minutes", f"is required, an integer 1 to {cap} (PIPELINE.md budget), got {tm!r}")
        steps = job.get("steps")
        if not isinstance(steps, list) or not steps: fail(f"{f}.jobs.{j}", "steps must be a non-empty list"); continue
        for i, s in enumerate(steps): step(f"{f}.jobs.{j}.steps[{i}]", s)
if not files: print(f"no workflows at {sys.argv[1]}")
if not bad: print("workflows clean")
sys.exit(bad)
' "$D"
