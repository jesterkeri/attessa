# Done

Append-only. Never edit an entry. One entry per completed task.

Template:

## T00 - YYYY-MM-DD
commit: <sha>
verified: <the exact command that was run>
output:
```
<the real output, pasted, not summarised>
```
reviewed: reviews/gate-N-review.md | verdict: implementation-ready | C0 M1 m3
notes: <anything discovered that changed the design>

The `reviewed:` line is required. Code built by Claude Code is reviewed by Codex,
never by the model that wrote it. If a task genuinely needed no independent review,
write `reviewed: n/a (<why>)` so the decision is visible rather than missing.

---

## T02 - 2026-10-29
commit: bcf393d
verified: pnpm install --frozen-lockfile && pnpm -r typecheck && (cd contracts && forge build) && cargo build --locked --manifest-path enclave/Cargo.toml && git -C contracts/lib/nitro-validator rev-parse --short HEAD
output:
```
Scope: all 6 workspace projects
Lockfile is up to date, resolution step is skipped
Already up to date

╭ Warning ─────────────────────────────────────────────────────────────────────╮
│                                                                              │
│   Ignored build scripts: esbuild@0.28.2.                                     │
│   Run "pnpm approve-builds" to pick which dependencies should be allowed     │
│   to run scripts.                                                            │
│                                                                              │
╰──────────────────────────────────────────────────────────────────────────────╯
Done in 401ms using pnpm v10.32.1
Scope: 5 of 6 workspace projects
packages/cli typecheck$ tsc -p . --noEmit
packages/core typecheck$ tsc -p . --noEmit
packages/gateway typecheck$ tsc -p . --noEmit
packages/sdk typecheck$ tsc -p . --noEmit
packages/sdk typecheck: Done
packages/seller-host typecheck$ tsc -p . --noEmit
packages/cli typecheck: Done
packages/gateway typecheck: Done
packages/core typecheck: Done
packages/seller-host typecheck: Done
Warning: lib/nitro-validator: missing from foundry.lock (found 0ea0d12366b4fa44f9e07e4755f2ad36561cb674)
Nothing to compile
   Compiling attessa-enclave v0.0.0 (/home/hr/myvscode_linux/attessa/enclave)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.81s
0ea0d12
exit 0
```
reviewed: pending (adversary, then Codex; verdict appended as a new entry)
notes: attempt 1 failed (rootDir in the shared tsconfig resolved to the repo root); fixed per package. Rust 1.98.1 pinned; locally it is a hardlink of the installed stable 1.98.1 because the rustup download stalled. esbuild install script is skipped by the pnpm allowlist (only better-sqlite3, keytar may run scripts).

## T02 adversary fix - 2026-10-29
commit: 1eb99f7
findings: (1) AGENTS.md lint failed, no package had a lint script; (2) pnpm 9 ran esbuild postinstall, allowlist only in pnpm-workspace.yaml. Fixed: lint script per package; allowlist moved to package.json pnpm.onlyBuiltDependencies; engines.pnpm >=10.32.1. Probes kept: scripts/check-agents-commands.sh, scripts/check-install-scripts.sh.
verified: ./scripts/check-install-scripts.sh && ./scripts/check-agents-commands.sh && <T02 verify>
output:
```
install refused (exit 1): ok
PASS install
PASS build
PASS test
PASS lint
PASS typecheck
packages/seller-host typecheck: Done
Warning: lib/nitro-validator: missing from foundry.lock (found 0ea0d12366b4fa44f9e07e4755f2ad36561cb674)
Nothing to compile
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.04s
0ea0d12
exit 0
```
reviewed: pending (Codex)
notes: pnpm 10 control (same probe with pnpm@10.32.1) prints PASS. Not fixed (unproven suspicions, logged in task.md): cross-package typecheck needs a build or project references once packages import each other; tests outside src/ are not typechecked; contracts/foundry.lock untracked.

