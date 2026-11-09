# CI `ts` budget review — r2 (`1c76f6d`)

Scope reviewed: `git diff 8f649a2..1c76f6d`, every consumer of the changed timeout, the workflow-policy/ownership boundary, the r1 findings, and the cited GitHub Actions attempts. This was a single-prompt review: the prompt supplied its concerns before the diff was inspected, so the U7 count is indicative rather than a rigorous cold-read measurement (U1).

## Critical

None.

## Major

None.

## Minor

None.

## Confirmed controls

- The workflow changes only `.github/workflows/ci.yml:21`, where the `ts` job moves from 4 to 6 minutes. The other CI ceilings remain contracts 4, slither 3, and enclave 5; the unchanged harness jobs remain 1 minute. The diff does not touch `.github/workflows/harness.yml`.
- The value agrees across its consumers: `PIPELINE.md:9`, `scripts/check-workflows.sh:10-13,44`, `.github/workflows/ci.yml:21`, and the two budget adversaries at `scripts/adversary-t02-codex-r3/check-workflows-budget.sh:35` and `scripts/adversary-t02-r16/check-workflows-budget-by-id.sh:18`. The guard still applies the lower of ID/name caps and defaults either unlisted dimension to one minute at `scripts/check-workflows.sh:127-129`.
- `scripts/adversary-t02-r16/check-workflows-budget-by-id.sh:18` now matches the six-minute source literal and executes its mutation. Its `typescript`/`name: ts` job at 5 minutes is refused with the one-minute unknown-ID cap; this closes r1 m1. The stale `ts 4` guard comment is now `ts 6` at `scripts/check-workflows.sh:10`; this closes r1 m2.
- The DONE evidence at `DONE.md:4621-4627` is accurate. Read-only `gh run view <id> --attempt <n> --json jobs` returns the stated attempt spans: 42500812715 244 s cancelled / 157 s success; 42501256160 242 s cancelled / 194 s success; and 42522705467 255 s cancelled / 256 s cancelled. The same SHA's push run 42522701434 succeeded in 202 s. All 19 completed successful `ts` jobs returned for 2026-11-08 ranged from 157 to 236 seconds. The reviewed commit's PR run 42525279310 also succeeded in 259 seconds under the new cap.
- No CODEOWNERS, workflow permission, required-check, or ruleset configuration is changed by the commit: `.github/CODEOWNERS` and `.github/workflows/harness.yml` are absent from the diff, and CI retains exact `permissions: {contents: read}`. The current active GitHub ruleset 26156029 (`main and staging`) requires `ts`, `contracts`, `slither`, `enclave`, `guardrails`, and `no secrets in client output`, plus code-owner review.

## Protocol record

- **U2 completeness sweep:** “only” holds for timeout policy: the sole production workflow ceiling changed is `ts`; every other BUDGET value and job ceiling is unchanged. The necessary policy, guard explanation, and regression-fixture propagation changed with it.
- **U3/U4 derived invariants and consumers:** the documented ceiling, configured CI ceiling, executable guard cap, guard explanation, and both direct and renamed-ID adversaries must agree. They do. The timeout is neither persisted nor exported beyond GitHub workflow execution, so there is no additional downstream data consumer.
- **U5:** both changed number-bearing adversaries execute and prove the boundary; the unchanged missing-timeout adversary also passes.
- **U6:** this is explicitly a deliberate exception to PIPELINE's normal nightly-move policy. The confirmed 259-second run of this commit and the documented historical variability provide evidence that the exception is not disguising a changed test set or removed work.
- **U7:** findings: 0 inside, 0 outside. Per U1, this is a weak signal only, not a claim of an unframed blind review.
- **U8 verification results:**

  ```text
  ./scripts/check-workflows.sh
  workflows clean

  scripts/adversary-t02-codex-r3/check-workflows-budget.sh
  ok   ts=6 clean
  ok   ts=7: FAIL .github/workflows/ci.yml.jobs.ts.timeout-minutes: is required, an integer 1 to 6 (PIPELINE.md budget), got 7
  ok   contracts=4 clean
  ok   contracts=5: FAIL .github/workflows/ci.yml.jobs.contracts.timeout-minutes: is required, an integer 1 to 4 (PIPELINE.md budget), got 5
  ok   slither=3 clean
  ok   slither=4: FAIL .github/workflows/ci.yml.jobs.slither.timeout-minutes: is required, an integer 1 to 3 (PIPELINE.md budget), got 4
  ok   enclave=5 clean
  ok   enclave=6: FAIL .github/workflows/ci.yml.jobs.enclave.timeout-minutes: is required, an integer 1 to 5 (PIPELINE.md budget), got 6
  ok   guardrails=1 clean
  ok   guardrails=2: FAIL .github/workflows/ci.yml.jobs.guardrails.timeout-minutes: is required, an integer 1 to 1 (PIPELINE.md budget), got 2
  ok   secrets=1 clean
  ok   secrets=2: FAIL .github/workflows/ci.yml.jobs.secrets.timeout-minutes: is required, an integer 1 to 1 (PIPELINE.md budget), got 2
  ok   other=1 clean
  ok   other=2: FAIL .github/workflows/ci.yml.jobs.other.timeout-minutes: is required, an integer 1 to 1 (PIPELINE.md budget), got 2

  scripts/adversary-t02-r16/check-workflows-budget-by-id.sh
  ok   ts-renamed-id: FAIL .github/workflows/ci.yml.jobs.typescript.timeout-minutes: is required, an integer 1 to 1 (PIPELINE.md budget), got 5
  ok   guardrails-renamed-id: FAIL .github/workflows/harness.yml.jobs.guard.timeout-minutes: is required, an integer 1 to 1 (PIPELINE.md budget), got 5
  ok   harness-new-job: FAIL .github/workflows/harness.yml.jobs.reviews.timeout-minutes: is required, an integer 1 to 1 (PIPELINE.md budget), got 5

  scripts/adversary-t02-codex-r2/check-workflows-timeout-missing.sh
  ok   with-timeout: workflows clean
  ok   timeout-missing: FAIL .github/workflows/ci.yml.jobs.a.timeout-minutes: is required, an integer 1 to 1 (PIPELINE.md budget), got None
  ```

  All four commands exited 0. `scripts/adversary-t02-codex-r3/codeowners-covers-everything.sh` also passed, and `git diff --check 8f649a2..1c76f6d` had no output. I did not inspect private CI logs, secrets, or any local `.env`/`.npmrc`/key file. GitHub's jobs metadata gives durations and conclusions but not an explicit cancellation-reason field; the entry's "at the limit" characterization is supported by the 242–255-second cancelled spans against the former four-minute cap.
- **U9:** an unscoped sweep of all changed files, both repository workflows, the guard consumers, CODEOWNERS, and the current external ruleset found no root cause outside the stated CI-budget scope. This is not an exhaustive historical review of all workflows or GitHub configuration changes outside this commit.

Decision: SHIP
VERDICT: implementation-ready
