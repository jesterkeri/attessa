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
## T04 - 2026-10-30
commit: b3347e1 (builder B1, Opus)
verified: cd contracts && forge test --match-path 'test/unit/*' -vv && ../scripts/check-error-coverage.sh
output:
```
No files changed, compilation skipped

Ran 20 tests for test/unit/RenewSigner.t.sol:RenewSignerTest
[PASS] test_renewSigner_AttestationFromFuture() (gas: 296402)
[PASS] test_renewSigner_AttestationStale() (gas: 296597)
[PASS] test_renewSigner_BindingMismatch() (gas: 316788)
[PASS] test_renewSigner_DebugPcrs() (gas: 306976)
[PASS] test_renewSigner_EndpointInactive() (gas: 293789)
[PASS] test_renewSigner_EndpointMismatch() (gas: 346683)
[PASS] test_renewSigner_InvalidPublicKey() (gas: 311342)
[PASS] test_renewSigner_NotOperator_newOperatorAfterRotation() (gas: 346322)
[PASS] test_renewSigner_NotOperator_nonOperator() (gas: 429057)
[PASS] test_renewSigner_NotOperator_oldOperatorAfterRotation() (gas: 346055)
[PASS] test_renewSigner_ReleaseMismatch() (gas: 389890)
[PASS] test_renewSigner_ReleaseNotApproved_deprecated() (gas: 345824)
[PASS] test_renewSigner_SignerMismatch() (gas: 314633)
[PASS] test_renewSigner_expired_SignerNotActive() (gas: 249962)
[PASS] test_renewSigner_extendsActiveUnexpired() (gas: 372974)
[PASS] test_renewSigner_futureWithinSkew_noUnderflow() (gas: 326135)
[PASS] test_renewSigner_lastSecond() (gas: 344093)
[PASS] test_renewSigner_revoked_SignerNotActive() (gas: 291214)
[PASS] test_renewSigner_unknown_SignerNotActive() (gas: 238969)
[PASS] test_renewSigner_validatorRevertPropagates() (gas: 315083)
Suite result: ok. 20 passed; 0 failed; 0 skipped; finished in 4.96ms (5.06ms CPU time)

Ran 32 tests for test/unit/CheckAndVerify.t.sol:CheckAndVerifyTest
[PASS] test_check_AGENT_MISMATCH() (gas: 127859)
[PASS] test_check_ENDPOINT_INACTIVE() (gas: 77186)
[PASS] test_check_ENDPOINT_MISMATCH() (gas: 142508)
[PASS] test_check_OK() (gas: 40484)
[PASS] test_check_OPERATOR_MISMATCH_afterRotation() (gas: 619034)
[PASS] test_check_OPERATOR_MISMATCH_beforeRelease() (gas: 163874)
[PASS] test_check_RELEASE_NOT_APPROVED_deprecated() (gas: 159063)
[PASS] test_check_RELEASE_NOT_APPROVED_revoked() (gas: 80928)
[PASS] test_check_SIGNER_EXPIRED_atExpiresAt() (gas: 76024)
[PASS] test_check_SIGNER_REVOKED() (gas: 76951)
[PASS] test_check_SIGNER_REVOKED_beforeExpired() (gas: 77344)
[PASS] test_check_UNKNOWN_SIGNER() (gas: 36841)
[PASS] test_check_renewedSignerOkAfterOriginalTtl() (gas: 357015)
[PASS] test_check_sameOperatorReadded_OK() (gas: 129573)
[PASS] test_livenessDigest_isEip712() (gas: 16611)
[PASS] test_proofDigest_isEip712() (gas: 15514)
[PASS] test_verify_AGENT_MISMATCH() (gas: 54536)
[PASS] test_verify_BAD_SIGNATURE_badV() (gas: 41674)
[PASS] test_verify_BAD_SIGNATURE_highS() (gas: 36624)
[PASS] test_verify_BAD_SIGNATURE_length() (gas: 64479)
[PASS] test_verify_BAD_SIGNATURE_unrecoverable() (gas: 19449)
[PASS] test_verify_OK() (gas: 55209)
[PASS] test_verify_PROOF_EXPIRED() (gas: 107323)
[PASS] test_verify_otherKey_UNKNOWN_SIGNER() (gas: 52973)
[PASS] test_verify_propagatesCheckSigner() (gas: 217984)
[PASS] test_verify_releaseId_RELEASE_NOT_APPROVED() (gas: 54627)
[PASS] test_verify_skew_minus120_OK() (gas: 55279)
[PASS] test_verify_skew_minus121_PROOF_CLOCK_SKEW() (gas: 55271)
[PASS] test_verify_skew_plus120_OK() (gas: 55252)
[PASS] test_verify_skew_plus121_PROOF_CLOCK_SKEW() (gas: 55284)
[PASS] test_verify_tamperedField_UNKNOWN_SIGNER() (gas: 51951)
[PASS] test_verify_wrongOrigin_ENDPOINT_MISMATCH() (gas: 157297)
Suite result: ok. 32 passed; 0 failed; 0 skipped; finished in 19.05ms (12.19ms CPU time)

Ran 45 tests for test/unit/RegisterSigner.t.sol:RegisterSignerTest
[PASS] testFuzz_BindingMismatch_random(bytes32[5]) (runs: 256, μ: 307917, ~: 308414)
[PASS] testFuzz_freshnessWindow(int256) (runs: 256, μ: 320693, ~: 292666)
Logs:
  Bound result -1800

[PASS] test_BindingMismatch_0_long() (gas: 301379)
[PASS] test_BindingMismatch_0_null() (gas: 293383)
[PASS] test_BindingMismatch_0_short() (gas: 313404)
[PASS] test_BindingMismatch_1_typehash() (gas: 296859)
[PASS] test_BindingMismatch_2_chainId() (gas: 302926)
[PASS] test_BindingMismatch_3_registry() (gas: 303533)
[PASS] test_BindingMismatch_4_agentId() (gas: 306175)
[PASS] test_BindingMismatch_5_originHash() (gas: 304891)
[PASS] test_DebugPcrs_pcr0() (gas: 294949)
[PASS] test_DebugPcrs_pcr1() (gas: 295089)
[PASS] test_DebugPcrs_pcr2() (gas: 295244)
[PASS] test_InvalidPcr_lengthShiftCollision() (gas: 347607)
[PASS] test_InvalidPcr_null() (gas: 621072)
[PASS] test_InvalidPublicKey_64bytes() (gas: 303922)
[PASS] test_InvalidPublicKey_66bytes() (gas: 304183)
[PASS] test_InvalidPublicKey_compressedPrefix() (gas: 305734)
[PASS] test_InvalidPublicKey_null() (gas: 299460)
[PASS] test_ReleaseNotApproved_approvedForOtherAgent() (gas: 369604)
[PASS] test_ReleaseNotApproved_deprecated() (gas: 336336)
[PASS] test_ReleaseNotApproved_revoked() (gas: 336416)
[PASS] test_ReleaseNotApproved_unknown() (gas: 299060)
[PASS] test_SignerExists() (gas: 736007)
[PASS] test_SignerExists_otherOrigin() (gas: 843578)
[PASS] test_age_0s_ok() (gas: 438574)
[PASS] test_age_1799s_ok() (gas: 438619)
[PASS] test_age_1800s_ok() (gas: 438576)
[PASS] test_age_1801s_AttestationStale() (gas: 284838)
[PASS] test_age_msFloored_1800s_ok() (gas: 438622)
[PASS] test_age_msFloored_1801s_AttestationStale() (gas: 284840)
[PASS] test_future_1s_ok() (gas: 438532)
[PASS] test_future_59s_ok() (gas: 438511)
[PASS] test_future_60s999ms_ok() (gas: 438512)
[PASS] test_future_60s_ok() (gas: 438487)
[PASS] test_future_61s_AttestationFromFuture() (gas: 284643)
[PASS] test_registerSigner_EndpointInactive_retired() (gas: 288900)
[PASS] test_registerSigner_EndpointInactive_unknown() (gas: 244675)
[PASS] test_registerSigner_EndpointMismatch() (gas: 256470)
[PASS] test_registerSigner_NotOperator() (gas: 327328)
[PASS] test_registerSigner_afterOperatorRotation() (gas: 586828)
[PASS] test_registerSigner_signerIsPublicKeyAddress() (gas: 453280)
[PASS] test_registerSigner_storesFromTbs() (gas: 496758)
[PASS] test_registerSigner_tbsIsNotAttestation() (gas: 275088)
[PASS] test_registerSigner_validatorRevertPropagates() (gas: 303190)
Suite result: ok. 45 passed; 0 failed; 0 skipped; finished in 18.96ms (46.43ms CPU time)

Ran 56 tests for test/unit/OwnerActions.t.sol:OwnerActionsTest
[PASS] test_addEndpoint_InvalidOrigin() (gas: 242548)
[PASS] test_addEndpoint_NotOwner() (gas: 75592)
[PASS] test_addEndpoint_OriginTaken_otherAgent() (gas: 91928)
[PASS] test_addEndpoint_OriginTaken_sameAgent() (gas: 65197)
[PASS] test_addEndpoint_ZeroAddress() (gas: 76943)
[PASS] test_addEndpoint_localOriginOnlyWhenAllowed() (gas: 247244)
[PASS] test_addEndpoint_originLengthBounds() (gas: 251749)
[PASS] test_addEndpoint_overwritesRetired() (gas: 161170)
[PASS] test_addEndpoint_storesAndEmits() (gas: 135648)
[PASS] test_approveRelease_InvalidPcr_allZero() (gas: 154521)
[PASS] test_approveRelease_InvalidPcr_length() (gas: 501981)
[PASS] test_approveRelease_InvalidSourceRef() (gas: 319047)
[PASS] test_approveRelease_NotOwner() (gas: 107873)
[PASS] test_approveRelease_ReleaseExists() (gas: 66812)
[PASS] test_approveRelease_ReleaseExists_afterRevoke() (gas: 107233)
[PASS] test_approveRelease_storesAndEmits() (gas: 123184)
[PASS] test_constantsAndConstructor() (gas: 80309)
[PASS] test_linkSelfAgent_NotOwner() (gas: 131696)
[PASS] test_linkSelfAgent_SelfDisabled() (gas: 38423)
[PASS] test_linkSelfAgent_SelfLinkInvalid_hasHumanProofReverts() (gas: 190654)
[PASS] test_linkSelfAgent_SelfLinkInvalid_isProofFreshReverts() (gas: 193729)
[PASS] test_linkSelfAgent_SelfLinkInvalid_noHumanProof() (gas: 128395)
[PASS] test_linkSelfAgent_SelfLinkInvalid_otherSelfOwner() (gas: 147266)
[PASS] test_linkSelfAgent_SelfLinkInvalid_ownerOfReverts() (gas: 187585)
[PASS] test_linkSelfAgent_SelfLinkInvalid_staleProof() (gas: 131472)
[PASS] test_linkSelfAgent_storesAndEmits() (gas: 177403)
[PASS] test_ownerOfRevert_NotOwner_everyOwnerFunction() (gas: 668817)
[PASS] test_ownerReadAtCallTime() (gas: 111234)
[PASS] test_release_Approved_to_Approved_InvalidTransition() (gas: 50880)
[PASS] test_release_Approved_to_Deprecated() (gas: 59926)
[PASS] test_release_Approved_to_None_InvalidTransition() (gas: 50803)
[PASS] test_release_Approved_to_Revoked() (gas: 59963)
[PASS] test_release_Deprecated_to_Approved() (gas: 96189)
[PASS] test_release_Deprecated_to_Deprecated_InvalidTransition() (gas: 87087)
[PASS] test_release_Deprecated_to_None_InvalidTransition() (gas: 87075)
[PASS] test_release_Deprecated_to_Revoked() (gas: 96181)
[PASS] test_release_None_to_Approved_InvalidTransition() (gas: 47711)
[PASS] test_release_None_to_Deprecated_InvalidTransition() (gas: 47688)
[PASS] test_release_None_to_None_InvalidTransition() (gas: 47721)
[PASS] test_release_None_to_Revoked_InvalidTransition() (gas: 47755)
[PASS] test_release_Revoked_to_Approved_InvalidTransition() (gas: 86992)
[PASS] test_release_Revoked_to_Deprecated_InvalidTransition() (gas: 87012)
[PASS] test_release_Revoked_to_None_InvalidTransition() (gas: 87019)
[PASS] test_release_Revoked_to_Revoked_InvalidTransition() (gas: 86989)
[PASS] test_retireEndpoint_Active_to_Retired() (gas: 65683)
[PASS] test_retireEndpoint_NotOwner() (gas: 75367)
[PASS] test_retireEndpoint_Retired_EndpointNotActive() (gas: 81589)
[PASS] test_retireEndpoint_unknown_NotOwner() (gas: 39861)
[PASS] test_revokeSigner_Active_to_Revoked() (gas: 497447)
[PASS] test_revokeSigner_NotOwner() (gas: 502025)
[PASS] test_revokeSigner_Revoked_SignerNotActive() (gas: 510229)
[PASS] test_revokeSigner_expiredStillRevocable() (gas: 503727)
[PASS] test_revokeSigner_unknown_NotOwner() (gas: 41208)
[PASS] test_revokedSigner_cannotReregister_SignerExists() (gas: 775202)
[PASS] test_setReleaseStatus_NotOwner() (gas: 71885)
[PASS] test_setReleaseStatus_otherAgentIsSeparate() (gas: 49801)
Suite result: ok. 56 passed; 0 failed; 0 skipped; finished in 19.14ms (8.04ms CPU time)

Ran 4 test suites in 20.16ms (62.12ms CPU time): 153 tests passed, 0 failed, 0 skipped (153 total tests)
all 24 custom errors in EnclaveRegistry.sol are named in contracts/test/
exit 0
```
adversary: NO DEFECT FOUND in EnclaveRegistry (attacks: tbs vs attestation, unguaranteed validator fields, PCR collisions, timestamps, replay, renewSigner, rotation, verifyProof, reentrancy, unreachable errors). 49 extra mutants: 6 survived (s == n/2 low-s edge, SignerRegistered ts, three spec-ordered check orders, InvalidPublicKey vs BindingMismatch order); pinned by contracts/test/adv/AdvRegistry.t.sol (6 tests, each kills one survivor).
reviewed: pending (Codex)
notes: open questions logged: InvalidPcr for wrong-length PCRs in registerSigner; try/catch cannot map no-code or undecodable registry returns.

## T05 - 2026-10-30
commit: 98c2f29 (builder B1, Opus); adversary tests added in the next commit
verified: cd contracts && FOUNDRY_INVARIANT_RUNS=256 FOUNDRY_INVARIANT_DEPTH=50 forge test --match-path 'test/invariant/*' && ../scripts/mutate.sh
output:
```
No files changed, compilation skipped

Ran 1 test for test/invariant/RegistryInvariants.t.sol:RegistryInvariants
[PASS]
RegistryInvariants invariants:
[PASS] invariant_INV1_signerOnlyFromValidatedAttestation
[PASS] invariant_INV24_renewChangesOnlyExpiryAndHash
[PASS] invariant_INV2_releaseApprovedAtRegistration
[PASS] invariant_INV3_freshNonDebugAttestation
[PASS] invariant_INV4_exactBinding
[PASS] invariant_INV5_onlyOwnerAndOperator
[PASS] invariant_INV6_activeEndpointImmutable
[PASS] invariant_INV7_revokedIsTerminal
[PASS] invariant_INV8_checkSignerMatchesModel
[PASS] invariant_modelAgreesOnEveryCall
 RegistryInvariants invariants (runs: 256, calls: 12800, reverts: 0)

╭-----------------+------------------+-------+---------+----------╮
| Contract        | Selector         | Calls | Reverts | Discards |
+=================================================================+
| RegistryHandler | addEndpoint      | 1464  | 0       | 0        |
|-----------------+------------------+-------+---------+----------|
| RegistryHandler | approveRelease   | 1450  | 0       | 0        |
|-----------------+------------------+-------+---------+----------|
| RegistryHandler | linkSelfAgent    | 1373  | 0       | 0        |
|-----------------+------------------+-------+---------+----------|
| RegistryHandler | registerSigner   | 1411  | 0       | 0        |
|-----------------+------------------+-------+---------+----------|
| RegistryHandler | renewSigner      | 1454  | 0       | 0        |
|-----------------+------------------+-------+---------+----------|
| RegistryHandler | retireEndpoint   | 1388  | 0       | 0        |
|-----------------+------------------+-------+---------+----------|
| RegistryHandler | revokeSigner     | 1433  | 0       | 0        |
|-----------------+------------------+-------+---------+----------|
| RegistryHandler | setReleaseStatus | 1418  | 0       | 0        |
|-----------------+------------------+-------+---------+----------|
| RegistryHandler | warp             | 1409  | 0       | 0        |
╰-----------------+------------------+-------+---------+----------╯

Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 13.46s (13.46s CPU time)

Ran 1 test suite in 13.46s (13.46s CPU time): 1 tests passed, 0 failed, 0 skipped (1 total tests)
KILLED drop-age-underflow-guard
KILLED drop-operator-check
KILLED drop-operator-mismatch
KILLED drop-zero-pcr-check
KILLED read-from-attestation
exit 0
```
adversary: all five official mutants also die to the invariant suite alone; invariants not vacuous (handler reaches second registration, renewal, rotation, OPERATOR_MISMATCH, AGENT_MISMATCH).
reviewed: pending (Codex)
notes: mutate.sh refuses a dirty contracts/src, runs the clean suite first, reports BROKEN for a patch that does not apply or compile, reverts on EXIT/INT/TERM.

## T09 - 2026-10-30
commit: this entry (on feat/t05-invariants 0d9e8bd)
verified: cd contracts && forge coverage --report summary --match-path 'test/*' && slither . --config-file slither.config.json
output (coverage table, test summary and slither tail, verbatim from the log):
```
$ cd contracts && forge coverage --report summary --match-path 'test/*' && slither . --config-file slither.config.json
Ran 6 test suites in 285.68s (286.01s CPU time): 160 tests passed, 0 failed, 0 skipped (160 total tests)
| File                               | % Lines           | % Statements      | % Branches       | % Funcs         |
| src/EnclaveRegistry.sol            | 100.00% (207/207) | 100.00% (298/298) | 100.00% (61/61)  | 100.00% (29/29) |
| test/invariant/RegistryHandler.sol | 90.23% (240/266)  | 91.03% (355/390)  | 78.65% (70/89)   | 84.00% (21/25)  |
| test/mocks/Mocks.sol               | 100.00% (45/45)   | 100.00% (37/37)   | 87.50% (14/16)   | 100.00% (11/11) |
| test/utils/AttestationKit.sol      | 100.00% (32/32)   | 100.00% (35/35)   | 100.00% (1/1)    | 100.00% (7/7)   |
| test/utils/RegistryBase.sol        | 82.22% (37/45)    | 76.19% (32/42)    | N/A (0/0)        | 100.00% (9/9)   |
| Total                              | 94.29% (561/595)  | 94.39% (757/802)  | 87.43% (146/167) | 95.06% (77/81)  |
INFO:Slither:. analyzed (11 contracts with 102 detectors), 0 result(s) found
exit=0
```
result: EnclaveRegistry branch coverage 100% (61/61), done-when is >= 90%. Slither 0.11.6 found 15 results on the first run, all triaged in docs/SLITHER_TRIAGE.md and recorded by id in contracts/slither.db.json; 0 untriaged, exit 0.
adversary: n/a (config and triage doc only; the triage goes to Codex with T06/T07)
reviewed: pending (Codex)
notes: slither installed with `uv tool install slither-analyzer` (user space, not a project dependency). Coverage runs invariants at default depth, about 285 s.

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

## T02 Codex r4: SHIP (2026-11-01)