## T02 Codex r1 fixes - 2026-10-30
commit: this entry
review: .worktrees/review-t02-r1/reviews/t02-review-r1.md (VERDICT: changes required, M2 m1)
fixed:
- M2 Foundry pin: contracts/FOUNDRY_VERSION = v1.8.1 (forge 1.8.1, commit 982849d); the proposed ci.yml installs that version.
- m1 scripts/check-install-scripts.sh passes on a failed install only for ERR_PNPM_UNSUPPORTED_ENGINE; any other failure exits 1.
- M1 CI: .github/workflows/ci.yml with the PIPELINE jobs ts, contracts, slither, enclave is proposed in .worktrees/prompts/ci.yml (the guard-edit hook keeps workflow files for Joshua to apply), plus harness-r2.patch removing the duplicate build job from harness.yml.
verified: bash scripts/check-install-scripts.sh (normal) and the same with npm offline and an empty cache
output:
```
$ bash scripts/check-install-scripts.sh
install refused by the engines pin (exit 1): ok
exit=0
$ npm_config_offline=true npm_config_cache=$(mktemp -d) bash scripts/check-install-scripts.sh
FAIL: install failed for another reason (exit 1); no evidence either way:
npm error code ENOTCACHED
exit=1
```
reviewed: pending (Codex r2, after ci.yml is applied)

## T02 Codex r1 fixes: full offline-probe output - 2026-10-30
The entry above abridged the offline run. Verbatim rerun:
```
FAIL: install failed for another reason (exit 1); no evidence either way:
npm error code ENOTCACHED
npm error request to https://registry.npmjs.org/pnpm failed: cache mode is 'only-if-cached' but no cached response is available.
npm error A complete log of this run can be found in: /tmp/tmp.3AKQ57Yn6q/_logs/2026-10-30T09_03_24_882Z-debug-0.log
exit=1
```
reviewed: pending (Codex r2)

## T02 adversary rounds 4-11 - 2026-10-31
Adversary rounds 4 to 10 each found a defect in the two CI guard scripts, each fixed with its test committed under scripts/adversary-t02-r*/ (15 tests, all rc=0 at 0ebb889). Joshua chose allow-lists on 2026-10-30, so scripts/check-workflows.sh and scripts/check-install-scripts.sh now accept only what this repo uses today:
- check-workflows.sh: fixed top-level, trigger, job and step keys; actions pinned by full sha with their current inputs only; `${{ }}` only in env values and a few listed places; `runs-on` exactly ubuntu-latest; checkout with persist-credentials false; bounded timeout-minutes and working-directory.
- check-install-scripts.sh: manifests read as git blobs and must be regular files; no pnpmfile, .npmrc, .gitattributes, .corepack.env, package.yaml/json5 or tracked node_modules; pnpm fixed at 10.32.1 and fetched outside the tree under test; every lockfile resolution a default-registry integrity; allowlisted builds need a pinned integrity.
Two Slither guard changes to ci.yml were applied by Joshua (5c0a049, 8612448). Round 11, on 0ebb889: no defect found.
Verify (TASKS T02) at 0ebb889, 2026-10-31:
```
$ pnpm install --frozen-lockfile && pnpm -r typecheck && (cd contracts && forge build) && cargo build --locked --manifest-path enclave/Cargo.toml && git -C contracts/lib/nitro-validator rev-parse --short HEAD
Done in 359ms using pnpm v10.32.1
typecheck_ok
Nothing to compile
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.01s
0ea0d12
verify_exit=0
```
CI on 0ebb889: ci success, harness success.
reviewed: pending (Codex r2)

