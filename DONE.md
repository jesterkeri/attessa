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

## T03 - 2026-10-30
commit: 705d515 (built fd63419 by builder B2, Opus; fixed 705d515)
verified: pnpm --filter @attessa/core test
output:
```

> @attessa/core@0.0.0 test /home/hr/myvscode_linux/attessa/.worktrees/b2-core/packages/core
> vitest run --passWithNoTests


 RUN  v3.2.7 /home/hr/myvscode_linux/attessa/.worktrees/b2-core/packages/core

 ✓ test/regression-t03.test.ts (4 tests) 7ms
 ✓ test/core.test.ts (21 tests) 52ms
 ✓ test/vectors.test.ts (7 tests) 111ms

 Test Files  3 passed (3)
      Tests  32 passed (32)
   Start at  08:47:06
   Duration  630ms (transform 157ms, setup 0ms, collect 766ms, tests 171ms, environment 1ms, prepare 228ms)

exit 0
```
adversary: r1 on fd63419 DEFECT x2 (CheckBidi skipped by Node URL for bidi hosts; UTF-8 BOM accepted before X-Attested-Proof JCS); 120/120 vector values recomputed independently with cast. r2 on 705d515 NO DEFECT FOUND; 124/124 recomputed; 2,130-input TS vs Rust url differential fuzz, no originHash disagreement.
reviewed: pending (Codex)
notes: whatwg-url 14.2.0 (tr46 5.1.1) replaces Node URL for host parsing; requestHash uppercases ASCII only; new vectors for bidi, BOM, non-ASCII method, UTF-16 key order, RFC 8785 Appendix B numbers. Open: Unicode version not pinned, -0 vector, local IP literals, empty labels (OPEN-QUESTIONS).

## T10 Codex review r2 - 2026-10-31
Codex r2 reviewed 515a202: both round-1 majors (M1 identity/Self pins, M2 look-alike validator before broadcast) are fixed, no new findings. Its sandbox blocked the Node/anvil and pre-deploy subprocess checks (U8), so they were run outside it on the same commit, 2026-10-31:
```
scripts/check-deploy.adversary.test.mjs # tests 3
scripts/check-deploy.adversary.test.mjs # fail 0
scripts/check-deploy.adversary2.test.mjs # tests 4
scripts/check-deploy.adversary2.test.mjs # fail 0
scripts/check-deploy.adversary3.test.mjs # tests 2
scripts/check-deploy.adversary3.test.mjs # fail 0
scripts/check-deploy.adversary4.test.mjs # tests 3
scripts/check-deploy.adversary4.test.mjs # fail 0
scripts/check-deploy.adversary5.test.mjs # tests 3
scripts/check-deploy.adversary5.test.mjs # fail 0
scripts/check-deploy.adversary6.test.mjs # tests 3
scripts/check-deploy.adversary6.test.mjs # fail 0
scripts/check-deploy.adversary7.test.mjs # tests 3
scripts/check-deploy.adversary7.test.mjs # fail 0
scripts/check-deploy.adversary8.test.mjs # tests 2
scripts/check-deploy.adversary8.test.mjs # fail 0
scripts/check-deploy.adversary9.test.mjs # tests 3
scripts/check-deploy.adversary9.test.mjs # fail 0
scripts/check-deploy.committed-config.test.mjs # tests 6
scripts/check-deploy.committed-config.test.mjs # fail 0
scripts/check-deploy.test.mjs # tests 11
scripts/check-deploy.test.mjs # fail 0
REF   reference build from HEAD 515a2028a008 and nitro-validator 0ea0d12366b4fa44f9e07e4755f2ad36561cb674
PASS: contracts/out equals the reference build for P384Verifier, CertManager, NitroValidator, EnclaveRegistry, DeployValidatorStack, DeployRegistry
predeploy_exit=0
```
Closing lines of round 2, verbatim:
```
Decision: SHIP
VERDICT: implementation-ready
```
reviewed: reviews/t10-registry-deploy-scripts-review-r2.md | verdict: implementation-ready | C0 M0 m0
note: T10 stays open until Joshua broadcasts the deploy and `node scripts/check-deploy.mjs celo-sepolia` prints OK.