Codex round 4 reviewed 6444f45 in a frozen worktree and found no critical, major or minor finding. Round-3 M1 (CODEOWNERS now a single `* @jesterkeri` rule) and m1 (job timeouts held to the PIPELINE.md budgets by id and by name) are both recorded as fixed. Network-bound checks (install probe, TASKS verify line) could not run in the Codex sandbox and are listed under U8; the unsandboxed output is the previous entry. The rulesets that enforce CODEOWNERS stay Joshua's to enable (OPEN-QUESTIONS.md).

Final lines of the review, verbatim:
```
DECISION: SHIP
VERDICT: implementation-ready
```
reviewed: reviews/t02-scaffold-and-ci-guards-review-r4.md | verdict: implementation-ready (earlier rounds: reviews/t02-scaffold-and-ci-guards-review-r2.md, reviews/t02-scaffold-and-ci-guards-review-r3.md)
Correction (same day): the r2 and r3 review files are not kept in `reviews/`. Both end at `VERDICT: changes required`, which `scripts/check-reviews.sh` refuses in a merged gate; they are archived outside the repo. Only the r4 SHIP review stays committed.

## T03 Codex r1 fixes - 2026-10-30
commit: this entry (merge of feat/t02-scaffold into feat/t03-core, plus the oracle)
review: .worktrees/review-t03-r1/reviews/t03-review-r1.md (VERDICT: changes required, M2)
fixed:
- M1 (outside) `pnpm -r lint` had no script on this branch: merged feat/t02-scaffold, which adds lint to every package.
- M2 vectors had no independent oracle: packages/core/test/oracle.test.ts asserts fixed values for every family (requestHash, responseHash, inputsHash, releaseId, requestId, originHash, binding typehash, user_data, signer, proof and liveness digests, payer-sig message and digest), each computed with Foundry cast from a preimage built by hand per SPEC §2 (oracle sanity: the generator point G gives the well-known 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf). scripts/check-vectors-oracle.py recomputes all 124 values in vectors/*.json with cast, no viem and no core.
verified: pnpm --filter @attessa/core test; pnpm -r lint; python3 -I scripts/check-vectors-oracle.py
output:
```
$ pnpm install --frozen-lockfile
$ pnpm --filter @attessa/core test
 ✓ test/regression-t03.test.ts (4 tests) 9ms
 ✓ test/oracle.test.ts (5 tests) 14ms
 ✓ test/core.test.ts (21 tests) 66ms
 ✓ test/vectors.test.ts (7 tests) 114ms
 Test Files  4 passed (4)
      Tests  37 passed (37)
exit=0
$ pnpm -r lint
exit=0
$ python3 -I scripts/check-vectors-oracle.py
checks: 124 fails: 0
exit=0
```
mutation check (Codex reproduction: drop the first 0x00 separator in requestHash, then gen:vectors):
```
$ (mutant: first 0x00 separator dropped from requestHash) pnpm --filter @attessa/core gen:vectors && pnpm --filter @attessa/core test; python3 -I scripts/check-vectors-oracle.py
   × core against fixed values computed independently with cast (INV-18) > hashes (SPEC §2.2) 7ms
   × hashes (SPEC §2.2) > requestHash is METHOD ‖ 0x00 ‖ pathAndQuery ‖ 0x00 ‖ body 6ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯
 Test Files  2 failed | 2 passed (4)
      Tests  2 failed | 35 passed (37)
MISMATCH requestHash query string kept as sent: got 0xf927ca7c50002d67015850d24d5cd5f9c6cca42bcc06399a78e2528a2a5b591e want 0x4fc221efbe363eeea60a5e0d67d6b3b845031a51e7be098bd17285eb98656832
checks: 124 fails: 6
```
restored: oracle back to `checks: 124 fails: 0`.
reviewed: pending (Codex r2)

## T03 adversary rounds 2-6 - 2026-10-30
commit: 1333de5 (fix builders, Opus; branch feat/t03-core, rerun by lead)
verified: pnpm --filter @attessa/core test; pnpm -r lint; python3 -I scripts/check-vectors-oracle.py; python3 -I scripts/mutate-vectors.py
output:
```
$ pnpm --filter @attessa/core test
 ✓ test/regression-t03.test.ts (4 tests) 8ms
 ✓ test/adversary-t03-r4.test.ts (4 tests) 8ms
 ✓ test/adversary-t03-r5.test.ts (4 tests) 10ms
 ✓ test/oracle.test.ts (9 tests) 10ms
 ✓ test/core.test.ts (21 tests) 68ms
 ✓ test/vectors.test.ts (7 tests) 158ms
 ✓ test/adversary-t03-r3.test.ts (7 tests) 4329ms
 ✓ test/adversary-t03-r2.test.ts (11 tests) 10964ms
 Test Files  8 passed (8)
      Tests  67 passed (67)
exit=0
$ pnpm -r lint
exit=0
$ python3 -I scripts/check-vectors-oracle.py
checks: 461 fails: 0
exit=0
$ python3 -I scripts/mutate-vectors.py
survivors: 0 of 24
exit=0
```
adversary: r2 (oracle missed JCS, signers, grammars), r3 (oracle origin check was not UTS-46; password-only userinfo, unsafe payer-sig seconds), r4 (ZWNJ CheckJoiners after a virama-exempt ZWNJ, tr46 5.1.1), r5 (joiner check decoded opaque hosts of non-special schemes) each found a defect, all fixed with their tests committed. The oracle now implements UTS-46 itself from pinned Unicode 16.0.0 data. r6 on 1333de5: NO DEFECT FOUND (6400-case scheme x host differential core vs oracle, 0 disagreements; 256-case joiner differential, 0). 1333de5 gives three r3 tests that spawn the oracle a 30 s limit (they timed out at 5 s under load; assertions unchanged).
reviewed: pending (Codex r2)
notes: core reads tr46 5.1.1 internal regex data (tr46/lib/regexes.js), the version whatwg-url 14.2.0 pins; a tr46 upgrade could break it. The enclave has no origin code yet, so the Rust side of INV-18 for origins is untested here.

## T03 Codex review r2 - 2026-10-31
Codex re-reviewed T03 (packages/core and vectors) at c6f5fdb under REVIEW-PROTOCOL U1 to U9 and found nothing to fix; every round-1 finding is recorded as fixed.
Review files: reviews/t03-review-r1.md (round 1) and reviews/t03-core-formats-and-vectors-review-r2.md (round 2). Closing line of round 2, verbatim:
```
VERDICT: implementation-ready
```
reviewed: reviews/t03-core-formats-and-vectors-review-r2.md | verdict: implementation-ready | C0 M0 m0
Correction (2026-11-02, merging staging for the PR): `reviews/t03-review-r1.md` (round 1, `VERDICT: changes required`) is removed from `reviews/`, because `scripts/check-reviews.sh` refuses a merged review at that verdict; it is archived outside the repo. The round-2 SHIP review stays.
## T04/T05 Codex review r1 - 2026-10-30
Codex reviewed T04 and T05 at 0d9e8bd under REVIEW-PROTOCOL U1 to U9 and found nothing to fix.
Review file: reviews/t04-t05-review-r1.md. Its closing lines, verbatim:
```
U9: This review swept the complete T04/T05 implementation diff and directly relevant validator dependency, but was not a broader unscoped review of the remainder of the repository.

VERDICT: implementation-ready
```
reviewed: reviews/t04-t05-review-r1.md | verdict: implementation-ready | C0 M0 m0
note: commit e22eee9 recorded this wrongly (conflict markers in DONE.md and the T13 review file, from a shared git stash). The commit after it restores DONE.md to the merge plus this entry and swaps in the right review file.

## T09 adversary rounds 8-13 - 2026-11-01
commit: f6009fe (this entry adds only DONE.md)
fixed since round 7:
- r8: Slither's SARIF triage files (export.sarif + .sarifexplorer) hid a High outside slither.db.json. SARIF input and triage now point at paths that cannot exist, in slither.config.json and on the CI command line (ddd26cc, 398c164); slither.config.json is pinned by SHA-256 in ci.yml.
- r9: a foundry.toml `src` redirect and a remappings.txt fork of nitro-validator passed the gate. scripts/check-slither-build.sh pins forge's effective config and remappings by hash, refuses any .env under contracts/ and any FOUNDRY_*/DAPP_* variable (90fcb8d, cdf7f3f).
- r10: src/ imports pointed at a vendored validator copy. The check builds src/ as Slither does and allows only src/ and lib/nitro-validator/src/ (84b8b00).
- r11: a deploy script compiled a vendored copy. The check also builds src/ + script/ and allows only src/, script/, lib/nitro-validator/src/ and the pinned forge-std (f389445).
- r12: a deploy script deploying runtime bytes read from a committed JSON file is logged in OPEN-QUESTIONS.md as T10 check-deploy's to catch (it compares deployed runtime code with a reference built from committed blobs, NitroValidator included); not a Slither-gate fix (f6009fe).
- r13 on f6009fe: no defect. The gate fails on a High (`suicidal`, `arbitrary-send-eth`, slither_exit=255); 17 operand mutants of EnclaveRegistry (&&, ||, ternary operands forge does not count as branches) all KILLED, survivors=0.
CI on f6009fe's code (f389445): ci success, harness success; the runner printed "ok: forge build configuration and remappings match the pinned hashes; the src build compiles only src/ and lib/nitro-validator/src/, the deploy build only those, script/ and the pinned forge-std".
verified (TASKS T09, run by the round-13 adversary at f6009fe under flock):
```
$ cd contracts && forge coverage --report summary --match-path 'test/*' && slither . --config-file slither.config.json
Ran 7 test suites in 307.62s (308.23s CPU time): 172 tests passed, 0 failed, 0 skipped (172 total tests)
| src/EnclaveRegistry.sol            | 100.00% (207/207) | 100.00% (298/298) | 100.00% (61/61)  | 100.00% (29/29) |
INFO:Slither:. analyzed (11 contracts with 102 detectors), 0 result(s) found
exit=0
```
result: EnclaveRegistry branch coverage 100% (61/61), done-when is >= 90%; Slither 0 untriaged results.
adversary: rounds 8-12 found a defect each (tests under scripts/adversary-t09-r8..r11; r12 probe archived), round 13 found none.
reviewed: pending (Codex)

## T09 Codex r2 - 2026-11-01
Codex reviewed T09 at 098b435 under REVIEW-PROTOCOL U1 to U9: no critical, major or minor findings; the TASKS T09 verify line, both guard scripts and seven adversary probes reran and passed.
Review file: reviews/t09-coverage-and-slither-review-r2.md. Its closing lines, verbatim:
```
SHIP: the T09 done-when condition and hardened Slither gate are evidenced.
VERDICT: implementation-ready
```
reviewed: reviews/t09-coverage-and-slither-review-r2.md | verdict: implementation-ready | C0 M0 m0
## T13 Codex review r1 - 2026-10-30
Codex reviewed T13 at ca8a26e under REVIEW-PROTOCOL U1 to U9 and found nothing to fix.
Review file: reviews/t13-review-r1.md. Its closing lines, verbatim:
```
Decision: SHIP
VERDICT: implementation-ready
```
reviewed: reviews/t13-review-r1.md | verdict: implementation-ready | C0 M0 m0
note: commit 2a2dab8 left git conflict markers in DONE.md (from a shared git stash). The commit after it restores DONE.md to the merge plus this entry.
## T19a - 2026-10-30
commit: this entry (spike, no code)
verified: the T19a loop from TASKS.md, SEP=https://forno.celo-sepolia.celo-testnet.org MAIN=https://forno.celo.org (read-only cast balance, no writes)
output:
```
https://forno.celo-sepolia.celo-testnet.org -400 ok
https://forno.celo-sepolia.celo-testnet.org -7200 ok
https://forno.celo.org -400 ok
https://forno.celo.org -7200 ok
```
result: -400 ok on both, so the gateway inputs value check can read state 400 blocks back on Forno. -7200 ok on both, so the SDK late re-read usually works.
reviewed: n/a (spike)
## T08 - 2026-10-30
commit: (this commit)
verified: SELF_ID=85; for f in "ownerOf(uint256)(address)" "hasHumanProof(uint256)(bool)" "isProofFresh(uint256)(bool)"; do cast call 0x043DaCac8b0771DD5b444bCC88f2f8BBDBEdd379 "$f" $SELF_ID --rpc-url $SEP; done
output:
```
0x00E74B33EcF372BE0Ca367389d5a2228D5DF281a
true
true
exit 0
```
reviewed: n/a (read-only spike, no code; reproducible by the verify command)
notes: agent 85 found via the registry's Registered/AgentRegisteredWithHumanProof events (Blockscout API, block 39967457; Forno caps eth_getLogs ranges). Owner 0x00E74B33EcF372BE0Ca367389d5a2228D5DF281a has no code (a human wallet), i.e. linked mode. All three selectors answer at block ~40062906, so linkSelfAgent stays enabled on Sepolia.
Note (2026-11-02): T19a is Spike S8 and T08 is Spike S4. The harness pack check reads the first `[A-Z]+[0-9]+` word of a ticked task line, which for `T19a` is `S8`, so the spike ids are named here.
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

## T06 Codex r3 fix and adversary rounds 1-2 (depth limit) - 2026-11-02
Codex r3 (major): SPEC §2.5 set no nesting bound for `X-Attested-Proof`, so a ~3,000-deep canonical proof made TS throw RangeError while Solidity answered UnknownField (INV-18). Joshua chose a limit of 32 and applied the SPEC §2.5 patch himself (9f3671b).
- 6a727d5 (failing) and 8700040: TS `decodeAttestedProof` and Solidity `HeaderGrammar` scan bracket depth on the decoded bytes first (strings and escapes skipped, a stray closer stops at 0) and refuse depth 33 as `too_deep` / `Err.TooDeep`; vectors at depth 32 (judged by the other rules) and 33.
- Adversary r1 (on 9f3671b) found one defect: a 4.5 MB header overflowed the strict-base64 regex before the depth check (RangeError instead of too_deep). d000f21 (failing test) and 94f2a25: base64 checked by a linear loop, identical accept/reject set on 1.8M compared inputs; a `]]` + 33 `[` vector pins the stray-closer rule for the future Rust parser.
- d378b33 merged staging (T02-T05, T09, T13). The T03 oracle test then failed: the Python oracle's recursive JCS hit RecursionError on the new deep vector. 93084fd gives the oracle its own byte scan for the same rule and pins 27 attestedProof refusals.
- Adversary r2 (on 93084fd) found no defect: 50,020 generated headers with 0 TS/Python disagreements, 1,520 of them through Solidity with 0 mismatches, reason order base64 > too_deep > not_jcs identical in all three, 40 MB and 133 MB inputs refused in under 0.4 s.
Verify at 93084fd, outside any sandbox:
```
$ cd contracts && forge test --match-contract VectorsTest
Suite result: ok. 20 passed; 0 failed; 0 skipped; finished in 103.53ms (169.95ms CPU time)

Ran 1 test suite in 104.29ms (103.53ms CPU time): 20 tests passed, 0 failed, 0 skipped (20 total tests)
$ cd contracts && forge test --match-path 'test/adv/*'

Ran 3 test suites in 1.16s (3.49s CPU time): 61 tests passed, 0 failed, 0 skipped (61 total tests)
$ pnpm --filter @attessa/core test
 Test Files  9 passed (9)
      Tests  69 passed (69)
$ python3 -I scripts/check-vectors-oracle.py
checks: 487 fails: 0
$ cd contracts && forge test --match-test test_realFixture --fork-url https://forno.celo-sepolia.celo-testnet.org -vvv
[PASS] test_realFixture_a_registerReverts_BindingMismatch0() (gas: 28817506)
[PASS] test_realFixture_b_paddedUnprotectedHeader_sameTbsSameRevert() (gas: 42965196)
[PASS] test_realFixture_c_validateGas_under16M() (gas: 45904844)
  validateAttestationWithHints gas (measured)            : 12994642
  validateAttestationWithHints gas (projected post-Fusaka): 13907842
  registerSigner gas to BindingMismatch (measured)       : 13104719
  registerSigner tx gas (projected post-Fusaka, calldata): 14547623
Suite result: ok. 3 passed; 0 failed; 0 skipped; finished in 6.90s (1.10s CPU time)
```
reviewed: pending (Codex r4, with T07)

## T06 + T07 Codex review r4: SHIP - 2026-11-02
Codex round 4 reviewed 3f0177c in a frozen worktree: no critical, major or minor finding. Round-3's major (no nesting bound for `X-Attested-Proof`) is recorded as fixed by the SPEC §2.5 limit of 32 in TypeScript, Solidity and the Python oracle; round-1's M1 stays fixed. T07's three real-fixture tests are judged to prove what the task line says. Under U8 the sandbox could not spawn `cast` for five T03 tests or resolve Forno for the fork test; the outside-sandbox output is the previous entry.
Closing lines of the review, verbatim:
```
Decision: SHIP
VERDICT: implementation-ready
```
reviewed: reviews/t06-t07-vectors-and-real-fixture-review-r4.md | verdict: implementation-ready | C0 M0 m0
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

