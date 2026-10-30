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

## T06 - 2026-10-30
commit: 8ee8186 (builder B1, Opus; branch feat/t06-vectors, rerun by lead)
verified: cd contracts && forge test --match-contract VectorsTest
output:
```
$ cd contracts && forge test --match-contract VectorsTest
No files changed, compilation skipped

Ran 15 tests for test/VectorsTest.t.sol:VectorsTest
[PASS] test_vectors_binding_signer() (gas: 1790017)
[PASS] test_vectors_binding_typehash() (gas: 18777)
[PASS] test_vectors_binding_userData() (gas: 179226)
[PASS] test_vectors_binding_userData_acceptedByRegistry() (gas: 635611)
[PASS] test_vectors_eip712_liveness() (gas: 224650)
[PASS] test_vectors_eip712_proof() (gas: 264624)
[PASS] test_vectors_eip712_signatures() (gas: 860515)
[PASS] test_vectors_eip712_typehashes() (gas: 18753)
[PASS] test_vectors_inputsHash() (gas: 97332)
[PASS] test_vectors_origins_invalid_prefixAndLength() (gas: 404885)
[PASS] test_vectors_origins_valid() (gas: 2370496)
[PASS] test_vectors_releaseId() (gas: 254532)
[PASS] test_vectors_requestHash() (gas: 148486)
[PASS] test_vectors_requestId() (gas: 54355)
[PASS] test_vectors_responseHash() (gas: 56062)
Suite result: ok. 15 passed; 0 failed; 0 skipped; finished in 10.24ms (36.29ms CPU time)

Ran 1 test suite in 11.01ms (10.24ms CPU time): 15 tests passed, 0 failed, 0 skipped (15 total tests)
exit=0
```
adversary: NO DEFECT FOUND (with T07). 21 single-field vector mutations (first and last list entries, typehashes, signer, valid flags, invalid origins) each failed VectorsTest; 3 production mutants (high-s check removed, origin length cap 267 to 268, minimum 9 to 10) each failed it.
reviewed: pending (Codex)
notes: only not_https and length invalid-origin reasons are checkable on chain; the other four are off-chain by design. headers.json is outside T06 scope.

## T07 - 2026-10-30
commit: 8aa7938 (builder B1, Opus; rerun by lead)
verified: cd contracts && forge test --match-test 'test_realFixture' --fork-url $SEP -vvv (SEP=https://forno.celo-sepolia.celo-testnet.org)
output:
```
$ cd contracts && forge test --match-test 'test_realFixture' --fork-url $SEP -vvv   (SEP=https://forno.celo-sepolia.celo-testnet.org)
No files changed, compilation skipped

Ran 3 tests for test/fork/RealFixture.t.sol:RealFixtureTest
[PASS] test_realFixture_a_registerReverts_BindingMismatch0() (gas: 28817506)
[PASS] test_realFixture_b_paddedUnprotectedHeader_sameTbsSameRevert() (gas: 42965196)
Logs:
  unprotected header bytes K: 770

[PASS] test_realFixture_c_validateGas_under16M() (gas: 45904844)
Logs:
  validateAttestationWithHints gas (measured)            : 12994642
  validateAttestationWithHints gas (projected post-Fusaka): 13907842
  registerSigner gas to BindingMismatch (measured)       : 13104719
  registerSigner tx gas (projected post-Fusaka, calldata): 14547623
  hint bytes / MODEXP calls                              : 27312 3044

Suite result: ok. 3 passed; 0 failed; 0 skipped; finished in 7.02s (1.09s CPU time)

Ran 1 test suite in 8.74s (7.02s CPU time): 3 tests passed, 0 failed, 0 skipped (3 total tests)
exit=0
```
adversary: NO DEFECT FOUND. Fixture equals upstream `node tools/nitro_attestation_input.js fixture` at 0ea0d12 byte for byte (4482 bytes, keccak 0x9f0c...0e9f). Padded header is valid CBOR (K=770) through upstream decodeAttestationTbs. 3044 MODEXP calls confirmed by trace; each hits the EIP-7883 500 floor, so +300 per call is exact. Without --fork-url all three SKIP, none pass silently.
reviewed: pending (Codex)
notes: first run of (c) failed on a measurement error (cold SLOADs of test storage inside the measured span), fixed by copying to memory first; no threshold changed. Open: gas headroom about 1.45M (OPEN-QUESTIONS). Adversary suspicions, unproven: the validator in the test is NitroParseHarness (a NitroValidator subclass exposing the parser), not the production bytecode; and in (b) user_data has the wrong length, so the test cannot show the registry ignores a binding planted in the unprotected header. T16b covers the positive real-attestation path.
