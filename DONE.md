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

## T20 - 2026-10-30
commit: 9b4290c (builder, Opus; branch feat/t20-buyer-sdk, rerun by lead)
verified: pnpm --filter @attessa/sdk test
output:
```
$ pnpm --filter @attessa/sdk test
 ✓ test/keys.test.ts (7 tests) 83ms
 ✓ test/vectors.test.ts (9 tests) 111ms
 ✓ test/adversary-t20-r3.test.ts (2 tests) 375ms
 ✓ test/adversary-t20.test.ts (3 tests) 426ms
 ✓ test/adversary-t20-r2.test.ts (3 tests) 697ms
 ✓ test/regressions-t20.test.ts (11 tests) 708ms
 ✓ test/refusals.test.ts (30 tests) 729ms
 ✓ test/adversary-t20-r5.test.ts (1 test) 1616ms
 ✓ test/pay.test.ts (9 tests) 1127ms
 ✓ test/outcomes.test.ts (18 tests) 1203ms
 ✓ test/adversary-t20-r6.test.ts (1 test) 1993ms
 ✓ test/proof-checks.test.ts (31 tests) 1791ms
 ✓ test/ledger.test.ts (10 tests) 9709ms
 ✓ test/adversary-t20-r4.test.ts (3 tests) 30168ms
 Test Files  14 passed (14)
      Tests  138 passed (138)
exit=0
```
adversary: rounds 1-6 each found defects (ledger lock races, terminal entries reopened, read-only and umask lock files, refused calls ending uncertain), all fixed with their tests committed; round 7 on 9b4290c: NO DEFECT FOUND (12 real processes x 12 rounds over five starting states: fresh dir under umask 0277, a killed holder's journal, a 0444 lock, old pid-format text under umask 022 and 0277; 0 overlaps, 0 lost writes). Four r3/r4 tests that drove the deleted pid lock through a fake process.kill were retired with Joshua's approval (4a09d04).
reviewed: pending (Codex r1)
notes: the ledger lock is an SQLite BEGIN IMMEDIATE (node:sqlite, Node >= 22.13) that proves its connection writable with a discarded write. Open questions logged: the node:sqlite ExperimentalWarning, a refused result with no code, a lock file owned by another user (refused with an error, untested without root).