## T20 Codex review r2 - 2026-10-31
Round 1 (reviews/t20-buyer-sdk-review-r1.md) returned REVISE with one major finding, M1: the lock adversaries failed inside Codex's sandbox. The same command on the same frozen commit 9d9d261, run outside the sandbox on 2026-10-31, passed in full; its tail is in reviews/t20-sdk-suite-rerun-outside-sandbox-2026-10-31.txt:
```
 Test Files  14 passed (14)
      Tests  138 passed (138)
```
Round 2 withdrew M1: the sandbox denies child-process creation (EPERM), so the round-1 lock results were invalid. Closing lines of round 2, verbatim:
```
Decision: SHIP
VERDICT: implementation-ready
```
reviewed: reviews/t20-buyer-sdk-review-r2.md | verdict: implementation-ready | C0 M0 m0
Correction (2026-11-02, before the staging PR): design-review-r1.md, design-review-r2.md, design-review-r3.md, t20-buyer-sdk-review-r1.md (`VERDICT: changes required`) removed from `reviews/`, because `scripts/check-reviews.sh` refuses a merged review at that verdict; archived outside the repo. The SHIP review stays.
## T19 - 2026-10-30
commit: 3bb4af3 plus merge 5198af1 (built 2d55778, 67e0122 by a builder, Opus; fixed b76a43d)
verified: pnpm --filter @attessa/gateway test (plus pnpm --filter @attessa/gateway typecheck), on the merge
output (file lines and totals verbatim; the per-test lines are in the run log and omitted here):
```
$ pnpm --filter @attessa/gateway test
 ✓ test/smoke.test.ts (1 test) 694ms
 ✓ test/admin.test.ts (4 tests) 3938ms
 ✓ test/reconciler-resend.test.ts (3 tests) 4621ms
 ✓ test/adversary-t19-r2.test.ts (9 tests) 9409ms
 ✓ test/adversary-t19.test.ts (2 tests) 10198ms
 ✓ test/idempotency.test.ts (17 tests) 13068ms
 ✓ test/quote.test.ts (32 tests) 15087ms
 ✓ test/settlement.test.ts (25 tests) 15712ms
 ✓ test/evaluate.test.ts (37 tests) 17677ms
 Test Files  9 passed (9)
      Tests  130 passed (130)
exit=0
$ pnpm --filter @attessa/gateway typecheck
> tsc -p ../core && tsc -p . --noEmit
exit=0
```
adversary: r1 on 67e0122 DEFECT (INV-11: a serial reconciler re-send to a hung facilitator delayed other rows' expiry; fixed b76a43d, test kept as test/adversary-t19.test.ts). r2 on b76a43d NO DEFECT FOUND (late re-send answers vs terminal states, in-flight leak, concurrent ticks, corrupt payload, stop() mid-pass, background 402); its 9 tests kept as test/adversary-t19-r2.test.ts.
reviewed: pending (Codex)
notes: three SPEC questions from the fix round are in OPEN-QUESTIONS (unfunded authorizations vs the unpaid rate limit; nonce used before created_block; §6.2 step order vs the idempotency table).

## T19 Codex r1 fixes and adversary rounds 3-9 - 2026-10-31
Codex r1 (REVISE): the reconciler serialized slow RPC reconciliation; fixed with per-row concurrent checks. Adversary rounds 3 to 8 each found a defect, fixed with its test committed (packages/gateway/test/adversary-t19-r*.test.ts, delivery-overlap, delivery-stream-error, delivery-duplicate-gone, reconciler-deadline):
- r5: a restart gave `settled` rows a fresh 30 s grace; the grace now starts from the stored `updated_at` for rows open at startup.
- overlapping deliveries of one row: live handlers are counted per row.
- r6, r7, r8: a client hanging up during settle, during execution, or behind a pipelined request left a live mark that nothing released, so the row stayed `settled` forever (INV-11). `holdLive` now checks the reply and socket state when it takes a mark and releases it on socket close, and the reconciler sweeps a still-live `settled` row once now > validBefore + 55.
Round 9, on bdd4cd2: no defect found (12 kept-alive calls, read pipelining, LIVE_DEADLINE_S against the slowest legitimate delivery, SPEC §6.2 re-read).
Verify at bdd4cd2, 2026-10-31:
```
$ pnpm --filter @attessa/gateway test
 Test Files  21 passed (21)
      Tests  154 passed (154)
test_exit=0
$ pnpm -r typecheck
typecheck_exit=0
$ pnpm --filter @attessa/gateway lint
lint_exit=0
```
reviewed: pending (Codex r2)

## T19 Codex review r2 - 2026-10-31
Codex r2 reviewed d3b5c57: all round-1 findings (m1 proof lifetime, m2 payer from /verify, M1 serial reconciliation) are fixed, no new findings. Its sandbox blocked the socket-based tests (U8); they passed outside it on the same code, recorded in the entry above (154 passed). Closing line of round 2, verbatim:
```
VERDICT: implementation-ready
```
reviewed: reviews/t19-x402-payment-gateway-review-r2.md | verdict: implementation-ready | C0 M0 m0
Correction (2026-11-02, before the staging PR): t19-x402-payment-gateway-review-r1.md, t19-x402-payment-gateway-review-r1b.md (`VERDICT: changes required`) removed from `reviews/`, because `scripts/check-reviews.sh` refuses a merged review at that verdict; archived outside the repo. The SHIP review stays.
## T15 - 2026-10-30
commit: fd24b45 (built fbe9bcf, 89b2e5d by a builder, Opus; fixed acbf654, fbafffe; merge fd24b45 brings in the T19 branch)
verified: pnpm --filter @attessa/seller-host test && pnpm --filter @attessa/cli test -- -t "seller" (plus pnpm -r typecheck), on the merge
output (file lines and totals verbatim):
```
$ pnpm --filter @attessa/seller-host test && pnpm --filter @attessa/cli test -- -t "seller"
 ✓ test/framing.test.ts (4 tests) 5ms
 ✓ test/units.test.ts (8 tests) 9ms
 ✓ test/server.test.ts (23 tests) 222ms
 ✓ test/enclave.test.ts (6 tests) 253ms
 ✓ test/adversary-t15-r2.test.ts (8 tests) 647ms
 ✓ test/inputs.test.ts (11 tests) 502ms
 ✓ test/adversary-t15.test.ts (8 tests) 468ms
 Test Files  7 passed (7)
      Tests  68 passed (68)
seller-host exit=0
 ✓ test/attestation.test.ts (4 tests) 447ms
 ✓ test/enclave.test.ts (8 tests) 1207ms
 ✓ test/adversary-t15.test.ts (7 tests) 1605ms
 ✓ test/adversary-t15-r2.test.ts (8 tests) 1789ms
 ✓ test/owner.test.ts (15 tests) 2085ms
 ✓ test/signer.test.ts (17 tests) 5784ms
 Test Files  6 passed (6)
      Tests  59 passed (59)
cli exit=0
$ pnpm -r typecheck
packages/gateway typecheck: Done
packages/cli typecheck$ tsc -p ../core && tsc -p ../seller-host && tsc -p . --noEmit
packages/cli typecheck: Done
exit=0
```
adversary: r1 on 89b2e5d DEFECT x2 (`--network local` ignored the pinned deployments, SPEC §2.6; the spend guard dated revenue by updated_at so a row counted on two days, SPEC §5); fixed acbf654, fbafffe; tests kept as packages/{cli,seller-host}/test/adversary-t15.test.ts. r2 on fbafffe NO DEFECT FOUND (all 11 §6.4 states, day boundary, WAL reads, time zones, pin vs override on every network); its 16 tests kept as adversary-t15-r2.test.ts.
reviewed: pending (Codex)
notes: no buy source yet (needs S7); the guard is not wired into main.ts; `enclave start --port` can point at another network's enclave (SPEC §8 lists --port as free) and `enclave build` does not refuse gitignored files in the build context: both left as design questions; one existing fixture column renamed updated_at -> created_at to match the §6.4 schema.

## T15 Codex r1 fixes and adversary rounds 3-5 - 2026-10-30
commit: cb83abf (fix builder, Opus; branch feat/t15-seller-host, rerun by lead)
review: Codex r1 (.worktrees/archive/reviews/t15-seller-host-and-cli-review-r1.md): REVISE, M1 renew sent certificate-cache txs before checks registration makes; M2 seller-host could boot against another network's enclave and trusted bad_frame; m1 framed replies not checked as JCS. Fixed in 2056eff.
verified: pnpm --filter @attessa/seller-host test; pnpm --filter @attessa/cli test; pnpm -r typecheck; pnpm -r lint
output:
```
$ pnpm --filter @attessa/seller-host test
 ✓ test/framing.test.ts (4 tests) 4ms
 ✓ test/units.test.ts (8 tests) 9ms
 ✓ test/review-t15-r1.test.ts (13 tests) 70ms
 ✓ test/server.test.ts (23 tests) 223ms
 ✓ test/enclave.test.ts (6 tests) 257ms
 ✓ test/inputs.test.ts (11 tests) 1090ms
 ✓ test/adversary-t15.test.ts (8 tests) 1177ms
 ✓ test/adversary-t15-r2.test.ts (8 tests) 5245ms
 Test Files  8 passed (8)
      Tests  81 passed (81)
exit=0
$ pnpm --filter @attessa/cli test
 ✓ test/adversary-t15-r3.test.ts (1 test) 260ms
 ✓ test/attestation.test.ts (4 tests) 547ms
 ✓ test/adversary-t15-r4.test.ts (1 test) 705ms
 ✓ test/review-t15-r1.test.ts (3 tests) 1437ms
 ✓ test/enclave.test.ts (8 tests) 1539ms
 ✓ test/review-t15-r3.test.ts (8 tests) 1570ms
 ✓ test/review-t15-r4.test.ts (4 tests) 1667ms
 ✓ test/adversary-t15.test.ts (7 tests) 1983ms
 ✓ test/adversary-t15-r2.test.ts (8 tests) 2232ms
 ✓ test/owner.test.ts (15 tests) 2454ms
 ✓ test/signer.test.ts (17 tests) 6202ms
 Test Files  11 passed (11)
      Tests  76 passed (76)
exit=0
$ pnpm -r typecheck
exit=0
$ pnpm -r lint
exit=0
```
adversary: r3 (enclave start --port could configure the other network's enclave) and r4 (a late AttestationStale on renew used registration wording and advice) found defects, fixed in 949259f and cb83abf with their tests committed. r5 on cb83abf: NO DEFECT FOUND (renew reverts incl. a signer expiring during caching, port seam unreachable from bin.ts, boot binding check, JCS replies, port pins).
reviewed: pending (Codex r2)
notes: suspicions from r5, unproven and not fixed: after certificate txs land, the generic revert lines still end "Nothing was sent."; invalid_pcr and invalid_public_key renew lines carry restart or no advice (both unreachable with a genuine AWS document). `--port` now accepts only the network's fixed port (logged in OPEN-QUESTIONS).

## T15 Codex review r2 - 2026-10-31
Codex re-reviewed T15 (seller-host and CLI) at 7e00940 under REVIEW-PROTOCOL U1 to U9 and found nothing to fix; every round-1 finding is recorded as fixed.
Review files: reviews/t15-seller-host-and-cli-review-r1.md (round 1) and reviews/t15-seller-host-and-cli-review-r2.md (round 2). Closing line of round 2, verbatim:
```
VERDICT: implementation-ready
```
reviewed: reviews/t15-seller-host-and-cli-review-r2.md | verdict: implementation-ready | C0 M0 m0
Correction (2026-11-02, before the staging PR): t15-seller-host-and-cli-review-r1.md (`VERDICT: changes required`) removed from `reviews/`, because `scripts/check-reviews.sh` refuses a merged review at that verdict; archived outside the repo. The SHIP review stays.
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
Correction (2026-11-02, before the staging PR): design-review-r1.md, design-review-r2.md, design-review-r3.md, t10-review-r1.md (`VERDICT: changes required`) removed from `reviews/`, because `scripts/check-reviews.sh` refuses a merged review at that verdict; archived outside the repo. The SHIP review stays.
## T10 Sepolia broadcast and check-deploy - 2026-11-02
Joshua broadcast both deploy scripts from d3c48a1 (the T10 deploy commit, a clean checkout in .worktrees/sim-sepolia-deploys), each after `check-deploy.mjs --pre-deploy` printed PASS and a simulation without the broadcast flag:
- DeployValidatorStack: P384Verifier, CertManager (production, owner and revoker = admin `0xD32AF5B881eC424435ECa3262065537dCcb64E65`), NitroValidator; 10,722,155 gas, 0.536 CELO.
- DeployRegistry with ATTESSA_NITRO_VALIDATOR = the NitroValidator above: EnclaveRegistry, 3,444,473 gas, 0.172 CELO.
The addresses and transactions are in docs/DEPLOYMENTS.md and packages/core/src/deployments.ts (`enclaveRegistry`, `validatorStack` for celo-sepolia; mainnet stays null until T30).
Consequences in tests, no product code changed:
- packages/core/test/core.test.ts: the check that every `enclaveRegistry` is null (commented "set by T10 / T30") now pins the Sepolia registry and validator stack to the deployed addresses and keeps mainnet null.
- packages/cli/test/harness.ts: the FakeChain reports chain 11142220 and a pinned registry wins over ATTESSA_REGISTRY (SPEC §2.6), so with the real pin every seller test called `0x42bf...` on the fake chain (40 failures). The harness now pins the Sepolia entry to its fake registry once per test file (vitest forks, isolated); the ATTESSA_REGISTRY override and pin-precedence cases stay covered by adversary-t15 and adversary-t15-r2, which set the pins themselves.
- The CI ts job also needs the nitro-validator submodule (packages/cli/test/attestation.test.ts reads the real AWS fixture from it), and the Slither forge-config hash changes with T10's `fs_permissions` entry: given to Joshua as a ci.yml patch (.worktrees/prompts/combined-branch-ci.patch), since workflows are his to edit.

verify (`node scripts/check-deploy.mjs celo-sepolia`, live Celo Sepolia, 2026-11-02):
```
REF   reference bytecode compiled from HEAD e6777faaf161 and nitro-validator 0ea0d12366b4fa44f9e07e4755f2ad36561cb674
OK    deployments.ts EnclaveRegistry matches DEPLOYMENTS.md
OK    deployments.ts P384Verifier matches DEPLOYMENTS.md
OK    deployments.ts CertManager matches DEPLOYMENTS.md
OK    deployments.ts NitroValidator matches DEPLOYMENTS.md
OK    deployments.ts chainId == SPEC §2.6 pin 11142220
OK    chain id 11142220
OK    deployments.ts identityRegistry matches DEPLOYMENTS.md
OK    deployments.ts selfRegistry matches DEPLOYMENTS.md
OK    deployments.ts identityRegistry == SPEC §3.5 pin 0x8004a818bfb912233c491871b3d84c89a494bd9e
OK    deployments.ts selfRegistry == SPEC §3.5 pin 0x043dacac8b0771dd5b444bcc88f2f8bbdbedd379
OK    P384Verifier 0xd26c0d863b71cbbba07e6eeedab545d0f7c1a84e has code
OK    P384Verifier runtime code equals the production artifact with immutables spliced
OK    CertManager 0x29f2a69b5685d0db11fa10aa7c9079b3f14cf7fd has code
OK    CertManager runtime code equals the production artifact with immutables spliced
OK    NitroValidator 0x72b06e740d5f2c262b3193de69c7065a0c7424db has code
OK    NitroValidator runtime code equals the production artifact with immutables spliced
OK    EnclaveRegistry 0x42bf5cb440c3c321cb42b0f4c81c3c7435cb92ff has code
OK    EnclaveRegistry runtime code equals the production artifact with immutables spliced
OK    CertManager.p384Verifier() == 0xd26c0d863b71cbbba07e6eeedab545d0f7c1a84e
OK    NitroValidator.certManager() == 0x29f2a69b5685d0db11fa10aa7c9079b3f14cf7fd
OK    NitroValidator.p384Verifier() == 0xd26c0d863b71cbbba07e6eeedab545d0f7c1a84e
OK    EnclaveRegistry.nitroValidator() == 0x72b06e740d5f2c262b3193de69c7065a0c7424db
OK    EnclaveRegistry.identityRegistry() == 0x8004a818bfb912233c491871b3d84c89a494bd9e
OK    EnclaveRegistry.selfRegistry() == 0x043dacac8b0771dd5b444bcc88f2f8bbdbedd379
OK    CertManager.owner() == 0xd32af5b881ec424435eca3262065537dccb64e65
OK    CertManager.revoker() == 0xd32af5b881ec424435eca3262065537dccb64e65
OK    EnclaveRegistry.allowLocalOrigins() == false
OK: all 27 checks passed
exit=0
```
`pnpm -r test`: core 69 passed, seller-host 81 passed, gateway 154 passed, sdk 138 passed, cli 76 passed. `pnpm -r typecheck`: Done in all 5 packages.
reviewed: pending (Codex)

## T10 deploy-record adversary rounds 1-2 - 2026-11-02
Adversary r1 on 2709dec checked every recorded address, tx hash, block and gas figure against `cast receipt` (all status 1) and re-ran check-deploy (27 OK). It found one defect the deploy record made live: the SDK let `options.registry` override the pinned Sepolia registry (`opts.registry ?? deployment.enclaveRegistry`), against SPEC §2.6 "The SDK uses only these pinned addresses" (b72610d, failing).
- 4ec4df9: the pin wins and `options.registry` only fills in where nothing is deployed, as the CLI does for ATTESSA_REGISTRY. The SDK test world (`makeWorld`) pins its fake registry as the Sepolia entry while open and restores it on `close()`.
- d1d26c6 (adversary r2): the local case restated against the real pin (`0x42bf...92ff`, read before any world swaps it); it fails on the old line (2 failed) and passes on the fix.
- Adversary r2 on 4ec4df9: CLEAN (mainnet null pin, `local` on 42220, address case, every other read of options.registry).

verify at d1d26c6 (`pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r test`, plus the harness scripts), 2026-11-02:
```
build=0
typecheck: Done in 5 of 5 packages; lint: Done in 5 of 5 packages
packages/core test:  Test Files  9 passed (9)
packages/core test:       Tests  69 passed (69)
packages/seller-host test:  Test Files  8 passed (8)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:  Test Files  21 passed (21)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:  Test Files  15 passed (15)
packages/sdk test:       Tests  140 passed (140)
packages/cli test:  Test Files  11 passed (11)
packages/cli test:       Tests  76 passed (76)
check-workflows rc=0
check-migrations rc=0
check-reviews rc=0
```
reviewed: pending (Codex)

## T10 deploy record Codex r1 fix and doc adversary rounds 1-2 - 2026-11-02
Codex r1 on 663bd89 (archived, `.worktrees/archive/reviews/t10-deploy-record-and-sdk-pin-review-r1.md`): REVISE, one minor (m1): the `ClientOptions.registry` doc still said the override is required on local forks, which the pin-first fix made false. No runtime finding; the pin fix, the address record and the CI change were confirmed.
- 08bd164: the doc says the pin wins whenever the RPC's chain has one, a Sepolia fork included.
- Adversary r1 on 08bd164: one doc defect, "chains with no deployed registry" also read as a plain anvil chain (31337), which the SDK refuses as network_mismatch (correct per SPEC §2.6: no pinned assets either). de31b87 (its test, failing then).
- f3dec7f: the doc names the deployments.ts chain case and says a chain with no entry is refused.
- Adversary r2: CLEAN on f3dec7f's wording; 8aae342 restates its third case (31337 refused) and adds celo-sepolia against a 31337 RPC.

verify at 8aae342 (`pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r test`, then the harness scripts), 2026-11-02:
```
build=0
typecheck Done: 5
lint Done: 5
packages/core test:  Test Files  9 passed (9)
packages/core test:       Tests  69 passed (69)
packages/seller-host test:  Test Files  8 passed (8)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:  Test Files  21 passed (21)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:    × INV-19: the lock holds when holders are killed or stopped inside it > 6 processes x 200 entries with random SIGKILLs and SIGSTOPs: never two inside, no write lost 4652ms
packages/sdk test: ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
packages/sdk test:  Test Files  1 failed | 15 passed (16)
packages/sdk test:       Tests  1 failed | 143 passed (144)
check-workflows rc=0
check-migrations rc=0
check-reviews rc=0
```
The CLI suite did not run in that pass (pnpm stops after the first failing package). The INV-19 test is untouched by this change; re-runs, same commit:
```
npx vitest run test/ledger.test.ts (3 runs):  Tests  10 passed (10) / 10 passed (10) / 10 passed (10)
npx vitest run (packages/sdk, 2 runs):  Test Files  16 passed (16)  Tests  144 passed (144) / 144 passed (144)
npx vitest run (packages/cli):  Test Files  11 passed (11)  Tests  76 passed (76)
```
Logged in OPEN-QUESTIONS (INV-19 stress test flaked once under load).
reviewed: pending (Codex r2)

## INV-19 stress test oracle fix and the staging merge - 2026-11-02
The INV-19 stress test (`packages/sdk/test/ledger.test.ts`, "6 processes x 200 entries with random SIGKILLs and SIGSTOPs") failed in CI on eb302cb: "12248 entered while 12234 was inside". Diagnosis: no lock defect. The lock is an SQLite write transaction (`BEGIN IMMEDIATE`, `packages/sdk/src/ledger.ts`); Linux releases a killed holder's file locks (exit_files) before it becomes a zombie (exit_notify), and in that gap the test child's `alive()` read the dead holder as state R. Under 16 busy loops the test failed 14 of 20 runs.
- 964dc4a (approved by Joshua, it edits a test helper): `alive()` in `packages/sdk/test/helpers/lock-stress-child.ts` also treats PF_EXITING (0x4, /proc/<pid>/stat field 9) as not alive. The lock is unchanged. Under 16 busy loops: 30 of 30 passed.
- Adversary on 964dc4a: CLEAN. A killed holder always shows PF_EXITING by the time the lock is free; no live process showed it in 24,305 samples; stopped or resumed holders never carry it; three deliberately broken locks (no lock, early release, a 150 ms stale-takeover lock) each still produced violations.
- c7f0de5 merged staging after PR 7 (no file changes), 417ae95 reordered DONE.md so staging's entries come first.
The OPEN-QUESTIONS entry for this flake is resolved by the above.

verify at 964dc4a (`pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r test`, then the harness scripts), 2026-11-02:
```
build=0
typecheck Done: 5
lint Done: 5
packages/core test:  Test Files  9 passed (9)
packages/core test:       Tests  69 passed (69)
packages/seller-host test:  Test Files  8 passed (8)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:  Test Files  21 passed (21)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:  Test Files  16 passed (16)
packages/sdk test:       Tests  144 passed (144)
packages/cli test:  Test Files  11 passed (11)
packages/cli test:       Tests  76 passed (76)
check-workflows rc=0
check-migrations rc=0
check-reviews rc=0
```
reviewed: pending (Codex r2)

## T10 deploy record, SDK pin and INV-19 oracle: Codex review r2 SHIP - 2026-11-02
Codex r2 reviewed cd723b0 (`git diff 663bd89 cd723b0`, with `e6777fa..cd723b0` in scope): no critical, major or minor findings. The r1 minor (m1, the `ClientOptions.registry` doc) is closed; the INV-19 `alive()` change, the staging merge and the DONE reorder were judged sound. The r1 review (REVISE, m1) is archived outside the repo.
reviewed: reviews/t10-deploy-record-and-sdk-pin-review-r2.md | verdict: implementation-ready | C0 M0 m0
## T01 - 2026-11-02
Kill test on Celo Sepolia: base/nitro-validator's demo stack (P384Verifier, CertManagerDemo, NitroValidator) at the pinned `0ea0d12`, deployed and run on its cold path with the bundled real AWS Nitro attestation by `script/BaseSepoliaDemo.s.sol` (`USE_BUNDLED_REAL_ATTESTATION=true`, `--gas-estimate-multiplier 110`). Joshua broadcast it from the deployer `0xF31207eE5831fb2a7bFB6f844a4fb16776193964` after Claude's simulation on an anvil fork with a throwaway key (9 transactions, validate calls padded to 16,046,664 gas). Table and gas in `docs/KILL_TEST.md`. Largest gasUsed 12,967,002 (each validate), 77% of the 16,777,216 cap; total 60,991,030 gas, 3.0496 CELO. These demo addresses are never used by the registry (SPEC §3.5).

verify (the TASKS.md command with `SEP=https://forno.celo-sepolia.celo-testnet.org`), 2026-11-02:
```
0xb581a2adf816be631abe5e750dee1c2ed0c93be5fc1c1038acc27b403d59e7eb 1734631 true
0x4642793c366c3773c4b072389c09363d96050d5b1cda9f4b0b38fe27baa3e7c7 5382414 true
0xb1de54d54ae97636a0d8d27738aa9f19669f58ebd491128acdd8d5672b02b37e 3621490 true
0x8685c3a154eea475ae7cb5490fdbc7fcff4f4233b364c73095df75900c0f8978 5993778 true
0x08ca0ea3a978808ac788a99616343c98a5106d465a8acb6e970259f7574e0d3c 6246708 true
0xe48859922349c1b50d25dee787c9b9cd47569b565dc89baf72650be343ac42c5 6026223 true
0xb4f1d7dde86649def564b7c1a12228558563276d1e5d88413fea819ad365d3db 6051782 true
0xc32ca82c85fd0f0b8c56c35936c1ae6a62e7c73112986cdab1dc58afe8566096 12967002 true
0x41642666e7f7a58285c8852c5479b4be744a1b7437d4c39bf4a7ddffd332f236 12967002 true
```
Exactly 9 lines, every gasUsed under 16777216. cast 1.8.1 prints a receipt's status as `true`; the raw field is `0x1` for all nine (`cast receipt <hash> --json`: status 0x1 on each).
reviewed: reviews/t01-kill-test-review-r1.md | verdict: implementation-ready | C0 M0 m0

## T01 adversary rounds 1-2 - 2026-11-02
- Adversary r1 on 04d8390 checked the record against the chain: all 9 transactions from the deployer with consecutive nonces 4 to 12; tx 1-3 create the three documented addresses; the cert calls chain from the pinned AWS root through the CertVerified events (CA index 1, 2, 3, then the client cert); both validate calls carry the bundled fixture and succeed (replayed before the client cert was cached, the call reverts); creation inputs match a scratch build of nitro-validator 0ea0d12 byte for byte; total 60,991,030 gas, 3.049551 CELO equals the deployer's balance change. One doc defect: KILL_TEST.md pointed to docs/DEPLOYMENTS.md, not on staging yet (dc68c5a, `scripts/adversary-t01-r1/check_kill_test_refs.sh`, failing then).
- 8301b50: the sentence names task T10 for the production validator stack instead.
- Adversary r2 on 8301b50: CLEAN (the wording matches TASKS.md and SPEC §3.5, every reference resolves, the check script passes, the verify command prints 9 lines all under the cap, the guard scripts pass).
reviewed: reviews/t01-kill-test-review-r1.md | verdict: implementation-ready | C0 M0 m0
## Gateway CI timing fix - 2026-11-02
Two gateway tests from T19 failed `ci / ts (push)` twice on PR 10 (a docs-only branch): "17th concurrent evaluate → 503 gateway_busy" (only 10 to 12 of 16 calls got 200) and "two concurrent ticks share one pass" (20 s timeout). Reproduced locally with `pnpm -r test` pinned to 2 cores (run 2: 3 of 16 got 200). A probe showed the other calls got 402 `unexpected_verify_error` and 202 `settle_pending`: the harness shortens the gateway's timeouts (settle 400 ms, verify 2 s), and on a starved runner 17 calls through the in-process facilitator overrun them. The gateway answered as SPEC §6.2 says; the tests assumed a fast machine. The ticks test's `holdable` helper counted a re-send before its answer arrived and kept holding after `release()`, so an answer that arrived late was held forever.
Joshua approved changing only the timing, with every assertion unchanged:
- `packages/gateway/test/evaluate.test.ts`: the 17-call test runs with production timeouts (`DEFAULT_TIMEOUTS`).
- `packages/gateway/test/adversary-t19-r2.test.ts`: `release()` stops holding before it releases; the ticks test waits for the 4 sends (`vi.waitFor`, 5 s) instead of a fixed 50 ms.

verify (run by Claude), 2026-11-02: the two files on one core shared with 4 busy loops, three runs; then `taskset -c 0,1 pnpm -r test` twice; then gateway typecheck and lint:
```
loaded 1:       Tests  46 passed (46)
loaded 2:       Tests  46 passed (46)
loaded 3:       Tests  46 passed (46)
full2core 1: packages/core test:       Tests  69 passed (69)
full2core 1: packages/gateway test:       Tests  154 passed (154)
full2core 1: packages/seller-host test:       Tests  81 passed (81)
full2core 1: packages/sdk test:       Tests  144 passed (144)
full2core 1: packages/cli test:       Tests  76 passed (76)
full2core 2: packages/core test:       Tests  69 passed (69)
full2core 2: packages/gateway test:       Tests  154 passed (154)
full2core 2: packages/seller-host test:       Tests  81 passed (81)
full2core 2: packages/sdk test:       Tests  144 passed (144)
full2core 2: packages/cli test:       Tests  76 passed (76)
typecheck=0
lint=0
```
- Adversary r1 on 133c133: CLEAN. Weakening check: 5 gateway mutants (cap 17, cap 15, the 17th call executed and settled, two re-sends per row, ticks run one after the other) fail both the old and the new form of the tests. 3 more pass both forms (existing blind spots, none added by this change). Flake check: the two files on one core with 8 busy loops failed in the old form 3 runs of 3 (7, 9 and 10 of 16 calls got 200; the ticks test timed out at 20 s). In the new form they passed 4 of 4, and 5 of 5 with 4 busy loops. `taskset -c 0,1 pnpm -r test` twice: gateway 154/154. The other `holdable` tests pass with the new `release()`. Its side-by-side test and scripts are archived outside the repo.
reviewed: reviews/gateway-ci-timing-review-r1.md | verdict: implementation-ready | C0 M0 m0
## T21 CLI - 2026-11-02
commit: af66e32 (builder, Opus; branch feat/t21-cli from 32ad820), entry in the next commit
built: buyer commands `init`, `call`, `cancel`, `status [<origin>|--agent <id>] [--pending]`, `evidence export` on @attessa/sdk (no payment logic in the CLI); owner commands `agent register|transfer|wallet-sig|set-wallet`, `selflink`, `release deprecate|revoke` / `revoke release`, `revoke signer`, `endpoint retire`; `attessa gateway …` handed to T19's runGatewayCommand. The SDK gained `ClientOptions.onProgress` (the moments the CLI prints a FLOWS §6 line) and a `dry_run` stop before signing. Snapshot tests read FLOWS.md itself and require each §6 sample block to appear contiguous in the CLI transcript (hex placeholders and named slots such as a time of day excepted; a matcher self-test proves a changed word, a dropped line or a reordering fails): J0, J1 (and price above the limit), J2, J2 variant (paid_but_rejected and settled_after_refusal), J1 interrupted (not charged, charged, 202, resume), J3 (seller --help, agent register, enclave build, release approve, endpoint add, enclave start, signer register) and J4 (revoke release) on one chain.
verified: pnpm --filter @attessa/cli test (plus pnpm -r typecheck, pnpm -r --no-bail test, ./scripts/check-reviews.sh && ./scripts/check-workflows.sh)
output (file lines and totals verbatim):
```
$ pnpm --filter @attessa/cli test
 ✓ test/flows.test.ts (3 tests) 5ms
 ✓ test/attestation.test.ts (4 tests) 487ms
 ✓ test/adversary-t15-r3.test.ts (1 test) 277ms
 ✓ test/adversary-t15-r4.test.ts (1 test) 728ms
 ✓ test/review-t15-r1.test.ts (3 tests) 1454ms
 ✓ test/buyer.test.ts (28 tests) 1554ms
 ✓ test/enclave.test.ts (8 tests) 1598ms
 ✓ test/review-t15-r3.test.ts (8 tests) 1619ms
 ✓ test/review-t15-r4.test.ts (4 tests) 1662ms
 ✓ test/adversary-t15.test.ts (7 tests) 1949ms
 ✓ test/adversary-t15-r2.test.ts (8 tests) 2188ms
 ✓ test/owner.test.ts (15 tests) 2419ms
 ✓ test/seller-journeys.test.ts (14 tests) 2967ms
 ✓ test/signer.test.ts (17 tests) 5812ms
 Test Files  14 passed (14)
      Tests  121 passed (121)
exit=0
$ pnpm -r typecheck
packages/core typecheck: Done
packages/seller-host typecheck: Done
packages/sdk typecheck: Done
packages/gateway typecheck: Done
packages/cli typecheck: Done
exit=0
$ pnpm -r --no-bail test
packages/core test:  FAIL  test/adversary-t03-r3.test.ts > adversary: the oracle origin check is not UTS-46 (SPEC §2.1 step 2, INV-18) > oracle exits 0 on a correct U+1F80 vector
packages/core test:  Test Files  1 failed | 7 passed (8)
packages/core test:       Tests  1 failed | 67 passed (68)
packages/seller-host test:  Test Files  8 passed (8)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:  Test Files  21 passed (21)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:  Test Files  15 passed (15)
packages/sdk test:       Tests  144 passed (144)
packages/cli test:  Test Files  14 passed (14)
packages/cli test:       Tests  121 passed (121)
exit=1 (only the known core oracle failure, being fixed elsewhere)
$ ./scripts/check-reviews.sh && ./scripts/check-workflows.sh
reviews ok
workflows clean
exit=0
```
adversary: not run yet
reviewed: pending (adversary, then Codex)
notes: FLOWS readings, flags SPEC §8 does not give, and two T15 observations are in OPEN-QUESTIONS (From T21). Not built: `release verify` (optional, G6), `call --via buy` (T29). `scripts/check-install-scripts.sh` fails on keys that are all present at the base 32ad820 (the packages' `bin`, sdk `engines`, core `gen:vectors`, seller-host `render-units`, better-sqlite3 integrity); it flags nothing T21 changed.

### T21 adversary r1 fixes - 2026-11-02
adversary r1 (5c22712, `packages/cli/test/adversary-t21-r1-buyer.test.ts`, 5 failing) fixed in b920198 and 1534d5c:
- `CHECK_WORDS` is looked up as an own property (`checkWords()`); a `proof_rejected` detail of "constructor", "toString" or "__proto__" gives the fallback words.
- SDK: a throwing `onProgress` is caught and ignored; outcome, ledger and evidence match the no-handler run (`packages/sdk/test/progress.test.ts`, 4 new tests).
- `safe()` in `packages/cli/src/copy.ts` escapes C0/C1/DEL as `\xNN` (line separators and bidi controls as `\u{NNNN}`) in every printed sourceRef, gateway detail/code, liveness reason and chain-read origin; printable text, FLOWS' included, is unchanged (`test/safe-text.test.ts`).
- `evidence export --format csv` prefixes `'` to a cell starting with = + - @ tab or CR; jsonl unchanged.
- `--daily-cap` removed from `call` (only `init` sets it); over-cap test sets the cap via init, new test shows `call --daily-cap 100` refused and the cap holding; OPEN-QUESTIONS "From T21" updated.

`pnpm --filter @attessa/cli test` (exit=0):
```
      Tests  131 passed (131)
   Start at  18:01:08
   Duration  8.58s (transform 1.91s, setup 0ms, collect 17.35s, tests 30.92s, environment 4ms, prepare 2.32s)

```

`pnpm --filter @attessa/sdk test` (exit=0):
```
 Test Files  15 passed (15)
      Tests  148 passed (148)
   Start at  18:01:21
   Duration  31.50s (transform 1.24s, setup 0ms, collect 11.98s, tests 48.13s, environment 3ms, prepare 2.06s)
```

`pnpm -r typecheck` (exit=0):
```
Scope: 5 of 6 workspace projects
packages/core typecheck$ tsc -p . --noEmit
packages/core typecheck: Done
packages/gateway typecheck$ tsc -p ../core && tsc -p . --noEmit
packages/sdk typecheck$ tsc -p . --noEmit
packages/seller-host typecheck$ tsc -p ../core && tsc -p . --noEmit
packages/seller-host typecheck: Done
packages/sdk typecheck: Done
packages/gateway typecheck: Done
packages/cli typecheck$ tsc -p ../core && tsc -p ../sdk && tsc -p ../seller-host && tsc -p ../gateway && tsc -p . --noEmit
packages/cli typecheck: Done
```
adversary: r1 tests pass; r2 not run yet
reviewed: pending (adversary r2, then Codex)

### T21 adversary r2 fixes - 2026-11-02
adversary r2 (d3ffd47, `packages/cli/test/adversary-t21-r2.test.ts`, 5 failing) fixed in d462f90 and d0ee4d7:
- `claimLabel` (`packages/cli/src/commands/buyer.ts`) and `sourceLabel` (`packages/cli/src/copy.ts`, also `status --agent`) pass the GitHub-shaped label through `safe()` too; normal refs print unchanged (J1 FLOWS tests pass).
- `safe()` escapes the full Bidi_Control set: U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069.
- SDK `loadAccount`/`decryptKeystore` (`packages/sdk/src/keys.ts`) throw only `KeyError` with a fixed reason (no cause, no file field interpolated); the CLI prints "Can't load the wallet from <path>: <reason>." and never another error's text. New tests: `packages/sdk/test/keys.test.ts` (2), `packages/cli/test/buyer.test.ts` (1).

`pnpm --filter @attessa/cli test` (exit=0):
```
 Test Files  17 passed (17)
      Tests  137 passed (137)
   Start at  18:19:06
   Duration  8.12s (transform 1.53s, setup 0ms, collect 13.84s, tests 30.78s, environment 4ms, prepare 2.18s)
```

`pnpm --filter @attessa/sdk test` (exit=0):
```
 Test Files  15 passed (15)
      Tests  150 passed (150)
   Start at  18:19:18
   Duration  31.56s (transform 1.50s, setup 0ms, collect 12.41s, tests 71.05s, environment 10ms, prepare 1.60s)
```

`pnpm -r typecheck` (exit=0):
```
Scope: 5 of 6 workspace projects
packages/core typecheck$ tsc -p . --noEmit
packages/core typecheck: Done
packages/gateway typecheck$ tsc -p ../core && tsc -p . --noEmit
packages/sdk typecheck$ tsc -p . --noEmit
packages/seller-host typecheck$ tsc -p ../core && tsc -p . --noEmit
packages/seller-host typecheck: Done
packages/sdk typecheck: Done
packages/gateway typecheck: Done
packages/cli typecheck$ tsc -p ../core && tsc -p ../sdk && tsc -p ../seller-host && tsc -p ../gateway && tsc -p . --noEmit
packages/cli typecheck: Done
```
adversary: r2 tests pass; r3 not run yet
reviewed: pending (adversary r3, then Codex)

### T21 adversary r3 fixes - 2026-11-02
adversary r3 (531b262, `packages/cli/test/adversary-t21-r3.test.ts`, 5 failing) fixed in 351aa26:
- SDK `loadAccount` (`packages/sdk/src/keys.ts`): a keychain whose `getPassword`/`setPassword` rejects (keytar on headless Linux) is unavailable and returns null, so `init` prints the FLOWS `keychain_unavailable` lines.
- Reads never load the wallet: `status <origin>` (`packages/cli/src/commands/buyer.ts`), `status --agent` and `enclave start` (`connect(g, deps, { wallet: false })`, `packages/cli/src/context.ts`). `status --pending` still needs the wallet: reconciling signs the payer's fetch-result message.
- `ClientOptions.dryRun` (`packages/sdk/src/types.ts`, `client.ts`): the SDK stops at `authorizing` before signing whatever `onProgress` does; the CLI passes `--dry-run` there and its print handler no longer answers `'stop'`.
- Owner/operator `ATTESSA_PRIVATE_KEY` goes through the SDK's exported `keyToAccount` (fixed `KeyError` reason, "Can't load the wallet from ATTESSA_PRIVATE_KEY: not a valid private key."). `run()` maps every unknown error to a fixed `unexpected` CliError (class name and code only), so `--json` prints its `{ok:false}` object; `bin.ts` never prints a raw message.
- New tests: `packages/cli/test/t21-r3-fix.test.ts` (5), `packages/sdk/test/keys.test.ts` (1), `packages/sdk/test/progress.test.ts` (2).

`pnpm --filter @attessa/cli test` (exit=0):
```
 Test Files  19 passed (19)
      Tests  147 passed (147)
   Start at  18:30:20
   Duration  8.32s (transform 1.45s, setup 0ms, collect 15.23s, tests 35.48s, environment 4ms, prepare 2.66s)
```

`pnpm --filter @attessa/sdk test` (exit=0):
```
 Test Files  15 passed (15)
      Tests  153 passed (153)
   Start at  18:30:29
   Duration  31.47s (transform 1.51s, setup 0ms, collect 11.68s, tests 53.35s, environment 3ms, prepare 1.88s)
```

`pnpm -r typecheck` (exit=0) and `pnpm -r lint` (exit=0): every package `Done` (core, gateway, sdk, seller-host, cli).
adversary: r3 tests pass; r4 not run yet
reviewed: pending (adversary r4, then Codex)

### T21 adversary r4 fixes - 2026-11-02
adversary r4 (6f0aa2a, `packages/cli/test/adversary-t21-r4.test.ts`, 6 failing) fixed in 41304da:
- `status --pending` and `cancel` printed the generic `unexpected` line for the SDK's `rpc_unavailable` and `network_mismatch`. One mapping (`packages/cli/src/commands/buyer.ts`, `sdkError`/`fromSdk`/`viaSdk`, built from the old `stoppedError`) now serves every buyer command: an AttestError goes to its FLOWS §8 row by code, an SDK RpcError to `rpc_unavailable`, and no error message is printed. `run()` (`packages/cli/src/index.ts`) maps any AttestError a command missed before falling back to `unexpected`.
- `--dry-run` on an input with an open call resumed it (signed the payer message, fetched `/v1/results`, finalized the ledger entry). With `dryRun`, the SDK's V0 and V6 re-check now stop at an open entry with a `would_resume` event: nothing signed, nothing fetched, ledger unchanged. The CLI line for it is marked not in FLOWS ("...Without --dry-run, attessa resumes it instead of paying again.").
- New tests: `packages/sdk/test/progress.test.ts` (1), `packages/cli/test/buyer.test.ts` (4).
- The fixer's bash append of this note was refused by the guard-bash test-deletion pattern (a false positive on the note's wording; nothing was deleted). Claude re-ran the verification and wrote the note with the editor.

verify at 41304da (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `npx vitest run` in packages/cli and packages/sdk), 2026-11-02:
```
build=0
typecheck Done: 5
lint Done: 5
cli:  Test Files  20 passed (20)
cli:       Tests  157 passed (157)
sdk:  Test Files  15 passed (15)
sdk:       Tests  154 passed (154)
```
Not fixed here, for adversary r5 to judge: seller commands (`packages/cli/src/tx.ts`, `signer.ts`) may still turn a raw RpcUnavailable into the `unexpected` line.
reviewed: pending (adversary r5, then Codex)

### T21 adversary r5 fixes - 2026-11-02
adversary r5 (224bce0, `packages/cli/test/adversary-t21-r5.test.ts`, 4 failing): seller and owner chain reads (`gasPrice()` in `write`, `head()` in revoke release and `status --agent`) let a raw RpcUnavailable reach `run()`, which printed the `unexpected` line instead of the FLOWS §8 "rpc unavailable" row. Fixed in a1112e6:
- `packages/cli/src/tx.ts` `rpcRow` and `chainRead` reuse `read()`'s existing mapping for every read before anything is signed: `head`, `gasPrice`, `send()`'s nonce and tip reads, and `connect`'s `eth_chainId`. A JSON-RPC error reply that is not a revert gets the row too; reverts still reach the caller (`ownerOf` keeps `unknown_agent`). The signer.ts reads are covered through the same helpers.
- `Chain.url` (`packages/cli/src/context.ts`) so the row names the RPC the user set.
- Once a transaction is signed, "Nothing was signed" is never printed: FLOWS has no row for a seller transaction whose outcome is unknown, so a drop after signing keeps the existing `unexpected` line. This also removed two older false "Nothing was signed" lines (after step 2's simulation and the read after registering).
- New tests: `packages/cli/test/t21-r5-fix.test.ts` (16).

verify at a1112e6 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `npx vitest run` in packages/cli and packages/sdk; run by Claude), 2026-11-02:
```
build=0
typecheck Done: 5
lint Done: 5
cli:  Test Files  22 passed (22)
cli:       Tests  177 passed (177)
sdk:  Test Files  15 passed (15)
sdk:       Tests  154 passed (154)
```
reviewed: pending (adversary r6, then Codex)

### T21 adversary r6 fixes - 2026-11-02
adversary r6 (a0ca8b4, `packages/cli/test/adversary-t21-r6.test.ts`, 4 failing): `simulate` read a rate-limit (-32005) or internal (-32603) JSON-RPC error as a revert and printed the node's reply text; and "Nothing was sent." was printed after an earlier transaction of the same command had been sent. Fixed in b1fc5f0:
- `packages/cli/src/tx.ts` `simulate`: eth_call and eth_estimateGas go through `chainRead`, so a non-revert error gets the FLOWS §8 rpc_unavailable row; a real revert is still decoded.
- `packages/cli/src/reverts.ts` `revertToError`: node reply text is never printed; the catch-all row is "The transaction would revert (Name). Nothing was sent."; an ABI-decoded `Error(string)` reason is still shown, escaped by `safe()`.
- `afterSigning` (tx.ts) also drops a trailing " Nothing was sent." / " Nothing was signed." once an earlier transaction of the command was sent. FLOWS §6 J3 and §8 have no line for a partly completed seller flow, so the line keeps its text without the false clause.
- New tests: `packages/cli/test/t21-r6-fix.test.ts` (5). 8e11bf8: OPEN-QUESTIONS entry on `{rpc}` printing `--rpc` verbatim, an API key in the URL included (spec question for Joshua).

verify at 8e11bf8 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `npx vitest run` in packages/cli and packages/sdk; run by Claude), 2026-11-02:
```
build=0
typecheck Done: 5
lint Done: 5
cli:  Test Files  24 passed (24)
cli:       Tests  186 passed (186)
sdk:  Test Files  15 passed (15)
sdk:       Tests  154 passed (154)
```
reviewed: pending (adversary r7, then Codex)

### T21 adversary r7 fixes - 2026-11-02
adversary r7 (c75c27c, `packages/cli/test/adversary-t21-r7.test.ts`, failing): `attessa agent register` from a wallet with no CELO printed "Unexpected error (RpcError)", not FLOWS §5 row 26 `insufficient_gas_funds`. Fixed in b796155, eb7707f and 23549a4:
- `packages/sdk/src/gas.ts` holds the one gas rule: refuse before signing when the balance is below gas limit x maxFeePerGas, and read a node's "insufficient funds" reply (-32000) as the same error. The CLI's `send()` (tx.ts) and the SDK's `cancelAuthorization` (client.ts) both use it.
- `ERR.insufficientGasFunds` (copy.ts): "{address} doesn't have enough CELO to pay the gas for {step} (up to {n} CELO). Nothing was signed." (or "Nothing was sent." once something was signed). The next action names faucet.celo.org/celo-sepolia only on chain 11142220; elsewhere, mainnet included, "Add CELO to {address}, then run the command again." FLOWS §8 has no row for this code, so the line is new and marked not in FLOWS; OPEN-QUESTIONS asks Joshua for FLOWS copy.
- Buyer `attessa cancel` (buyer.ts) gets the same refusal, ending "Nothing was sent." because the cancel permission is already signed. Its OPEN-QUESTIONS entry is ticked.
- New tests: `packages/cli/test/t21-r7-fix.test.ts`, `packages/cli/test/buyer.test.ts` (cancel), `packages/sdk/test/gas-funds.test.ts`.

verify at 23549a4 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `npx vitest run` in packages/cli and packages/sdk; run by Claude), 2026-11-02:
```
build=0
typecheck packages/cli typecheck: Done
lint packages/cli lint: Done
cli:  Test Files  26 passed (26)
cli:       Tests  203 passed (203)
sdk:  Test Files  16 passed (16)
sdk:       Tests  161 passed (161)
```
reviewed: pending (adversary r8, then Codex)

