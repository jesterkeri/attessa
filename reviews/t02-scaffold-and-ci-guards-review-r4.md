# T02 scaffold and CI guards — adversarial re-review r4

Reviewed frozen commit `6444f45` against `da61075`, the T02 verification requirement, PIPELINE.md, AGENTS.md, THREAT-MODEL.md, ADR-001, and both guard headers. This was a single-prompt review; under REVIEW-PROTOCOL U1/U7, the inside/outside measurement below is indicative, not a blind-review measurement.

## Findings

### Critical

None.

### Major

None.

### Minor

None.

## Round-3 findings

- **M1 — fixed.** `.github/CODEOWNERS:6` is the sole catch-all `* @jesterkeri` rule. It therefore covers the CI workflows, both guards, every toolchain selector, manifests, lockfiles, build configuration, and a newly added path. `scripts/adversary-t02-codex-r3/codeowners-covers-everything.sh` passed and requires exactly that shape. This closes the prior omitted-selector path; enforcement by the GitHub rulesets remains the already logged external prerequisite.
- **m1 — fixed.** `scripts/check-workflows.sh:43-44,127-129` maps the documented ceilings and applies the lower of the job-id and job-name ceilings, defaulting either unknown dimension to one minute. The repository workflows now declare 4/4/3/5 minutes in `.github/workflows/ci.yml:21,49,84,119` and one minute in `.github/workflows/harness.yml:23,67`. The named-budget and renamed-id/new-harness-job adversaries passed (`scripts/adversary-t02-codex-r3/check-workflows-budget.sh` and `scripts/adversary-t02-r16/check-workflows-budget-by-id.sh`).

## Verification and adversarial evidence

- `./scripts/check-workflows.sh` completed: `workflows clean`.
- The workflow adversaries, including the r3 budget cases, r16 job-id/name cases, action pinning, expression-in-run, runner, checkout-input, and timeout-value cases, passed locally.
- `bash -n scripts/check-workflows.sh scripts/check-install-scripts.sh` and `git diff --check da61075 6444f45` passed.
- I found no changed-path route that could alter CI execution or obtain more than `contents: read` without touching a path covered by the catch-all code-owner rule. The accepted limitations listed in OPEN-QUESTIONS.md were not re-reported.

## U5 — changed behaviour without a focused test

None found. The new ownership shape, each documented budget, an unknown job, renamed ids, renamed harness jobs, and a new harness job each have a focused adversary case.

## U7 — prompt classification

Findings: 0 inside / 0 outside. This count is indicative only because the prompt supplied the prior findings and questions before the review.

## U8 — limits and checks not completed here

- The normal install probe and the TASKS T02 verify command were each attempted under the required `flock -w 1800 /home/hr/.cache/attessa-heavy.lock`, but did not complete with output in this sandbox's 30-second network-restricted execution window. The install-adversary batch also reached `setup: lockfile update failed` in `install-probe-keytar-dir.sh`, which requires pnpm registry access. Per the review instruction, this is not a finding. I relied on the real, unlocked `de462b9` outputs pasted in the final T02 DONE.md entry; `6444f45` changes only that evidence entry.
- I did not verify the GitHub rulesets or the codeowners/errors API from this sandbox; both are GitHub-side state. The ruleset prerequisite is already logged in OPEN-QUESTIONS.md.
- I did not audit every unchanged vendored source file under `contracts/lib/nitro-validator`; no reviewed guard executes it and the submodule pin was not changed in this range.

## U9 — scope

I swept the complete T02 guard/workflow/install-config surface and its CI consumers, not only the two previous findings. No root cause was found outside that surface.

DECISION: SHIP
VERDICT: implementation-ready
