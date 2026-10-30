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

## T13 - 2026-10-30
commit: 12ebcca plus regression tests (built 92b8d6c by builder B3, Opus; fixed 607c63d, 12ebcca)
verified: cargo test --locked --manifest-path enclave/Cargo.toml (plus cargo fmt --check and cargo clippy -D warnings)
output:
```
$ cargo test --locked --manifest-path enclave/Cargo.toml
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.86s
     Running unittests src/lib.rs (enclave/target/debug/deps/attessa_enclave-57a590a13d28e182)
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running unittests src/main.rs (enclave/target/debug/deps/attessa_enclave-0dec15182e97fb50)
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
     Running tests/adv_t13.rs (enclave/target/debug/deps/adv_t13-0f8ec4ec24ac18af)
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.88s
     Running tests/adv_t13_r2.rs (enclave/target/debug/deps/adv_t13_r2-bef906bff8f6c4ad)
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
     Running tests/enclave.rs (enclave/target/debug/deps/enclave-b65b32dd7c2684ef)
test result: ok. 19 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.08s
     Running tests/formats.rs (enclave/target/debug/deps/formats-a3fd35297525a34b)
test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.09s
     Running tests/vectors.rs (enclave/target/debug/deps/vectors-19a1e76bb5ba5a03)
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
exit=0
$ cargo fmt --check --manifest-path enclave/Cargo.toml
exit=0
$ cargo clippy --locked --manifest-path enclave/Cargo.toml -- -D warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.06s
exit=0
```
adversary: r1 on 92b8d6c DEFECT (a JSON array was accepted where a struct was expected; fixed 607c63d). r2 on 12ebcca NO DEFECT FOUND; its two regression tests kept as enclave/tests/adv_t13_r2.rs.
reviewed: pending (Codex)
notes: runs the T03 vectors from 705d515 (merged from feat/t03-core). Open: frame size vs a large payTo, NSM error after boot, payer-sig hex case (OPEN-QUESTIONS).