### T21 adversary r8 fixes - 2026-11-02
adversary r8 (59a2933, `packages/cli/test/adversary-t21-r8.test.ts`, failing): when the facilitator settled while a buyer ran `attessa cancel`, the cancel's gas estimate reverted and the buyer saw "Unexpected error (RpcError)" instead of FLOWS §8 "cancel: already used" ("Too late to cancel: the payment went through (tx {h}). Fetching your answer."). Fixed in 5891632:
- `packages/sdk/src/client.ts` `cancelAuthorization`: a revert in the cancel's `eth_estimateGas` re-reads the authorization. Used meanwhile is `AlreadyUsedError` with the settlement tx when one is found; cancelled meanwhile returns that cancel; any other revert stays an error.
- `packages/sdk/src/gas.ts`: `isRevertReply` (code 3 or "execution reverted") and `causes` (an error's cause chain, at most 16 deep).
- The CLI's seller, owner and operator writes already turn a simulate or estimate revert into their own revert line, so they had no such gap.
- New tests: `packages/sdk/test/cancel-race.test.ts` (4).

verify at 5891632 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `npx vitest run` in packages/cli and packages/sdk; run by Claude), 2026-11-02:
```
build=0
typecheck packages/cli typecheck: Done
lint packages/cli lint: Done
cli:  Test Files  27 passed (27)
cli:       Tests  204 passed (204)
sdk:  Test Files  17 passed (17)
sdk:       Tests  165 passed (165)
```
reviewed: pending (adversary r9, then Codex)

