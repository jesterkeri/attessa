# T02 scaffold and CI guards — adversarial review r3

Reviewed frozen `da61075` against `7335c20`, excluding the requested tracking
files.  This is a single-prompt review, so U1/U7 is indicative rather than a
blind measurement: the prompt exposed the earlier findings before the audit.

## Critical

None.

## Major

1. **[INSIDE] M1 is not closed: the proposed CODEOWNERS boundary leaves
   CI-executed toolchain inputs unowned.** `.github/CODEOWNERS:4-11` protects
   workflow YAML and the two guard families, but omits `.nvmrc`,
   `rust-toolchain.toml`, and `contracts/FOUNDRY_VERSION`.  Those files select
   code which the protected workflows execute: respectively
   `.github/workflows/ci.yml:20-24`, `:132-138`, and `:30-37`/`:58-65`.
   Therefore a PR can change a toolchain selection without requiring Joshua's
   code-owner review, while `check-workflows.sh` continues to report clean.
   This is worse than the accepted, logged qualification that the guards are
   review aids: that disposition says code-owner review is the boundary for CI
   and install configuration, but does not make it the boundary for all of the
   configuration that makes CI execute code.

   This breaks PIPELINE.md:50-63's requirement for pinned toolchains and the
   stated M1 disposition in OPEN-QUESTIONS.md:82.  The arbitrary checkout
   itself is expected to run tests, but a PR must not be able to replace the
   pinned interpreter/tool binary outside the designated review boundary.

   Reproduction: on a disposable PR branch, change
   `rust-toolchain.toml` from `channel = "1.98.1"` to `channel = "nightly"`
   (or set `path` to a PR-supplied custom Rust toolchain); alternatively change
   `.nvmrc` or `contracts/FOUNDRY_VERSION` to another valid selector.  Do not
   touch `.github/` or `scripts/`.  `./scripts/check-workflows.sh` still prints
   `workflows clean`; the CODEOWNERS patterns do not match the changed file;
   and the existing CI job resolves and runs the selected toolchain.  Cover
   every CI-executed toolchain/config input with CODEOWNERS (including package
   manifests if they remain installation inputs), or make the workflow guard
   verify the exact pinned contents as part of the code-owner-protected
   boundary.

## Minor

1. **[INSIDE] The required job bounds are present, but the repository's own
   values do not meet the PIPELINE budgets.** `.github/workflows/ci.yml:17,
   :45, :73, :111` set the PR jobs to 8, 8, 6, and 10 minutes; the two harness
   jobs are 2 minutes at `.github/workflows/harness.yml:21,65`.  PIPELINE.md:9-14
   sets the corresponding maximum budgets to 4, 4, 3, 5, and 1 minute.
   `scripts/check-workflows.sh:120-122` only accepts the much broader 1--30
   range, so it accepts this violating repository configuration.

   Reproduction: inspect those `timeout-minutes` values and run
   `./scripts/check-workflows.sh`; it prints `workflows clean`.  The guard must
   either enforce the per-job PIPELINE budgets or the workflow timeouts must be
   brought within them.  Moving slow work to nightly is the specified remedy
   (PIPELINE.md:19).

## Round-2 findings

- **M1 — not fixed.** CODEOWNERS correctly protects the workflow and guard
  files, and the required GitHub ruleset remains an external prerequisite, but
  the omitted CI toolchain selectors above bypass the stated code-owner
  boundary.  The in-repo disposition is consequently incomplete.
- **M2 — fixed.** The probe rejects install-relevant dirty/untracked state,
  validates checkout bytes against HEAD blob IDs, builds its snapshot solely
  from those verified files, and refuses repository configurations that could
  lazily fetch objects before its `ls-tree` reads.  The dirty-checkout,
  `core.worktree`, inherited `GIT_*`, smudge-filter, and promisor/lazy-fetch
  fixtures exercised in this review all refused as intended; I found no way
  for the revised probe to certify a different pnpm tree or execute a program
  from repository-local Git state.
- **m1 — fixed for the finding as reported.** A missing `timeout-minutes` is
  now refused, and both harness jobs declare one.  The separate per-job budget
  violation above remains.

## Verification and U8

- `./scripts/check-workflows.sh` passed: `workflows clean`.
- The exact T02 verify command passed: frozen pnpm install, all workspace
  typechecks, Foundry build, and locked Cargo build; final line `0ea0d12`.
- The aggregate adversary command was run under the requested flock.  The
  timeout, dirty-checkout, `core.worktree`, inherited-Git-environment,
  archive-filter, lazy-fetch, workflow, and static-install cases completed
  successfully.  `install-probe-keytar-dir.sh` and
  `install-probe-pnpmfile.sh` stopped at their lockfile-update setup because
  the sandbox could not resolve the npm registry (`EAI_AGAIN`); this is U8,
  not a finding.
- The direct install probe was also run under flock.  It failed closed before
  the test install with `getaddrinfo EAI_AGAIN registry.npmjs.org`, so I could
  not independently observe its final `ok` output or fully rule out a false
  positive.  Per the review request, the outside-sandbox 021831c evidence in
  DONE.md is recorded as context, not substituted for local execution.
- I inspected the requested diffs/history, guards, workflows, fixtures,
  CODEOWNERS, package/install inputs, TASKS, PIPELINE, THREAT-MODEL, ADR-001,
  SPEC, FLOWS, INVARIANTS, OPEN-QUESTIONS, and the prior review.  I did not
  read environment files, user npm configuration, keystores, or key files;
  made no network writes, transactions, or source edits.

U7 finding count: INSIDE 2, OUTSIDE 0 (indicative only; this was not a blind
U1 review).  The all-inside result is itself a framing warning, not evidence
that the unscoped surface is clean.

REVISE: M1's code-owner disposition is incomplete, and the configured timeouts violate PIPELINE.
VERDICT: changes required