## T02 Codex r2 fixes and adversary rounds 12-15 - 2026-11-01
commit: 021831c (this entry adds only DONE.md)
review: reviews/t02-scaffold-and-ci-guards-review-r2.md on 7335c20 (VERDICT: changes required, M1 M2 m1)
fixed:
- M2: scripts/check-install-scripts.sh proves the checkout pnpm installs, not just HEAD. It runs from the repo root (`pwd -P`), git's toplevel must be that folder, every GIT_* variable is unset, and it refuses any .npmrc, pnpmfile or .corepack.env anywhere, and any manifest, lockfile or workspace file that differs from HEAD (9ed70f7, ee53a50). Adversary r12-r14 then showed repo-local git config could redirect or run programs (core.worktree, a git archive smudge filter, a promisor remote's uploadpack); the probe now refuses any extensions.* key, promisor remote, partialclonefilter or non-zero repositoryformatversion before reading any object, never runs archive or cat-file, and hashes each file on disk against the ls-tree blob id (5f642a2, 021831c).
- m1: check-workflows.sh requires timeout-minutes on every job; harness jobs get 2 (9ed70f7, d492d70).
- M1: .github/CODEOWNERS makes Joshua the owner of CI, the guards and the install config; OPEN-QUESTIONS.md records that the guards are a review aid and the boundary is code-owner review in the rulesets (f6f17ff). GitHub's codeowners/errors API reports 0 errors on feat/t02-scaffold.
- Four old workflow fixtures (r4, r5, r6) passed for an unrelated refusal; each is now valid except for its own defect and asserts that single refusal (9639b2e).
adversary: rounds 12, 13 and 14 found a defect each (tests under scripts/adversary-t02-r12..r14); round 15 on 021831c found none.
CI on 021831c: ci success, harness success.
verified (TASKS T02, run at 021831c):
```
$ pnpm install --frozen-lockfile && pnpm -r typecheck && (cd contracts && forge build) && cargo build --locked --manifest-path enclave/Cargo.toml && git -C contracts/lib/nitro-validator rev-parse --short HEAD
Done in 356ms using pnpm v10.32.1
typecheck_ok
Nothing to compile
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.00s
0ea0d12
verify_exit=0
```
guards and the full adversary suite, run outside any sandbox at 021831c under flock:
```
workflows clean
pnpm@10.32.1 install ran no non-allowlisted install script: ok
probe_rc=0
scripts/adversary-t02-codex-r2/check-workflows-timeout-missing.sh rc=0
scripts/adversary-t02-codex-r2/install-probe-dirty-checkout.sh rc=0
scripts/adversary-t02-r10/check-workflows-self-hosted.sh rc=0
scripts/adversary-t02-r10/check-workflows-values.sh rc=0
scripts/adversary-t02-r12/install-probe-core-worktree.sh rc=0
scripts/adversary-t02-r12/install-probe-git-env.sh rc=0
scripts/adversary-t02-r13/install-probe-archive-filter.sh rc=0
scripts/adversary-t02-r14/install-probe-lazy-fetch-tree.sh rc=0
scripts/adversary-t02-r14/install-probe-lazy-fetch.sh rc=0
scripts/adversary-t02-r4/check-workflows-bypass.sh rc=0
scripts/adversary-t02-r4/install-probe-false-clean.sh rc=0
scripts/adversary-t02-r5/check-workflows-injection.sh rc=0
scripts/adversary-t02-r5/install-probe-keytar-dir.sh rc=0
scripts/adversary-t02-r6/check-workflows-docker-args.sh rc=0
scripts/adversary-t02-r6/install-probe-pnpmfile.sh rc=0
scripts/adversary-t02-r7/install-probe-npx-local-bin.sh rc=0
scripts/adversary-t02-r7/install-probe-xdg-config.sh rc=0
scripts/adversary-t02-r7/install-static-nonascii-path.sh rc=0
scripts/adversary-t02-r8/install-probe-manifest-dir.sh rc=0
scripts/adversary-t02-r8/install-static-alt-manifest.sh rc=0
scripts/adversary-t02-r9/install-probe-lockfile-tarball.sh rc=0
scripts/adversary-t02-r9/install-probe-pm-downgrade.sh rc=0
```
reviewed: pending (Codex r3)

