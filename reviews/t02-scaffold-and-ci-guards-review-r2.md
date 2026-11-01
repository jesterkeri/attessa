# T02 scaffold and CI guards — adversarial review r2

Reviewed frozen `7335c20` (whole-task history `46c2354..7335c20`; post-r1
range `831aba3..7335c20`), excluding the requested tracking files.

U1/U7 caveat: this was a single-prompt review, so the prompt had already
exposed its concerns before the audit.  The INSIDE/OUTSIDE count below is
indicative, not a blind-review measurement.

## Critical

None.

## Major

1. **[INSIDE] The workflow guard can be changed in the same PR it is meant to
   police.** `.github/workflows/harness.yml:25-31` checks out the PR revision
   and then invokes `./scripts/check-workflows.sh` from that revision.  There
   is no repository-local immutable/required workflow, base-ref checkout, or
   CODEOWNERS control protecting the guard.  Thus a PR can replace the guard
   with `exit 0` and add a workflow with `permissions: {contents: write}` (or
   secrets and an unpinned action).  The required `guardrails` status then
   succeeds on the PR; after merge, the new `push` workflow receives the
   elevated configuration.  A full-SHA allow-list only helps if the program
   evaluating it is not attacker-controlled.

   This breaks the T02 requirement that the guard *refuse any workflow* that
   can grant more than read access, and PIPELINE.md:52-53/72-76's CI supply
   chain and branch-policy control.

   Reproduction: in a disposable PR branch, change
   `scripts/check-workflows.sh` to `#!/bin/sh\nexit 0`, add
   `.github/workflows/escalate.yml` with `on: push`, `permissions: {contents:
   write}`, and a `run:` step, then observe the existing `harness / guardrails`
   job pass because line 31 runs the altered script.  The current check cannot
   distinguish that PR from a clean one.  Use a GitHub required workflow (or
   other policy evaluated outside the PR checkout) for the workflow policy,
   and protect changes to that policy/guard with a separately enforced review.

2. **[INSIDE] The local install guard proves an archived commit, not the tree
   that `pnpm install` will use.** `scripts/check-install-scripts.sh:13-18`
   selects the repository root and archives `HEAD`; lines 24-98 likewise read
   blobs from `HEAD`.  An untracked or modified `.pnpmfile.cjs`, `.npmrc`,
   manifest, or lockfile in the active checkout is therefore invisible to the
   static allow-list and absent from the probe, although pnpm reads it when the
   developer next runs `pnpm install --frozen-lockfile`.  In particular,
   `.pnpmfile.cjs` executes hooks despite `ignoreScripts`; the committed-file
   version is correctly covered by `adversary-t02-r6/install-probe-pnpmfile.sh`,
   but there is no dirty-worktree variant.

   This breaks the script's stated purpose at lines 2-5 and the task's local
   proof that the install command runs no non-allowlisted code.

   Reproduction: in a clean disposable checkout, create (but do not commit) a
   root `.pnpmfile.cjs` whose module body writes a marker and exports
   `{ hooks: {} }`.  `bash scripts/check-install-scripts.sh` still archives the
   clean `HEAD` and reports success, while `pnpm install --frozen-lockfile` in
   that checkout loads the untracked pnpmfile and writes the marker.  The same
   gap applies to an untracked `.npmrc` that changes pnpm's behaviour.  Either
   reject a dirty/untracked install-relevant worktree before claiming a result,
   or inspect and probe the exact checked-out tree without allowing ignored or
   untracked inputs to leak in.

## Minor

1. **[INSIDE] The bounded-timeout allow-list accepts workflows with no timeout
   at all.** `scripts/check-workflows.sh:115-121` substitutes `1` when
   `timeout-minutes` is absent instead of requiring the key.  Both
   `.github/workflows/harness.yml:20-23` and `:63-66` omit it, yet
   `./scripts/check-workflows.sh` prints `workflows clean`.  GitHub then uses
   its much larger default job timeout, not one minute.  This contradicts the
   guard header at lines 8-10 (an integer timeout of 1--30) and leaves the
   PIPELINE.md:14 harness budget unenforced.

   Reproduction: the current tree is sufficient: inspect the two harness jobs
   (no `timeout-minutes`) and run `./scripts/check-workflows.sh` (exit 0).
   Removing `timeout-minutes` from any CI job has the same result because of
   `job.get("timeout-minutes", 1)`.  Require the key, and give both harness
   jobs an explicit bound.

## Round-1 findings

- **M1 — fixed.** `.github/workflows/ci.yml` now supplies `ts`, `contracts`,
  `slither`, and `enclave` PR jobs, including lint/typecheck/test and the
  conditional vectors oracle.  The task verification completed locally.
- **M2 — fixed.** `contracts/FOUNDRY_VERSION` is exactly `v1.8.1`, and each
  Foundry CI job validates and consumes that exact value.  The pinned
  nitro-validator checkout is `0ea0d12366b4fa44f9e07e4755f2ad36561cb674`
  (`0ea0d12`).
- **m1 — fixed.** `scripts/check-install-scripts.sh:132-136` fails every
  failed probe install.  In this review its npm fetch failed closed with exit
  1 rather than reporting clean.

## Verification and U8

- `./scripts/check-workflows.sh` passed: `workflows clean`.
- The exact T02 verification command passed: pnpm install, all workspace
  typechecks, Foundry build, and locked Cargo build all exited 0; the final
  submodule line was `0ea0d12`.
- Ten of the fifteen adversary scripts completed successfully, including every
  workflow case and the static manifest/lockfile cases.  The full aggregate
  suite and the direct install-probe command could not complete its isolated
  `npm install pnpm@10.32.1`: this sandbox cannot resolve
  `registry.npmjs.org` (`EAI_AGAIN`) and cannot write npm's usual log path.
  The probe failed closed, as it should.  The prompt records all 15 as passing
  outside this sandbox on `0ebb889`; I did not treat that as local execution
  evidence.
- I inspected the requested scaffold, workflows, guards, adversary tests,
  toolchain pins, submodule SHA, pipeline, ADR-001, and r1 review.  I did not
  inspect environment, npmrc, keystore, or key files; did not make network
  writes, transactions, or source edits outside this review.

U7 finding count: INSIDE 3, OUTSIDE 0 (indicative only; this was not a blind
U1 review).

REVISE: the two security guards do not have an immutable trust boundary, and
the local install proof can certify a different tree from the one installed.
VERDICT: changes required