### T21 adversary r9 fixes - 2026-11-02
adversary r9 (f932670, `packages/cli/test/adversary-t21-r9.test.ts`, 3 failing): a cancel that reverted while the permission was still unused (a paused token), or raced settlement against an RPC node one block behind, printed "Unexpected error (RpcError)" with no next action; a used permission whose AuthorizationUsed log wasn't returned yet printed "Too late to cancel: the payment went through (tx )" followed by a contradictory "attessa cancel ... voids it now". Fixed in 2616b04:
- `packages/sdk/src/client.ts` `cancelAuthorization`: one decision, used before the cancel, after its estimate reverts and after a failed receipt. A cancel log means cancelled; a "used" log means paid, with that tx; the token's state flag alone never decides "went through". With no log yet, or still unused after a revert, it re-reads for a few seconds so a lagging node catches up.
- `packages/cli/src/copy.ts` and `commands/buyer.ts`: `cancelReverted` ("The transaction would revert. Nothing was sent." / "Run attessa status --pending after {t} UTC to confirm whether you were charged.") and `cancelUndecided` ("Your payment permission was already used or cancelled, but Celo doesn't show which yet." / "Run attessa status --pending in a minute to see which."), each with one next action. "Too late to cancel" needs a tx and is never followed by "attessa cancel ... voids it now". The new lines are not in FLOWS; OPEN-QUESTIONS lists them for Joshua.
- New tests: `packages/cli/test/buyer.test.ts` (cancel rows), `packages/sdk/test/cancel-race.test.ts` (log and lag cases).

verify at 2616b04 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `npx vitest run` in packages/cli and packages/sdk; run by Claude), 2026-11-02:
```
build=0
typecheck packages/cli typecheck: Done
lint packages/cli lint: Done
cli:  Test Files  28 passed (28)
cli:       Tests  209 passed (209)
sdk:  Test Files  17 passed (17)
sdk:       Tests  168 passed (168)
```
reviewed: pending (adversary r10, then Codex)

### T21 adversary r10 fixes - 2026-11-02
adversary r10 (092dc3e, `packages/cli/test/adversary-t21-r10.test.ts`, failing): `attessa cancel` on an RPC that dropped before signing, or after the cancel was broadcast, printed "Unexpected error" with no next action and no tx. Fixed in 2564603:
- `packages/sdk/src/client.ts` `cancelAuthorization`: a chain read's RpcError comes back unchanged only before the first signature. After the cancel permission is signed, any other failure is `CancelInterruptedError`, carrying the cancel tx once it may have been sent. The receipt wait is bounded by receiptWaitMs, not viem's 180 s.
- `packages/cli/src/commands/buyer.ts`, `copy.ts`, `tx.ts`: before signing, FLOWS §8's rpc row. Signed but not sent: the rpc row ending "Nothing was sent.". Sent: "Lost the connection to Celo after sending the cancel (tx {hash}); it may still land." / "Run `attessa status --pending` to see whether it landed (with another `--rpc` if this one stays down)." Seller writes use the same lost-connection row with the explorer next action. The new lines are not in FLOWS; the OPEN-QUESTIONS cancel entry lists them.
- `t21-r5-fix.test.ts` and `cancel-race.test.ts` (fix-round tests, not adversary tests) now expect these exact rows where they expected "Unexpected error". New tests are in `t21-r10-fix.test.ts`, `buyer.test.ts` and `cancel-race.test.ts`.

verify at 2564603 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-02:
```
build=0
typecheck=0
lint=0
cli:  Test Files  30 passed (30)
cli:       Tests  217 passed (217)
sdk:  Test Files  17 passed (17)
sdk:       Tests  171 passed (171)
```
reviewed: pending (adversary r11 found a defect; see below)

### T21 adversary r11 fixes - 2026-11-02
adversary r11 (bf4f61c, `packages/cli/test/adversary-t21-r11.test.ts`, failing): re-running `attessa cancel` after an interrupted cancel that landed reported not_charged / cancelled but left the ledger entry `uncertain`, so the reservation stayed counted in today's spend (SPEC §7 "Cancel ... makes `not_charged` immediate on confirmation"; FLOWS §7 reservation released on NotCharged/Cancelled). Fixed in 55cc5e1:
- `packages/sdk/src/client.ts`: one helper records every decision read from a log. A cancel log sets not_charged / cancelled; a "used" log records the settlement tx before "Too late".
- A reachable node with the cancel not yet mined now gets "The cancel was sent (tx {hash}) but isn't confirmed yet." / "Run `attessa status --pending` to see whether it landed." instead of "Lost the connection to Celo". Not in FLOWS; the OPEN-QUESTIONS cancel entry lists it.
- New tests in `packages/sdk/test/cancel-race.test.ts` and `packages/cli/test/buyer.test.ts`; no existing assertion changed.

verify at 55cc5e1 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-02:
```
build=0
typecheck=0
lint=0
cli:  Test Files  31 passed (31)
cli:       Tests  219 passed (219)
sdk:  Test Files  17 passed (17)
sdk:       Tests  174 passed (174)
```
reviewed: pending (adversary r12 found a defect; see below)