## T02 Codex r3 fixes and adversary rounds 16-17 - 2026-11-01
commit: de462b9 (this entry adds only DONE.md)
review: reviews/t02-scaffold-and-ci-guards-review-r3.md on da61075 (VERDICT: changes required, M1 m1; M2 fixed)
fixed:
- M1: .github/CODEOWNERS is one catch-all rule, `* @jesterkeri`, so every CI input (toolchain selectors .nvmrc, rust-toolchain.toml, contracts/FOUNDRY_VERSION, manifests, lockfiles, build config) needs code-owner review; a path list missed what it forgot (0474372). The test requires exactly that one rule (de462b9). GitHub's codeowners/errors API: 0 errors on feat/t02-scaffold.
- m1: check-workflows.sh caps each job's timeout-minutes at its PIPELINE.md budget, looked up by job id and by name with the smaller taken; anything unlisted gets 1 minute (0474372, de462b9). ci.yml timeouts are ts 4, contracts 4, slither 3, enclave 5; harness guardrails and secrets 1 (6d0a037, patch applied by Joshua). Fixtures with made-up jobs moved to 1 minute and still fail only on their own defect.
adversary: round 16 found a defect (a renamed job id escaped its budget; test under scripts/adversary-t02-r16); round 17 on de462b9 found none.
CI on de462b9, all jobs inside the new timeouts: ts success 23s;enclave success 13s;slither success 21s;contracts success 10s;no secrets in client output success 5s;guardrails success 6s;
verified (TASKS T02, run at de462b9):
```
$ pnpm install --frozen-lockfile && pnpm -r typecheck && (cd contracts && forge build) && cargo build --locked --manifest-path enclave/Cargo.toml && git -C contracts/lib/nitro-validator rev-parse --short HEAD
Done in 754ms using pnpm v10.32.1
typecheck_ok
Nothing to compile
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.02s
0ea0d12
verify_exit=0
```
guards and the full adversary suite, run outside any sandbox at de462b9 under flock:
```
workflows clean
pnpm@10.32.1 install ran no non-allowlisted install script: ok
probe_rc=0
scripts/adversary-t02-codex-r2/check-workflows-timeout-missing.sh rc=0
scripts/adversary-t02-codex-r2/install-probe-dirty-checkout.sh rc=0
scripts/adversary-t02-codex-r3/check-workflows-budget.sh rc=0
scripts/adversary-t02-codex-r3/codeowners-covers-everything.sh rc=0
scripts/adversary-t02-r10/check-workflows-self-hosted.sh rc=0
scripts/adversary-t02-r10/check-workflows-values.sh rc=0
scripts/adversary-t02-r12/install-probe-core-worktree.sh rc=0
scripts/adversary-t02-r12/install-probe-git-env.sh rc=0
scripts/adversary-t02-r13/install-probe-archive-filter.sh rc=0
scripts/adversary-t02-r14/install-probe-lazy-fetch-tree.sh rc=0
scripts/adversary-t02-r14/install-probe-lazy-fetch.sh rc=0
scripts/adversary-t02-r16/check-workflows-budget-by-id.sh rc=0
scripts/adversary-t02-r4/check-workflows-bypass.sh rc=0
scripts/adversary-t02-r4/install-probe-false-clean.sh rc=0
scripts/adversary-t02-r5/check-workflows-injection.sh rc=0
scripts/adversary-t02-r5/install-probe-keytar-dir.sh rc=0
scripts/adversary-t02-r6/check-workflows-docker-args.sh rc=0
scripts/adversary-t02-r6/install-probe-pnpmfile.sh rc=0
scripts/adversary-t02-r7/install-probe-npx-local-bin.sh rc=0
scripts/adversary-t02-r7/install-probe-xdg-config.sh rc=0
scripts/adversary-t02-r7/install-static-nonascii-path.sh rc=0
scripts/adversary-t02-r8/install-probe-manifest-dir.sh rc=0
scripts/adversary-t02-r8/install-static-alt-manifest.sh rc=0
scripts/adversary-t02-r9/install-probe-lockfile-tarball.sh rc=0
scripts/adversary-t02-r9/install-probe-pm-downgrade.sh rc=0
```
reviewed: pending (Codex r4)