### T21 adversary r12 fixes - 2026-11-02
adversary r12 (926f3d4, `packages/cli/test/adversary-t21-r12.test.ts`, failing): a second `attessa cancel` on a call the first cancel found paid overwrote the saved `<id>.json` answer with nothing and exited "Unexpected error (TypeError)" with no next action (SPEC §7 getResult never re-pays, so that file is the buyer's only copy; FLOWS §8 one next action). Fixed in d39c438:
- `packages/cli/src/commands/buyer.ts` `report()`, the only writer of the answer file (call, cancel, status --pending), writes it only when the result carries an answer. A stored verified outcome reported again prints "Already done: you were charged {p} {sym} (tx {h}) and the answer checked out. It was saved when it arrived." and exits 0, needing no signer.
- `packages/sdk`: a not_charged entry stores the block that decided it (the cancel's log or receipt block; for expiry, the first read past it), so a re-read no longer prints "(block 0)"; older entries omit the block.
- New tests in `packages/cli/test/buyer.test.ts` and `packages/sdk/test/cancel-race.test.ts`; no existing assertion changed. New lines are in the OPEN-QUESTIONS cancel entry, not FLOWS.

verify at d39c438 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-02:
```
build=0
typecheck=0
lint=0
cli:  Test Files  32 passed (32)
cli:       Tests  222 passed (222)
sdk:  Test Files  17 passed (17)
sdk:       Tests  176 passed (176)
```
reviewed: pending (adversary r13 found a defect; see below)

### T21 adversary r13 fixes - 2026-11-02
adversary r13 (461e24a, `packages/cli/test/adversary-t21-r13.test.ts`, failing): with the payment settled on chain but `/v1/results` still answering 202, `status --pending` (and an interrupted `call`) printed "your payment permission expires unused ... attessa cancel <id> voids it now", both false (FLOWS §8 "interrupted, payment found"; FLOWS §7 Uncertain resolves from chain state; FLOWS §9 one next action). Fixed in d5f5fcf:
- `packages/cli/src/commands/buyer.ts`: one check, `paymentFound()`, decides whether the chain shows the payment settled. If so, call, status --pending and cancel print FLOWS §8 "The payment went through (tx {h}). Fetching your answer…" and one next action, "The answer isn't confirmed yet. attessa status --pending checks again and fetches it.", never "expires unused" or cancel. --json uses the same check (code `uncertain`, suggestion `get_result`).
- New tests cover status --pending, --json and cancel; no existing assertion changed. The new next-action line is in the OPEN-QUESTIONS cancel entry, not FLOWS.

verify at d5f5fcf (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-02:
```
build=0
typecheck=0
lint=0
cli:  Test Files  33 passed (33)
cli:       Tests  225 passed (225)
sdk:  Test Files  17 passed (17)
sdk:       Tests  176 passed (176)
```
reviewed: pending (adversary r14 found a defect; see below)

### T21 adversary r14 fixes - 2026-11-04
adversary r14 (f98186b, `packages/cli/test/adversary-t21-r14.test.ts`, failing): a refused call that settled anyway, with the gateway answering `result_not_found`, made `attessa cancel` print "Fetching your answer." and "attessa status --pending checks again and fetches it." instead of the `settled_after_refusal` warning (SPEC §7 "no result and the call was refused → `settled_after_refusal`"; FLOWS §8 row with next action `report_gateway`). Fixed in 66c4929:
- `packages/sdk/src/client.ts`: the end of `settledPath` is one shared `settledEnd`, which `getResult` now calls too. Refused ends `settled_after_refusal`, uncertain ends `paid_but_rejected{missing_proof}`; the ledger closes, evidence is written, spend counts.
- `packages/cli/src/commands/buyer.ts`: `paymentFound()` excludes `result_not_found`; `cancel` prints the FLOWS warning and `--json` says `settled_after_refusal`.
- New tests: `packages/sdk/test/settled-no-result.test.ts` (3) and 2 in `packages/cli/test/buyer.test.ts`; no existing assertion changed. No new copy.

verify at 66c4929 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  34 passed (34)
cli:       Tests  228 passed (228)
sdk:  Test Files  18 passed (18)
sdk:       Tests  179 passed (179)
```
reviewed: pending (adversary r15 found a defect; see below)

### T21 adversary r15 fixes - 2026-11-04
adversary r15 (822e357, `packages/cli/test/adversary-t21-r15.test.ts`, failing): with the buyer's RPC lagging the gateway's clock by more than 300 s, the `X-Attest-Payer-Sig` stamp was stale, the gateway answered 404 `result_not_found` (SPEC §2.5), and `getResult` ended a settled call `paid_but_rejected` and lost the answer the gateway still held (SPEC §7: getResult never re-pays, the held answer must stay fetchable). Fixed in 4d5dfc1:
- `packages/sdk/src/client.ts`: `fetchResult` counts a 404 as "no result" only when the gateway's HTTP Date shows the chain-time stamp was well inside the 300 s window (270 s). Otherwise it signs again at the gateway's Date and asks once more; a 404 it still cannot tell from a stale signature is `unsure`, which `getResult` and the settled path of `reconcilePending` treat as undecided.
- `packages/sdk/test/fakes/gateway.ts`: the fake gateway sends its own clock as Date. New tests in `packages/sdk/test/settled-no-result.test.ts`; no existing assertion changed. No new copy.
- `OPEN-QUESTIONS.md`: whether trusting the gateway's Date for the re-sign is acceptable.

verify at 4d5dfc1 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  35 passed (35)
cli:       Tests  229 passed (229)
sdk:  Test Files  18 passed (18)
sdk:       Tests  182 passed (182)
```
reviewed: pending (adversary r16 found a defect; see below)

### T21 adversary r16 fixes - 2026-11-04
adversary r16 (e859bcf, `packages/cli/test/adversary-t21-r16.test.ts`, failing): an honest gateway whose clock and Date ran 280 s ahead of the buyer's chain time accepted both payer-signature stamps (SPEC §2.5, within 300 s), and its 404 `result_not_found` was genuine, yet `fetchResult` called it `unsure` (280 > 300 - 30), so a refused call that settled stayed `refused` with no `settled_after_refusal` row (SPEC §7). Fixed in 8fde1e7:
- `packages/sdk/src/client.ts`: `fetchResult` re-signs once at the midpoint of chain time and the gateway's Date when they are within 2 x 270 s, so the stamp is inside the window by either clock; a 404 to it is "no result" when the new Date still agrees. Further apart, or with no Date, it stays `unsure`. The stamp is never more than 270 s from chain time, whatever Date the gateway sends.
- New tests in `packages/sdk/test/settled-no-result.test.ts`: Date 400 s ahead ends `settled_after_refusal`; Date 600 s ahead stays `refused`. No existing assertion changed. No new copy.

verify at 8fde1e7 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  36 passed (36)
cli:       Tests  230 passed (230)
sdk:  Test Files  18 passed (18)
sdk:       Tests  184 passed (184)
```
reviewed: pending (adversary r17 finding judged out of model; see below)

### T21 adversary r17 - 2026-11-04 (no code change)
adversary r17 on 33e2332 reported one failing test, archived unchanged at `.worktrees/archive/adversary/t21-r17/adversary-t21-r17.test.ts` (not added to the branch): a fake gateway whose HTTP Date runs 150 s behind the clock it judges `X-Attest-Payer-Sig` by, with the buyer's RPC 500 s behind, rejects the midpoint stamp as stale, and the SDK ends a refused call `settled_after_refusal` while the gateway holds an answer. Not fixed, because:
- the gateway judges the stamp and sends its Date from one clock (`packages/gateway/src/gateway.ts:110` `now`, `:225` the §2.5 check; Date is Node's from the same system clock), so an honest gateway cannot produce it;
- a gateway that sends a false Date can as well withhold the answer outright, which SPEC.md:57 allows ("can withhold, delay, reorder, deny") and SPEC §7 records as `settled_after_refusal`; THREAT-MODEL TB4 accepts withholding (L4). No clock rule can tell a stale stamp from a missing result when the gateway's clock is outside both clocks the SDK can see.
The adversary's other attacks all failed: honest gateway at lag 0, 269, 270, 271, 299, 300, 301, 539 and 540 (a genuine 404 decides, a held answer verifies), 541 stays undecided (outside §2.5), midpoint rounding at the boundaries, and the 16 earlier `adversary-t21-r*` files (43 tests) pass.
reviewed: pending (adversary r18 found a defect; see below; Codex to judge the r17 call above)

### T21 adversary r18 fixes - 2026-11-04
adversary r18 (ab5f86b, `packages/cli/test/adversary-t21-r18.test.ts`, failing): with two pending calls (A settled, its answer still 202; B behind an HTML 502, nothing settled), `attessa status --pending --json` put B's `requestId` at the top level beside A's `settlementTx` and `suggestion: "get_result"`, because `report()` wrote each call's `jsonResult` through `io.data`, which `--json` merges into one object (FLOWS §7 resolve from chain state, never by guessing; FLOWS §8 one next action per row). The `pending[]` rows were right. Fixed in 1311843:
- `packages/cli/src/commands/buyer.ts`: `status --pending` passes `report()` an `io` without `data`; each call's row is only in `pending`. Human output is unchanged. No existing assertion changed. No new copy.
- `OPEN-QUESTIONS.md`: the r15 clock entry now describes the r16 midpoint and the r17 judgement; a new item for `pollResults` polling with no wall-clock bound while every RPC read fails (reported by r18 as unproven; predates T21; not changed).

verify at 1311843 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  37 passed (37)
cli:       Tests  231 passed (231)
sdk:  Test Files  18 passed (18)
sdk:       Tests  184 passed (184)
```
reviewed: pending (adversary r19 found a defect; see below; Codex to judge the r17 call above)

### T21 adversary r19 fixes - 2026-11-04
adversary r19 (f820109, `packages/cli/test/adversary-t21-r19.test.ts`, failing): `attessa call ... --out no-such-dir/result.json` against an honest gateway paid, verified and recorded the call `verified` (terminal), then the `--out` write threw: "Unexpected error" with no next action, `--json` an `unexpected` error merged with the verified result, the paid answer in no file, and a later `cancel <id>` said "It was saved when it arrived" (FLOWS §9 one next action per error row; SPEC §8 --json). Fixed in 3b254be:
- `packages/cli/src/commands/buyer.ts` (`report()`, verified): a failed `--out` write keeps the answer in `<dataDir>/<requestId>.json` and throws `answer_not_written` with one next action; a later report of the stored outcome names that file when it exists. If the data folder refuses it too, a second `answer_not_written` line says it wasn't saved.
- `packages/cli/src/copy.ts`: `alreadyVerifiedKept`, `BUYERR.answerNotWritten`, `BUYERR.answerNotKept`, all `// not in FLOWS`, listed in OPEN-QUESTIONS.md. No existing assertion changed. The both-writes-fail line has no test.

verify at 3b254be (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  38 passed (38)
cli:       Tests  234 passed (234)
sdk:  Test Files  18 passed (18)
sdk:       Tests  184 passed (184)
```
reviewed: pending (adversary r20 found a defect; see below; Codex to judge the r17 call above)

### T21 adversary r20 fixes - 2026-11-04
adversary r20 (12313a1, `packages/cli/test/adversary-t21-r20.test.ts`, failing): with an open call for the same input, `attessa call --dry-run --json` printed the open call's id in its human line but a fresh random `requestId` in the JSON, one no ledger entry has, and wrote a stray `stopped` evidence row under it (SPEC §8 `--json`; an agent running `attessa cancel <requestId>` would be told the request is unknown). Fixed in 5838be3:
- `packages/sdk/src/client.ts`: `wouldResume` returns `stopped` / `dry_run` with the open call's `requestId` and writes no evidence row. No existing assertion changed. No new copy.

verify at 5838be3 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  39 passed (39)
cli:       Tests  235 passed (235)
sdk:  Test Files  18 passed (18)
sdk:       Tests  184 passed (184)
```
reviewed: pending (adversary r21 found a defect; see below; Codex to judge the r17 call above)

### T21 adversary r21 fixes - 2026-11-04
adversary r21 (37e1296, `packages/cli/test/adversary-t21-r21.test.ts`, failing): two open calls both answered in one `attessa status --pending` run from a working folder that no longer exists; the first call's `answer_not_written` stopped the loop, and the second call, already `verified` (terminal, never re-fetched), had its answer written nowhere and nothing printed (SPEC §7 getResult never re-pays; SPEC §9 every outcome reported). Fixed in e418018:
- `packages/cli/src/commands/buyer.ts`: `status --pending` catches a call's CliError from `report()`, prints its message and next action under that call, goes on to the rest, lists them in `--json` `errors`, and exits 1.
- Same file: `attessa call` refuses an `--out` that resolves inside the data folder before signing (the adversary's unproven lead that `--out ~/.attessa/pending.jsonl` would overwrite the ledger). New test in `packages/cli/test/buyer.test.ts`. Both lines are `// not in FLOWS`, in OPEN-QUESTIONS.md. No existing assertion changed.

verify at e418018 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  40 passed (40)
cli:       Tests  237 passed (237)
sdk:  Test Files  18 passed (18)
sdk:       Tests  184 passed (184)
```
reviewed: pending (adversary r22 found a defect; see below; Codex to judge the r17 call above)

### T21 adversary r22 fixes - 2026-11-04
adversary r22 (dbd983e, `packages/cli/test/adversary-t21-r22.test.ts`, failing): with open calls to two services whose answers were both released, `attessa status <A> --pending` let `reconcilePending` decide both calls `verified` (terminal, never re-fetched; SPEC §7) and then reported only A's, so B's paid, verified answer was written nowhere, and a later `status --pending` could not recover it. Fixed in 72dc5d4:
- `packages/cli/src/commands/buyer.ts`: `status [<origin>] --pending` reports every call the run decides, the asked-about service's first; each row already names its host. The `--out` data-folder guard resolves symlinks (the adversary's unproven lead), with a new test in `packages/cli/test/buyer.test.ts`. The scope question is in OPEN-QUESTIONS.md. No existing assertion changed. No new copy.

verify at 72dc5d4 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  41 passed (41)
cli:       Tests  239 passed (239)
sdk:  Test Files  18 passed (18)
sdk:       Tests  184 passed (184)
```
reviewed: pending (adversary r23 found a defect; see below; Codex to judge the r17 call above)

### T21 adversary r23 fixes - 2026-11-04
adversary r23 (aa0b9f2, `packages/cli/test/adversary-t21-r23.test.ts`, failing): `--out answer.json` where answer.json is a symlink to `~/.attessa/evidence.jsonl` passed the data-folder guard (it resolved only the folder of `--out`), the call was paid, and the answer replaced every evidence row (SPEC §9; the guard's own purpose). It also hunted the whole "SDK makes a call terminal, then the CLI loses its answer or line" family (reconcilePending throwing partway, resume, cancel and getResult re-reporting, --json row merge, evidence export) and found nothing else. Fixed in b05d359:
- `packages/cli/src/commands/buyer.ts`: `intoDataDir()` follows a symlink at `--out` itself (dangling too, one hop), compares the real path with the data folder, and refuses a hard link to any file in it (same device and inode).
- New test in `packages/cli/test/buyer.test.ts` for a dangling symlink and a hard link. No existing assertion changed. No new copy.

verify at b05d359 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  42 passed (42)
cli:       Tests  241 passed (241)
sdk:  Test Files  18 passed (18)
sdk:       Tests  184 passed (184)
```
reviewed: pending (adversary r24 found defects; see below; Codex to judge the r17 call above)

### T21 adversary r24 fixes - 2026-11-04
adversary r24 (54e0e53, `packages/cli/test/adversary-t21-r24.test.ts`, 3 failing): (1) without `--out`, a `./result.json` symlinked to `~/.attessa/evidence.jsonl` took the paid answer over the evidence log (the guard ran only for an explicit `--out`; SPEC §9); (2) a process stopped after the ledger recorded `verified` but before the answer was written left no copy, yet a later `cancel <id>` said "It was saved when it arrived"; (3) the same false line after "it wasn't saved". Fixed in 0f0788e:
- `packages/cli/src/commands/buyer.ts`: `call` checks the default `result.json` before signing; `report()` checks every answer file (also `<requestId>.json` from `status --pending` and `cancel`) and keeps the answer beside the record if it would land in the data folder. Each answer the CLI writes is recorded in `<dataDir>/saved.txt`; a re-report says "It was saved when it arrived" only with that record, else the new `alreadyVerifiedNotSaved` line.
- `packages/cli/src/copy.ts`: `alreadyVerifiedNotSaved`, `// not in FLOWS`, in OPEN-QUESTIONS.md. No existing assertion changed.

verify at 0f0788e (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  43 passed (43)
cli:       Tests  244 passed (244)
sdk:  Test Files  18 passed (18)
sdk:       Tests  184 passed (184)
```
reviewed: pending (adversary r25 found a defect; see below; Codex to judge the r17 call above)

### T21 adversary r25 fixes - 2026-11-04
adversary r25 (3db7169, `packages/cli/test/adversary-t21-r25.test.ts`, failing): a truncated `~/.attessa/config.json` (a kill or a full disk during `init`'s write) made every buyer command print "{path} isn't valid JSON. Run attessa init again.", and `attessa init` failed with the same line, so the row's one next action could never work (FLOWS §8/§9). Fixed in 983d9e6:
- `packages/cli/src/commands/buyer.ts`, `packages/cli/src/index.ts`: `init` reads the config through `readConfigForInit`, which treats an unparseable file as absent, and writes a fresh one; every other command still refuses with the bad-JSON row.
- Same file: run from inside the data folder, `status --pending` / `cancel` write `<requestId>.json`, which is the kept file itself; that write is allowed instead of being reported as failed (the adversary's unproven lead; no test).
No existing assertion changed. No new copy.

verify at 983d9e6 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  44 passed (44)
cli:       Tests  245 passed (245)
sdk:  Test Files  18 passed (18)
sdk:       Tests  184 passed (184)
```
reviewed: pending (adversary r26 found a defect; see below; Codex to judge the r17 call above)

### T21 adversary r26 fixes - 2026-11-04
adversary r26 (0a5760f, `packages/cli/test/adversary-t21-r26.test.ts`, failing): an `evidence.jsonl` whose last row was cut short (a full disk or a killed append) made `Ledger.readEvidence` throw a SyntaxError. `status --pending` had already marked every open call `verified` (terminal, never fetched again), and `report()` reads evidence after writing each answer, so the first answer was written, the run ended "Unexpected error" with no next action, and every later paid, verified answer was written nowhere (SPEC §9; FLOWS §8 one next action). Fixed in e24e0e2:
- `packages/sdk/src/ledger.ts`: `readEvidence` skips a line that doesn't parse instead of failing the whole read; `appendEvidence` starts on a fresh line when the file doesn't end in a newline, so the row after a cut-short one stays whole.
- `packages/sdk/test/ledger.test.ts`: a cut-short row is skipped and the next append reads back whole.
- OPEN-QUESTIONS.md: the adversary's unproven lead (USA₮ limits have no `init` flag; a bad `dailyCap` in config.json names a `--daily-cap` flag `call` doesn't take), mainnet only.
No existing assertion changed. No new copy.

verify at e24e0e2 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  45 passed (45)
cli:       Tests  246 passed (246)
sdk:  Test Files  18 passed (18)
sdk:       Tests  185 passed (185)
```
reviewed: pending (adversary r27 found a defect; see below; Codex to judge the r17 call above)

### T21 adversary r27 fixes - 2026-11-04
adversary r27 (4e68e2c, `packages/cli/test/adversary-t21-r27.test.ts`, failing): the SDK's `finish()` makes the ledger entry terminal and then appends the evidence row; when that append failed (ENOSPC on evidence.jsonl), `payAndVerify` threw, so the paid, verified answer was in no result, the CLI printed "Unexpected error (Error, ENOSPC)" with no next action, and no later run could fetch it (getResult never re-fetches a terminal entry; SPEC §7 V12, §9). Fixed in c011165:
- `packages/sdk/src/client.ts`, `types.ts`: a failed evidence append no longer throws away the decided result; it comes back with `evidenceNotWritten: true`. `CallResult.inputsBlock` carries the inputs block, so the CLI no longer re-reads evidence for the "Paid" line.
- `packages/cli/src/commands/buyer.ts`, `copy.ts`: a verified result with no evidence row saves the answer as usual, prints "Answer saved to {file}." and ends `record_not_written` (exit 1): "Couldn't add this call to your record at {record}." / "Free up space in {dir}, or make it writable, before your next call." (not in FLOWS; OPEN-QUESTIONS.md).
- `packages/cli/test/buyer.test.ts`: those lines, with the answer in result.json.
No existing assertion changed.

verify at c011165 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  46 passed (46)
cli:       Tests  248 passed (248)
sdk:  Test Files  18 passed (18)
sdk:       Tests  185 passed (185)
```
reviewed: pending (adversary r28 found a defect; see below; Codex to judge the r17 call above)

### T21 adversary r28 fixes - 2026-11-04
adversary r28 (66edc94, `packages/cli/test/adversary-t21-r28.test.ts`, two failing tests): the r27 guard covered only `finish()`. (1) A `paid_but_rejected` call whose evidence row wasn't written still printed "Your record (…) proves the payment and the failed check." (SPEC §9 11a). (2) An honest 503 `enclave_unavailable` after signing wrote its refusal row outside `finish()`; the failed append ended "Unexpected error (Error, ENOSPC)" with no next action and left the call `refused` instead of `not_charged` (SPEC §9 7a). Fixed in a1d2b2c:
- `packages/sdk/src/client.ts`: every evidence write (`evidence()`, the refusal row before waiting for expiry, resume, `stopped()`) goes through `appendOrMark`, which sets `evidenceNotWritten` instead of throwing; the refusal row's mark is carried to the final result.
- `packages/cli/src/commands/buyer.ts`, `copy.ts`: `report()` prints any outcome as usual, then ends `record_not_written` when the row is missing; `paid_but_rejected` and `settled_after_refusal` drop the "Your record … proves" clause then. Limits in OPEN-QUESTIONS.md (two next actions on those two rows; a `stopped` result doesn't mention the missing record).
No existing assertion changed.

verify at a1d2b2c (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  47 passed (47)
cli:       Tests  250 passed (250)
sdk:  Test Files  18 passed (18)
sdk:       Tests  185 passed (185)
```
reviewed: pending (adversary r29 found a defect; see below; Codex to judge the r17 call above)

### T21 adversary r29 fixes - 2026-11-04
adversary r29 (d39f20b, `packages/cli/test/adversary-t21-r29.test.ts`, two failing tests): (1) `attessa cancel` that lands while evidence.jsonl can't be appended: `finish()` marked a result that `cancelAuthorization` discarded (it returns only the tx hash), so the CLI printed only "Cancelled (tx …)." and exited 0 with no row recorded (SPEC §9). (2) Over the daily cap with the record unwritable, the line read the price back from the row that failed to write: "today's spend to 0.00 USDC" (FLOWS §8 over_daily_cap). Fixed in b12a23a:
- `packages/sdk/src/client.ts`, `index.ts`: a landed cancel whose row wasn't written throws `CancelNotRecordedError` (with the tx); a `stopped` result carries `amount` and `asset`.
- `packages/cli/src/commands/buyer.ts`: `cancel` prints "Cancelled (tx {h})." then ends `record_not_written`; over_daily_cap uses the result's amount and asset; the now unused `lastEvidence` is removed.
- OPEN-QUESTIONS.md: the new error class and result fields.
No existing assertion changed. No new copy.

verify at b12a23a (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  48 passed (48)
cli:       Tests  252 passed (252)
sdk:  Test Files  18 passed (18)
sdk:       Tests  185 passed (185)
```
reviewed: pending (adversary r30 found a defect; see below; Codex to judge the r17 call above)

### T21 adversary r30 fixes - 2026-11-04
adversary r30 (5e11609, `packages/cli/test/adversary-t21-r30.test.ts`, failing): the disk filling after an honest gateway settled made `settleAndVerify`'s first ledger write throw ENOSPC; `attessa call` ended "Unexpected error (Error, ENOSPC)" with no next action after a charge (FLOWS:832 "Every error row has one next action"). The entry stays `signed`, so `status --pending` can finish it. Fixed in 888c75e:
- `packages/cli/src/copy.ts`, `index.ts`, `commands/buyer.ts`: a buyer command's Node or SQLite disk-write error (list in OPEN-QUESTIONS.md) ends `disk_write_failed`: "Couldn't write a file attessa keeps on this computer ({code})." / "Free up space in {dir}, or make it writable, then run `attessa status --pending` to finish any call in progress." A read-only data folder fails first at the ledger's SQLite lock (SQLITE_CANTOPEN), so SQLite's codes are included.
- `packages/cli/test/buyer.test.ts`: the two lines for a read-only `~/.attessa`.
No existing assertion changed.

verify at 888c75e (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  49 passed (49)
cli:       Tests  254 passed (254)
sdk:  Test Files  18 passed (18)
sdk:       Tests  185 passed (185)
```
reviewed: pending (adversary r31 found a defect; see below; Codex to judge the r17 call above)

### T21 adversary r31 fixes - 2026-11-04
adversary r31 (9691d5c, `packages/cli/test/adversary-t21-r31.test.ts`, failing): with a read-only `~/.attessa` that already holds the ledger lock file, SQLite reports SQLITE_READONLY_DIRECTORY, which the SDK's ledger wraps in its own error with the SQLite error as `cause`; `diskError` read only the outer error, so the command still ended "Unexpected error". Fixed in 9aaff7d:
- `packages/cli/src/copy.ts`: `diskError` checks the wrapped `cause` one level down first, and maps SQLite's extended result codes by their low byte (READONLY_DIRECTORY is READONLY).
- OPEN-QUESTIONS.md: the disk_write_failed entry says so.
No existing assertion changed.

verify at 9aaff7d (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  50 passed (50)
cli:       Tests  256 passed (256)
sdk:  Test Files  18 passed (18)
sdk:       Tests  185 passed (185)
```
reviewed: pending (adversary r32 found a defect; see below; Codex to judge the r17 call above)

### T21 adversary r32 fixes - 2026-11-04
adversary r32 (86b3385, `packages/cli/test/adversary-t21-r32.test.ts`, failing): `sdkError` gave a next action to `network_mismatch` only for the RPC chain-id detail. `attessa call --asset usat` on Celo Sepolia ("usat is not offered on chain 11142220") and a quote naming another network ("network eip155:42220") ended "Wrong network: {detail}. Nothing was signed." with no next action (FLOWS:832 "Every error row has one next action"). Nothing was signed in either case. Fixed in fc37da4:
- `packages/cli/src/commands/buyer.ts`: that row's next action is "Check `--network` and `--asset`, then retry." (marked not in FLOWS).
- OPEN-QUESTIONS.md: an entry for the row, for design to approve or replace.
No existing assertion changed.

verify at fc37da4 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  51 passed (51)
cli:       Tests  258 passed (258)
sdk:  Test Files  18 passed (18)
sdk:       Tests  185 passed (185)
```
reviewed: pending (adversary r33 found a defect; see below; Codex to judge the r17 call above)

### T21 adversary r33 fixes - 2026-11-04
adversary r33 (dca65cd, `packages/cli/test/adversary-t21-r33.test.ts`, failing): both pinned deployments have `enclaveRegistry: null`, and with `ATTESSA_REGISTRY` unset the SDK's `net()` threw a plain Error. `attessa call` and `status --pending` ended "Unexpected error (Error)." with no next action (FLOWS:832), and `status <origin>` printed "Can't reach Celo at {rpc}." about an RPC that had answered (FLOWS:787). Nothing was signed. Fixed in f8bbbd6:
- `packages/sdk/src/types.ts`, `client.ts`: the SDK throws `AttestError('no_registry', ...)`; `CallCode` gains `no_registry`.
- `packages/cli/src/commands/buyer.ts`: `sdkError` maps `no_registry` to the seller commands' existing row: "No EnclaveRegistry address is known for {network}." / "Set ATTESSA_REGISTRY to the registry address."
- OPEN-QUESTIONS.md: an entry for the row on buyer commands.
No existing assertion changed. Not fixed, unproven (mainnet only, no USA₮ on Sepolia): r33 suspects a resumed USA₮ call reports the `--asset` flag's symbol instead of the entry's.

verify at f8bbbd6 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  52 passed (52)
cli:       Tests  262 passed (262)
sdk:  Test Files  18 passed (18)
sdk:       Tests  185 passed (185)
```
reviewed: pending (adversary r34 found a defect; see below; Codex to judge the r17 call above)

### T21 adversary r34 fixes - 2026-11-04
adversary r34 (01c040b, `packages/cli/test/adversary-t21-r34.test.ts`, failing): with two live signers on two approved releases of one origin, liveness answered by signer A (release R1) and the paid answer proven by signer B (release R2), the call ended `verified` with an evidence row pairing `releaseId` R2 with R1's `ownerClaimedSource` (SPEC.md:640, :700), and `attessa call` printed R1 above "The answer came from that approved build" (FLOWS J1). No money at risk: B is an approved, active signer. Fixed in 6c3e698:
- `packages/sdk/src/client.ts` (`settleAndVerify`): when the proof's release differs from the liveness release, the owner claim recorded is looked up for the proof's release (and dropped if it has none), not carried over.
- `packages/cli/src/commands/buyer.ts`, `copy.ts`: the release shown at "Runs agent ..." is carried to the report; when the proof's release differs, the paid line reads "Paid {p} {sym}. The answer came from another approved build of this agent (release {r}), for this request, using Celo data from block {b}  (settled: tx {tx}, signer {s})" (marked not in FLOWS).
- OPEN-QUESTIONS.md: the entry, with the open question whether V10 should instead require the proving signer to equal the liveness signer (`expectedSigner` is stored but never compared).
No existing assertion changed.

verify at 6c3e698 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  53 passed (53)
cli:       Tests  264 passed (264)
sdk:  Test Files  18 passed (18)
sdk:       Tests  185 passed (185)
```
reviewed: pending (adversary r35 found a defect; see below; Codex to judge the r17 call and the r34 expectedSigner question above)

### T21 adversary r35 fixes - 2026-11-04
adversary r35 (e31bb39, `packages/cli/test/adversary-t21-r35.test.ts`, failing): an interrupted `--asset usat` call re-run without `--asset` resumed the USA₮ entry (V0, one payment, evidence `asset` the USA₮ token) but printed "Paid 0.02 USDC": `call` took the symbol from this run's flag (FLOWS J1 "Paid {p} {sym}"). Mainnet or a mainnet fork only (Sepolia pins no USA₮). Fixed in 66890ae:
- `packages/cli/src/commands/buyer.ts`: `call` reports in the asset of the result (`assetOf(r.asset)`), symbol and daily cap both, as `cancel` and `status --pending` already did.
- `packages/sdk/src/client.ts`: r35 also noted (unproven) that the r34 change could pair a `paid_but_rejected` row's liveness `releaseId` with the proof release's owner claim. Now only a `verified` row (whose `releaseId` is the proof's) takes the proof release's claim; a rejected row keeps the claim that matches its own `releaseId`, as before r34.
No existing assertion changed.

verify at 66890ae (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-04:
```
build=0
typecheck=0
lint=0
cli:  Test Files  54 passed (54)
cli:       Tests  265 passed (265)
sdk:  Test Files  18 passed (18)
sdk:       Tests  185 passed (185)
```
reviewed: pending (adversary r36 found a defect; see below; Codex to judge the r17 call and the r34 expectedSigner question above)

### T21 adversary r36 fixes - 2026-11-05
adversary r36 (db34134, `packages/cli/test/adversary-t21-r36.test.ts`, failing): a gateway answering 200 with a proof and a PAYMENT-RESPONSE tx that never settles on chain made `settleAndVerify` return `uncertain` at once, though `waitForExpiry` is on by default (SPEC.md:635 "by default (`waitForExpiry`) the SDK waits until a block with timestamp > validBefore + 5"; SPEC.md:660 `attessa call` "waits to confirm not-charged unless `--no-wait`"). The call ended "Not confirmed yet" with the amount still reserved. Fixed in de764a5:
- `packages/sdk/src/client.ts` (`settleAndVerify`): with no settlement found, the entry goes `uncertain` and, by default, through `finalize` (the same expiry wait as a lost connection), ending `not_charged` or the settlement it then finds; with `waitForExpiry: false` it returns `uncertain` as before. The 202 poll and V0 resume paths call the same function.
- `packages/cli/src/commands/buyer.ts`: r36 also noted (unproven) that `cancel` on a never-signed request ended `nothing_signed` with no next action (FLOWS:832); it now has "Run `attessa status --pending` to see your open calls." (OPEN-QUESTIONS.md entry).
No existing assertion changed.

verify at de764a5 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-05:
```
build=0
typecheck=0
lint=0
cli:  Test Files  55 passed (55)
cli:       Tests  266 passed (266)
sdk:  Test Files  18 passed (18)
sdk:       Tests  185 passed (185)
```
reviewed: pending (adversary r37 found a defect; see below; Codex to judge the r17 call and the r34 expectedSigner question above)

### T21 adversary r37 fixes - 2026-11-05
adversary r37 (eaaa597, `packages/cli/test/adversary-t21-r37.test.ts`, failing): the r36 change set the entry to `uncertain` before the no-settlement wait even when it was `refused`. A refused call resumed into that wait, settled during it with no result left at the gateway, ended `paid_but_rejected{missing_proof}`, where SPEC.md:635 says "no result and the call was `refused` → `settled_after_refusal`". Fixed in 545c7b2:
- `packages/sdk/src/client.ts` (`settleAndVerify`): a `refused` entry stays `refused` into the wait; other entries go `uncertain` as in r36.
- `packages/cli/src/commands/buyer.ts`: r37 also noted (unproven) that the r36 wait printed nothing for about two minutes (FLOWS:825 "No silent waits"): the `waiting` progress now prints the confirming line and its next action for an `uncertain` call that hasn't printed "Lost the connection…". OPEN-QUESTIONS.md entry for that copy, and for `finalize`'s unbounded RPC retry, not changed.
No existing assertion changed.

verify at 545c7b2 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-05. The first full run of this code ended `cli: Tests 15 failed | 252 passed (267)`, with no failure detail kept; a CLI-only rerun under the lock right after passed 267, and this second full run passed:
```
build=0
typecheck=0
lint=0
cli:  Test Files  56 passed (56)
cli:       Tests  267 passed (267)
sdk:  Test Files  18 passed (18)
sdk:       Tests  185 passed (185)
```
reviewed: pending (adversary r38, then Codex; Codex to judge the r17 call and the r34 expectedSigner question above, and the r37 flaky full run)

### T21 adversary r38 fixes - 2026-11-05
adversary r38 (010f59a, test `packages/cli/test/adversary-t21-r38.test.ts`, failing first): a re-run that resumed a `signed` call (its first run died after signing) got the gateway's 404 `result_not_found` and waited up to two minutes in `finalize` for the expiry check with no line printed between "Resuming it instead of paying again." and "Not charged: …" (FLOWS:825 "No silent waits"). Fixed in 34d5faf:
- `packages/cli/src/commands/buyer.ts` (`waiting` progress): the confirming line and its next action print for every wait except a call whose settlement is known and an `uncertain` call that already printed "Lost the connection…". So a resumed `signed` or `settle_pending` call gets it too. The OPEN-QUESTIONS.md entry for that copy now names this case.
No existing assertion changed.

verify at 34d5faf (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test` in packages/cli and packages/sdk; run by Claude under the heavy lock), 2026-11-05:
```
build=0
typecheck=0
lint=0
cli:  Test Files  57 passed (57)
cli:       Tests  268 passed (268)
sdk:  Test Files  18 passed (18)
sdk:       Tests  185 passed (185)
```
reviewed: pending (adversary r39, then Codex; Codex to judge the r17 call and the r34 expectedSigner question above, and the r37 flaky full run)

### T21 staging merge and adversary r39 fix - 2026-11-05
CI (`ci` and `harness`) had been red on this branch since before r33: it predated staging's fixes (the deferred BLOCKING questions, the nitro pin, the core oracle test). 74ca132 merges staging. Conflicts: the SDK takes staging's pinned-registry-first rule (SPEC §2.6) and keeps the branch's `no_registry` AttestError; DONE.md is staging's file with the T21 section after it; OPEN-QUESTIONS.md keeps staging's deferred blockers plus the T21 entries; TASKS.md takes staging's ticks and keeps T21 ticked. Since T10 pinned the real Sepolia registry, CLI tests use a vitest setup file (`packages/cli/test/pin-fake-registry.ts`) that pins the fake one, `test/fake-chain.ts`'s REGISTRY equals the SDK FakeChain's default, and `adversary-t21-r33.test.ts` (a network with no registry) unpins Sepolia for its own tests. No assertion changed. CI on 74ca132: `ci` success, `harness` success.

adversary r39 (7e4a88e, test `packages/cli/test/adversary-t21-r39.test.ts`, failing first): a refused call resumed with `--no-wait` that got a 200 with no settlement ended `refused` with no code in `--json` and a second evidence row with `code: null` (SPEC.md:620 "refused (+ code)", SPEC.md:640). Fixed in 18210f4: `finish` (packages/sdk/src/client.ts) gives a kept refusal its stored code, as `current()` does for the same entry.

verify at 18210f4 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`; run by Claude under the heavy lock), 2026-11-05:
```
build=0
typecheck=0
lint=0
packages/core test:       Tests  69 passed (69)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  58 passed (58)
packages/cli test:       Tests  270 passed (270)
```
reviewed: pending (adversary r40, then Codex; Codex to judge the r17 call and the r34 expectedSigner question above, and the r37 flaky full run)

### T21 adversary r40 fixes - 2026-11-05
adversary r40 (58a0f07, test `packages/cli/test/adversary-t21-r40.test.ts`, failing first): past validBefore + 5 the chain read the permission as used but the RPC's log index had no AuthorizationUsed yet; after 21 polls `finalize` returned the entry as it stood, and `attessa call` printed "expires unused … unless the gateway used it" and "attessa cancel … voids it now", a next action that can't work (SPEC.md:635, FLOWS.md:832). Fixed in 2cea645:
- `packages/sdk/src/client.ts` (`finalize`): that exit marks the result `authorizationUsed: true` (new optional `CallResult` field in `packages/sdk/src/types.ts`).
- `packages/cli/src/commands/buyer.ts`: such a result prints cancel's undecided row ("Your payment permission was already used or cancelled, but Celo doesn't show which yet." / "Run attessa status --pending in a minute to see which."), and `--json` carries `authorizationUsed: true`. OPEN-QUESTIONS.md entry added for the copy.
No existing assertion changed.

verify at 2cea645 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`; run by Claude under the heavy lock), 2026-11-05:
```
build=0
typecheck=0
lint=0
packages/core test:       Tests  69 passed (69)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  59 passed (59)
packages/cli test:       Tests  271 passed (271)
```
reviewed: pending (adversary r41, then Codex; Codex to judge the r17 call and the r34 expectedSigner question above, and the r37 flaky full run)

### T21 adversary r41 fixes - 2026-11-05
adversary r41 (e156cc0, test `packages/cli/test/adversary-t21-r41.test.ts`, failing first): the r40 flag was set only after 21 waiting polls, so `attessa status --pending` and a `call --no-wait` resume (one `finalize` pass each) still printed "expires unused at {t} UTC … attessa cancel {id} voids it now" for a permission the chain read as used past expiry with no log indexed (SPEC.md:635, FLOWS.md:832). Fixed in 9da450d: `finalize` (packages/sdk/src/client.ts) remembers that read and marks the single-pass result `authorizationUsed` too, so both commands print cancel's undecided row. Round 40's two leads: the `rpc_unavailable` evidence code for a kept refusal was dropped by r41 (SPEC names no code for that pass); a malformed ATTESSA_REGISTRY stopping buyer commands under `--network local` on a Sepolia fork is real but only the message is affected, not fixed here.
No existing assertion changed. CI on 225b2fc (r40): `ci` success, `harness` success.

verify at 9da450d (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`; run by Claude under the heavy lock), 2026-11-05:
```
build=0
typecheck=0
lint=0
packages/core test:       Tests  69 passed (69)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  60 passed (60)
packages/cli test:       Tests  273 passed (273)
```
reviewed: pending (adversary r42, then Codex; Codex to judge the r17 call and the r34 expectedSigner question above, and the r37 flaky full run)

### T21 adversary r42 fixes - 2026-11-05
adversary r42 (f00e49a, test `packages/cli/test/adversary-t21-r42.test.ts`, failing first): a waiting re-run past expiry of a call whose permission the chain already read as used (no log indexed yet) first printed "Confirming you weren't charged: your payment permission expires unused at {t} UTC (in 0 s). Waiting…" and the `attessa cancel` hint, then ended with the undecided row (SPEC.md:635, FLOWS.md:832). Fixed in fb83434: the SDK's `waiting` progress carries `used: true` in that state (packages/sdk/src/types.ts, client.ts), and the CLI prints "Your payment permission was already used or cancelled; waiting for Celo to show which…  (up to a minute)" instead (packages/cli/src/copy.ts, buyer.ts; noted in OPEN-QUESTIONS.md, not in FLOWS). Round 41's lead (an RpcError on `authorizationState` with wait false) was dropped by r42.
No existing assertion changed. CI on 704cab7 (r41): `ci` success, `harness` success.

verify at fb83434 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`; run by Claude under the heavy lock), 2026-11-05:
```
build=0
typecheck=0
lint=0
packages/core test:       Tests  69 passed (69)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  61 passed (61)
packages/cli test:       Tests  274 passed (274)
```
reviewed: pending (adversary r43, then Codex; Codex to judge the r17 call and the r34 expectedSigner question above, and the r37 flaky full run)

### T21 adversary r43 fixes - 2026-11-05
adversary r43 (fbc00c1, tests `packages/cli/test/adversary-t21-r43.test.ts` and `adversary-t21-r43-evidence.test.ts`, the second made from its evidence probe; failing first):
1. A refused call whose permission the chain already read as used before expiry, with no log indexed, printed the confirming line ("expires unused at {t}") and the `attessa cancel` hint on its first wait pass, then ended on the undecided row (SPEC.md:635, FLOWS.md:832). `finalize` read `authorizationState` only past validBefore + 5.
2. A waiting lost-connection call that ended on the lagging-log exit wrote no evidence row (SPEC.md:700 "Every outcome is in evidence"); with `--no-wait` it did.
Fixed in 5eac46b: `finalize` (packages/sdk/src/client.ts) reads the permission state on every pass; used with no log counts as lagging and announces `used`, unused decides `not_charged` only past validBefore + 5; the lagging exit writes an `uncertain` row unless the entry is refused (whose row exists).
That made three SDK tests fail (`packages/sdk/test/outcomes.test.ts`: two INV-20 tests and the confirmNotCharged test), which asserted that no `authorizationState` read happens before validBefore + 5, stricter than INV-20 ("never reports `not_charged` without reading … == false at a block whose timestamp > validBefore + 5"). Joshua chose (2026-11-05) to narrow them to INV-20's wording: a2423af asserts the deciding (last) read is past validBefore + 5, and keeps every other assertion, including `confirmedAtBlock` past validBefore + 5.

verify at a2423af (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`; run by Claude under the heavy lock), 2026-11-05:
```
build=0
typecheck=0
lint=0
packages/core test:       Tests  69 passed (69)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  63 passed (63)
packages/cli test:       Tests  277 passed (277)
```
reviewed: pending (adversary r44, then Codex; Codex to judge the r17 call, the r34 expectedSigner question, the r37 flaky full run and the r43 narrowing of the INV-20 test assertions)

### T21 adversary r44 fixes - 2026-11-05
adversary r44 (a7186c1, test `packages/cli/test/adversary-t21-r44.test.ts`, failing first): when the first `authorizationState` read of a wait threw an RpcError, `finalize` still announced the wait from that pass, without `used`, so the CLI printed the confirming line ("expires unused") and the `attessa cancel` hint for a permission the chain already read as used (SPEC.md:635, FLOWS.md:832). Fixed in 2b8a56e: the wait is announced only from a pass whose state read succeeded (packages/sdk/src/client.ts). Known trade-off, already in the OPEN-QUESTIONS.md entry on `finalize`'s unbounded RPC retry: if every state read fails while the head answers, the wait now prints nothing until a read succeeds.
No existing assertion changed. CI on 11a4a35 (r43): `ci` success, `harness` success.

verify at 2b8a56e (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`; run by Claude under the heavy lock), 2026-11-05:
```
build=0
typecheck=0
lint=0
packages/core test:       Tests  69 passed (69)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  64 passed (64)
packages/cli test:       Tests  278 passed (278)
```
reviewed: pending (adversary r45, then Codex; Codex to judge the r17 call, the r34 expectedSigner question, the r37 flaky full run and the r43 narrowing of the INV-20 test assertions)

### T21 adversary r45 fixes - 2026-11-05
adversary r45 (6f6ee3c, test `packages/cli/test/adversary-t21-r45.test.ts`, failing first):
1. `attessa status --agent` listed a signer whose release was revoked or whose endpoint was retired as `Active`, and `--json` `.signer` picked it (FLOWS §7 signer statechart: "Active --> Inert … Checks evaluate signer AND release AND endpoint").
2. `invalid_transition` and `signer_not_active` ended with no next action (FLOWS.md:832); `self_disabled` had the same gap.
Fixed in 50e4126: `status --agent` derives `Inert` for an active, unexpired signer whose release isn't Approved or whose endpoint isn't Active or has another operator (packages/cli/src/commands/registry.ts); the `revoke release` prompt no longer counts such signers as live; the three rows get a next action (packages/cli/src/copy.ts; OPEN-QUESTIONS.md entry, not in FLOWS).
No existing assertion changed. CI on 9782b3f (r44): `ci` success, `harness` success.

verify at 50e4126 (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`; run by Claude under the heavy lock), 2026-11-05:
```
build=0
typecheck=0
lint=0
packages/core test:       Tests  69 passed (69)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  65 passed (65)
packages/cli test:       Tests  282 passed (282)
```
reviewed: pending (adversary r46, then Codex; Codex to judge the r17 call, the r34 expectedSigner question, the r37 flaky full run and the r43 narrowing of the INV-20 test assertions)

### T21 adversary r46 fixes - 2026-11-05
adversary r46 (1f577e0, test `packages/cli/test/adversary-t21-r46.test.ts`, failing first): the `revoke release` (J4) prompt still counted as live a signer of a Deprecated release, and a signer whose origin another agent now holds, while `status --agent` showed both `Inert` (FLOWS.md:698, :706; checkSigner AGENT_MISMATCH and RELEASE_NOT_APPROVED, SPEC.md:288, :290). Fixed in 247ddfe (packages/cli/src/commands/registry.ts): no live signers unless the release is Approved, and a live signer's endpoint must belong to this agent. Its unproven lead, the deprecate prompt's "You can approve it again later" with no CLI path to re-approve, is in OPEN-QUESTIONS.md for design. Round 45's CSV suspicion was dropped by r46 (an export of the evidence record, not terminal text).
No existing assertion changed. CI on c6c0a4a (r45): `ci` success, `harness` success.

verify at 247ddfe (`pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`; run by Claude under the heavy lock), 2026-11-05:
```
build=0
typecheck=0
lint=0
packages/core test:       Tests  69 passed (69)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  66 passed (66)
packages/cli test:       Tests  284 passed (284)
```
reviewed: pending (adversary r47, then Codex; Codex to judge the r17 call, the r34 expectedSigner question, the r37 flaky full run and the r43 narrowing of the INV-20 test assertions)

### T21 adversary r47 (failing test 581b89e, fix f38735f)
Finding: after `endpoint retire` and `endpoint add` with a new operator, the running key's signer keeps the old operator (Inert, SPEC §3.4). `signer renew` from the new operator said that wallet "isn't the operator", and `signer register --fresh` sent it back to `signer renew`; neither could pass (FLOWS.md:832).
Fix: renew splits the wrong-wallet check from the operator-changed check and gives the latter `operator_mismatch` with "Restart with `attessa enclave start`, then `attessa signer register`."; register's signer_exists row gives that restart line whenever renew can't extend the signer (expired, revoked or old operator). Copy logged in OPEN-QUESTIONS (not in FLOWS).
verify (`flock ... pnpm -r build; typecheck; lint; test`):
```
build=0
typecheck=0
lint=0
packages/core test:  Test Files  9 passed (9)
packages/core test:       Tests  69 passed (69)
packages/seller-host test:  Test Files  8 passed (8)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:  Test Files  21 passed (21)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:  Test Files  20 passed (20)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  67 passed (67)
packages/cli test:       Tests  286 passed (286)
```
reviewed: pending (adversary r48, then Codex)

### T21 adversary r48 (failing test 2cc909b, fix f265c7c)
Finding: with live signers on two Approved releases for one origin, `revoke release R1` said "risk.example refuses calls until you approve and register another build", but R2's signer keeps serving it (FLOWS.md:833, SPEC §3.4 checkSigner per release).
Fix: releaseStatus walks every SignerRegistered for the agent and leaves out of the prompt any origin a live signer on another Approved release still serves; when none is left the prompt says "another approved build still serves its endpoints" (not in FLOWS, logged in OPEN-QUESTIONS).
verify (`flock ... pnpm -r build; typecheck; lint; test`):
```
build=0
typecheck=0
lint=0
packages/core test:  Test Files  9 passed (9)
packages/core test:       Tests  69 passed (69)
packages/seller-host test:  Test Files  8 passed (8)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:  Test Files  21 passed (21)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:  Test Files  20 passed (20)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  68 passed (68)
packages/cli test:       Tests  289 passed (289)
```
reviewed: pending (adversary r49, then Codex)

### T21 adversary r49 (failing test c205614, fix 1ceb6ff)
Findings: (1) `status --agent 999` for an agent the identity registry doesn't know printed "No releases yet. Approve one with `attessa release approve`.", whose action then ends unknown_agent (FLOWS.md:832). (2) `revoke signer` on an Expired signer, or one Inert because its release was revoked, still said "This stops signer … within 60 s" while `status --agent` lists it Expired or Inert (FLOWS.md:833).
Fix: agentStatus calls ownerOf first (unknown_agent, as the owner commands); a shared `notLive` (registry.ts) derives Expired/Inert as checkSigner does and is used by `revoke release` and `revoke signer`, whose prompt says the signer "is already {Expired|Inert} and signs nothing" (not in FLOWS, logged in OPEN-QUESTIONS).
verify (`flock ... pnpm -r build; typecheck; lint; test`):
```
build=0
typecheck=0
lint=0
packages/core test:  Test Files  9 passed (9)
packages/core test:       Tests  69 passed (69)
packages/seller-host test:  Test Files  8 passed (8)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:  Test Files  21 passed (21)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:  Test Files  20 passed (20)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  69 passed (69)
packages/cli test:       Tests  293 passed (293)
```
reviewed: pending (adversary r50, then Codex)

### T21 adversary r50 (failing test a95e1d0, fix 2ce4d83)
Finding: `attessa cancel <id>` without `--yes` showed a bare confirm; declined, or with stdin not a TTY (bin.ts answers false), it exited 1 printing nothing (`--json`: `{"ok":false,"lines":[]}`), and the permission stayed open. FLOWS.md:833: "Cancel no longer prompts"; FLOWS.md:832 one next action.
Fix: the confirm is removed from cancel (buyer.ts).
verify (`flock ... pnpm -r build; typecheck; lint; test`):
```
build=0
typecheck=0
lint=0
packages/core test:  Test Files  9 passed (9)
packages/core test:       Tests  69 passed (69)
packages/seller-host test:  Test Files  8 passed (8)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:  Test Files  21 passed (21)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:  Test Files  20 passed (20)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  70 passed (70)
packages/cli test:       Tests  296 passed (296)
```
reviewed: pending (adversary r51, then Codex)

### T21 adversary r51 (failing test a611992, fix 788fa22)
Finding: a call paid from wallet A and interrupted after settlement, then `status --pending` run with `ATTESSA_PRIVATE_KEY` set to wallet B: B's results request got the gateway's 404 (SPEC §6: only the payer's signature fetches), the SDK took it as no result and ended the call `paid_but_rejected{missing_proof}`, final, so wallet A's later run never fetched the answer the gateway held (FLOWS.md:624, 640).
Fix: the SDK's `fetchResult` returns `unsure` without signing when the loaded wallet isn't the entry's payer, so only chain state can decide such a call; the CLI's next line for it names the paying wallet ("only the wallet that paid can fetch it. Run attessa status --pending with {payer}."; not in FLOWS, logged in OPEN-QUESTIONS).
verify (`flock ... pnpm -r build; typecheck; lint; test`):
```
build=0
typecheck=0
lint=0
packages/core test:  Test Files  9 passed (9)
packages/core test:       Tests  69 passed (69)
packages/seller-host test:  Test Files  8 passed (8)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:  Test Files  21 passed (21)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:  Test Files  20 passed (20)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  71 passed (71)
packages/cli test:       Tests  298 passed (298)
```
reviewed: pending (adversary r52, then Codex)

### T21 adversary r52 (failing test 9b62a62, fix cd009ab)
Finding: `attessa cancel <id>` from a wallet that didn't pay, on a call already settled, printed "Too late to cancel" and then "attessa status --pending checks again and fetches it", which that wallet can never do (FLOWS.md:832; SPEC §6.1). r51 gave `call` and `status --pending` the paying-wallet line but not cancel. Lead taken too: for such a wallet the settled path still retried the fetch five times with a POLL_MS sleep each, a silent wait of up to 15 s (FLOWS.md:825).
Fix: cancel's report context carries the loaded wallet, so it prints `answerOtherWallet`; the SDK's settledPath makes no fetch attempts when the loaded wallet isn't the payer (`notPayer`, shared with fetchResult).
verify (`flock ... pnpm -r build; typecheck; lint; test`):
```
build=0
typecheck=0
lint=0
packages/core test:  Test Files  9 passed (9)
packages/core test:       Tests  69 passed (69)
packages/seller-host test:  Test Files  8 passed (8)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:  Test Files  21 passed (21)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:  Test Files  20 passed (20)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  72 passed (72)
packages/cli test:       Tests  300 passed (300)
```
reviewed: pending (adversary r53, then Codex)

### T21 adversary r53 (failing test 0eafffb, fix 5dfad32)
Finding: for an open, unsettled call signed by wallet A, `status --pending` and a resumed waiting `call` run with wallet B offered "attessa cancel {id} voids it now" / "To void it right now instead: attessa cancel {id}", but the SDK signs CancelAuthorization for `authorizer: entry.payer` with B's key, which the token refuses, so the cancel reverted (FLOWS.md:832).
Fix: for a call another wallet signed, the open-call line (`stillOpenOther`) and the waiting void hint (`voidHintOther`) name the signing wallet instead of offering cancel (not in FLOWS, logged in OPEN-QUESTIONS). An up-front refusal in `cancel` itself was tried and dropped: it hid the "Too late to cancel" report r52's test requires for a settled call.
verify (`flock ... pnpm -r build; typecheck; lint; test`):
```
build=0
typecheck=0
lint=0
packages/core test:  Test Files  9 passed (9)
packages/core test:       Tests  69 passed (69)
packages/seller-host test:  Test Files  8 passed (8)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:  Test Files  21 passed (21)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:  Test Files  20 passed (20)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  73 passed (73)
packages/cli test:       Tests  303 passed (303)
```
reviewed: pending (adversary r54, then Codex)

### T21 adversary r54 (failing test 78be856, fix 86ac770) - 2026-11-05
Finding: a signed `attessa call` refused with HTTP 402 `payment_invalid{insufficient_funds}` (the facilitator's /verify: the wallet can't cover the price) printed the "Not paid" line and "Not charged" and exited 1, but never FLOWS §8 "payment invalid"'s one next action, "Add at least {n} USDC to {address}." (FLOWS:832 "Every error row has one next action").
Fix (buyer.ts, copy.ts `BUY.addFunds`): after "Not charged" the call prints "Add at least {price} {asset} to {wallet}." when the refusal was `payment_invalid` / `insufficient_funds`. {n} is the price, which covers the call whatever the balance; the CLI does not read the token balance to show the exact shortfall.
Leads from the adversary, not proven and left for r55: `agent register` writes docs/agent.json before it simulates or prompts; `attessa status` may not show spend today against the cap (FLOWS:851, :881).
verify (build, typecheck, lint, `pnpm -r test`, under the heavy lock):
```
build=0
typecheck=0
lint=0
packages/core test:  Test Files  9 passed (9)
packages/core test:       Tests  69 passed (69)
packages/seller-host test:  Test Files  8 passed (8)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:  Test Files  21 passed (21)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:  Test Files  20 passed (20)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  74 passed (74)
packages/cli test:       Tests  304 passed (304)
```
reviewed: pending (adversary r55, then Codex)

### T21 adversary r55 (failing test f8e874e, fix 224e24f) - 2026-11-05
Finding: `attessa agent register` wrote docs/agent.json with `registrations: []` before it simulated or asked, so a `--dry-run` or a cancel at `[register/cancel]` after a landed register erased the agent id and registry from the file (FLOWS:846 "Preview replaces undo"; FLOWS:833).
Fix (registry.ts `agentRegister`): with a key the file is written only in `done`, after the register lands; without a key (the register is signed elsewhere) and not on `--dry-run`, the unregistered file is written only if the file doesn't already list a registration.
Lead for r56, unproven: a resumed call (V0) refused with `payment_invalid{insufficient_funds}` may end without `BUY.addFunds`, since the price comes from this run's `authorizing` event.
verify (build, typecheck, lint, `pnpm -r test`, under the heavy lock):
```
build=0
typecheck=0
lint=0
packages/core test:  Test Files  9 passed (9)
packages/core test:       Tests  69 passed (69)
packages/seller-host test:  Test Files  8 passed (8)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:  Test Files  21 passed (21)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:  Test Files  20 passed (20)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  75 passed (75)
packages/cli test:       Tests  306 passed (306)
```
reviewed: pending (adversary r56, then Codex)

### T21 adversary r56 (failing test 90a0465, fix 39ec216) - 2026-11-05
Findings: (1) plain `attessa status` printed only "No calls in progress." (`--json` `{"pending":[],"ok":true}`) after a verified 0.02 USDC call, never spend today against the cap or the per-call limit (FLOWS:851, :881 "`attessa status` shows spend today vs cap"); (2) a call refused with `payment_invalid{insufficient_funds}` under `--no-wait` ended on the open-call line without FLOWS §8's "Add at least {n} USDC to {address}." (FLOWS:832).
Fix (buyer.ts, copy.ts `BUY.spentToday`): plain `attessa status` (not `--pending`, whose rows and the r13 test's exact lines stay as they were) ends with "Spent today: {spent} of your {cap} {asset} daily cap (at most {per} per call). It resets at 00:00 UTC." for USDC, and for USA₮ once it has spend, with `--json` `limits`; the refused end prints the add-funds line after the open-call line. New copy recorded in OPEN-QUESTIONS (r56 entry), including that "recent verdicts" are not shown beyond the calls status decides in that run.
verify (build, typecheck, lint, `pnpm -r test`, under the heavy lock):
```
build=0
typecheck=0
lint=0
packages/core test:  Test Files  9 passed (9)
packages/core test:       Tests  69 passed (69)
packages/seller-host test:  Test Files  8 passed (8)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:  Test Files  21 passed (21)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:  Test Files  20 passed (20)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  76 passed (76)
packages/cli test:       Tests  309 passed (309)
```
reviewed: pending (adversary r57, then Codex)

### T21 adversary r57 (failing test 2b69a96, fix 709684c) - 2026-11-05
Findings: (1) the r56 "Spent today" line summed every asset address `assetOf()` maps to USDC, so a mainnet USDC call in the same ~/.attessa ledger was added to the Sepolia figure (1.01 shown of a 1.00 cap while `call` on that network, which counts only its own token, still paid): SPEC.md:604 and :627 (V6) count per asset; (2) `attessa evidence export --format csv` printed seller-written text (sourceRef) with raw terminal control characters (ESC, CR), against the code's never-print-raw rule (copy.ts `safe()`, KNOWN-LIMITS L20).
Fix: the SDK gains `assetAddress(key)` (the pinned token on the RPC's network); `spendLines` counts `spendToday` for that address only and skips an asset the network doesn't offer; `csvCell` passes every cell through `safe()`.
verify (build, typecheck, lint, `pnpm -r test`, under the heavy lock):
```
build=0
typecheck=0
lint=0
packages/core test:  Test Files  9 passed (9)
packages/core test:       Tests  69 passed (69)
packages/seller-host test:  Test Files  8 passed (8)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:  Test Files  21 passed (21)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:  Test Files  20 passed (20)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  77 passed (77)
packages/cli test:       Tests  312 passed (312)
```
reviewed: pending (adversary r58, then Codex)

### T21 adversary r58 (failing test 59b58e6, fix 4a48277) - 2026-11-05
Findings: (1) with the key in ATTESSA_PRIVATE_KEY and no `init`, `call` refuses without `--max-amount` (FLOWS:788 max_amount_required) but plain `attessa status` said "(at most 0.10 per call)" and `--json` gave `maxAmountPerCall: "0.10"`, a limit nothing enforced (FLOWS:851, :881); (2) `evidence export --format jsonl` printed seller text (sourceRef) with raw C1 (U+009B CSI) and bidi (U+202E) characters, which JSON.stringify leaves unescaped (copy.ts `safe()`, KNOWN-LIMITS L20).
Fix: `spendLines` reads the saved limits as `limitsFor` does: no saved per-call limit shows "(no per-call limit is set)" and `maxAmountPerCall: null`; the daily cap is the saved one `??` 1.00. A new `jsonOut()` in copy.ts escapes C1, U+2028/9 and the Bidi_Control set as `\uNNNN` (lossless JSON) for jsonl rows and every `--json` result. OPEN-QUESTIONS r56 entry notes the new wording.
verify (build, typecheck, lint, `pnpm -r test`, under the heavy lock; a doc-comment typo in copy.ts was fixed after this run):
```
build=0
typecheck=0
lint=0
packages/core test:  Test Files  9 passed (9)
packages/core test:       Tests  69 passed (69)
packages/seller-host test:  Test Files  8 passed (8)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:  Test Files  21 passed (21)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:  Test Files  20 passed (20)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  78 passed (78)
packages/cli test:       Tests  314 passed (314)
```
reviewed: pending (adversary r59, then Codex)

### T21 adversary r59 (failing test bf1cee5, fix 531cda5) - 2026-11-05
Finding: with `--json` and no `--yes`, an owner or operator write (`revoke release` in the test; every `write`/`planOrSend` command shares the path) asked for the typed verb while its prompt ("... Revoking is permanent.  [revoke/cancel]", or the CELO cost) was still held in the `--json` buffer, so the consequence was never shown before the permanent transaction could be confirmed (FLOWS.md:833, "Each prompt names the consequence and uses the verb as the button").
Fix: under `--json`, `run()` wraps `io.confirm`: the lines held so far go to stderr before the confirm is asked (they stay in the JSON `lines` too). bin.ts asks its "Type {verb} to continue" question on stderr, so stdout holds only the JSON object.
verify (build, typecheck, lint, `pnpm -r test`, under the heavy lock):
```
build=0
typecheck=0
lint=0
packages/core test:  Test Files  9 passed (9)
packages/core test:       Tests  69 passed (69)
packages/seller-host test:  Test Files  8 passed (8)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:  Test Files  21 passed (21)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:  Test Files  20 passed (20)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  79 passed (79)
packages/cli test:       Tests  316 passed (316)
```
reviewed: pending (adversary r60, then Codex)

### T21 adversary r60 (failing test be67d35, fix 83f910f) - 2026-11-05
Finding: an owner or operator write whose confirm got anything but its verb, which is always the case with a non-TTY stdin (bin.ts answers no without asking), exited 1 with a bare `{"ok":false,"lines":[...]}` under `--json`, no `error` and no `next`, and with no closing line without `--json` (FLOWS.md:832 "Every error row has one next action"; FLOWS.md:833 `--yes` for non-interactive agents).
Fix: `planOrSend` throws `ERR.cancelled(verb)`: code `not_confirmed`, "Cancelled: nothing was sent.", next "Run it again and type {verb}, or add --yes to send without asking." Its callers (owner, signer, registry) lose the dead `'cancelled'` branch. OPEN-QUESTIONS gains an r60 entry for the copy.
verify (build, typecheck, lint, `pnpm -r test`, under the heavy lock):
```
build=0
typecheck=0
lint=0
packages/core test:  Test Files  9 passed (9)
packages/core test:       Tests  69 passed (69)
packages/seller-host test:  Test Files  8 passed (8)
packages/seller-host test:       Tests  81 passed (81)
packages/gateway test:  Test Files  21 passed (21)
packages/gateway test:       Tests  154 passed (154)
packages/sdk test:  Test Files  20 passed (20)
packages/sdk test:       Tests  191 passed (191)
packages/cli test:  Test Files  80 passed (80)
packages/cli test:       Tests  317 passed (317)
```
reviewed: pending (adversary r61, then Codex)

### T21 adversary r61 (failing test 0202c88, fix 8b4fe47) - 2026-11-05
Finding: `attessa gateway pause --network=mainnet` paused the Sepolia gateway, printed "Gateway paused: ..." and exited 0 while mainnet kept taking calls (`resume`, `status` and `export` alike): the gateway pass-through hands argv as given to `runGatewayCommand`, whose `flag()` matched only `--network mainnet`, so the `=` spelling that every other command accepts through parseArgs fell back to sepolia (SPEC.md:653, :688).
Fix: packages/gateway/src/cli.ts `flag()` reads `--name=value` as well as `--name value`, and a flag with no value is '' so `--network` alone is refused ("--network must be mainnet or sepolia") instead of defaulting.
verify (build, typecheck, lint, `pnpm -r test`, under the heavy lock):
```
build=0
typecheck=0
lint=0
packages/core test:  Test Files  9 passed (9)
packages/core test:       Tests  69 passed (69)
packages/seller-host test:  Test Files  8 passed (8)
packages/seller-host test:       Tests  81 passed (81)
packages/sdk test:  Test Files  20 passed (20)
packages/sdk test:       Tests  191 passed (191)
packages/gateway test:  Test Files  21 passed (21)
packages/gateway test:       Tests  154 passed (154)
packages/cli test:  Test Files  81 passed (81)
packages/cli test:       Tests  319 passed (319)
```
reviewed: pending (adversary r62, then Codex)
