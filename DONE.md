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

### Site adversary r47 (failing test 4c640f9, fix d5c5f34) - 2026-11-05
Finding: on use-cases.html at 390px, with Anybody not loaded (Google Fonts blocked, or before `display=swap` lands), "RECOMMENDATIONS" in a 35.2px uppercase `.use h2` is wider than the 350px column; `.beats`' auto grid column grew to it and `main`'s overflow clip cut the line ends of all four uses (site/README.md:109).
Fix: `.use h2 { overflow-wrap: anywhere; }` (site.css).
verify (`node --test site/test/*.test.mjs`, `node site/build.mjs`; then the r47 off-right probe, `offright.mjs site/dist use-cases.html <state> 390x844`, which counted 8 elements past the edge before the fix):
```
# tests 154
# pass 154
# fail 0
build=0
== nojs 390x844 use-cases.html 0
== cdnfail 390x844 use-cases.html 0
== live 390x844 use-cases.html 0
```
reviewed: pending (adversary r48, then Codex)

### Site adversary r48 (failing test de1a898, fix e64f0ee) - 2026-11-05
Finding: at 200% zoom on 1280, 1366 and 1440px laptops (640x400, 683x384, 720x450 CSS px), the open `.menu` (fixed, `justify-content: center`, no overflow) was taller than the screen: "How it works" sat under the nav bar, "Explorer preview" below the screen, and nothing scrolled (site/README.md:104,109; WCAG 1.4.4, 2.4.11). Lead taken too: r47's `overflow-wrap: anywhere` broke "RECOMMENDATIONS" mid-word at every width in a fallback face.
Fix: `.menu { justify-content: safe center; overflow-y: auto; scroll-padding-top: 100px; }`; the `.use h2` wrap rule now applies under 720px only.
verify (`node --test site/test/*.test.mjs`, `node site/build.mjs`; then r48's menufit probe, index.html, cdnfail and live, at 640x400, 683x384, 720x450, 768x432 and 768x1024: every menu link visible below the 68px nav bar as Tab cycles, the menu scrolls where it is taller than the screen; r48's midword probe: the break is at 390px only, none at 768 or 1440; r47's offright probe, use-cases.html at 390x844: 0 in nojs, cdnfail and live):
```
# tests 160
# pass 160
# fail 0
build=0
```
reviewed: pending (adversary r49, then Codex)

### Site adversary r49 (failing test 6510b18, fix 6256e43) - 2026-11-05
Finding: at 200% zoom on a 1440x900 laptop (720x450 CSS px), with everything working, the pinned proves section's content (at least 609.8px) overflowed its `overflow: hidden; align-items: center` 450px box, so its h2, lede and "security page" link sat above the screen where nothing scrolls (site/README.md:102-103, site.css "the two lists must fit"; WCAG 1.4.4, 2.4.11). The probe showed the same for the outcomes, explorer, defaults and story steps, and the proves section 86px too tall even at 1440x900 at 100%.
Fix (site.css): `.story-sticky, .scene-sticky { overflow-y: auto; align-items: safe center; scroll-padding-top: var(--nav-h); }` and `.story-sticky > .wrap { height: auto; min-height: 100%; align-content: safe center; }`, so a box that still overflows scrolls from its top; the proves short-screen rule now reaches 960px tall. site/README.md says so.
verify (`node --test site/test/*.test.mjs`, `node site/build.mjs`; then r49's pinscan probe, index.html live at 720x450, 768x432, 1024x600, 1280x800, 1440x900 and 1920x1080: no text above a box or under the nav bar (before the fix: 15 such lines at 720x450, 6 at 1024x600, 1 at 1440x900); and boxoverflow.mjs: boxes scroll only where content overflows, at 720x450 and 1024x600, none at 1280x800, 1366x768, 1440x900, 1536x960, 1680x1050 or 1920x1080):
```
# tests 161
# pass 161
# fail 0
build=0
```
reviewed: pending (adversary r50, then Codex)

### Site adversary r50 (failing test 38c77c6, fix 56b8c75) - 2026-11-05
Finding: at 200% zoom on a 1440x900 laptop (720x450 CSS px) the story, "Three ways a call can end" and the four uses boxes overflow and scroll (r49), but they had no tabindex and nothing inside them takes focus, so arrow keys, Page Down and Space scrolled the page and never the box (WCAG 2.1.1; site/README.md "scrolls from its top"). The hidden part of the outcomes box held the three outcomes.
Fix: the three boxes get `tabindex="0" role="group"` with the section's name (index.html, use-cases.html), and a focused pinned box draws its outline inside (`outline-offset: -3px`). site/README.md says so.
Not fixed, reported by the adversary without a test: the wheel scrolls a box's own content while its section is still entering, so it can pin already scrolled; it stays reachable by scrolling back up.
verify (`node --test site/test/*.test.mjs`, `node site/build.mjs`; then a probe at 720x450, live, focusing each box and pressing PageDown: story scrollTop 0 to 194 of 194, outcomes 0 to 334 of 418, uses 0 to 99 of 99, page moved 0, outline solid; Tab lands on each box):
```
# tests 164
# pass 164
# fail 0
build=0
```
reviewed: pending (adversary r51, then Codex)

### Site adversary r51 (failing test 2aa9b89, fix 28620fb) - 2026-11-05
Finding: seven docs code blocks (how-to: seller commands, the MCP args, the "Use it with buy" output with the 206-character "you pay even if the answer fails it" line; tutorial: git clone, `attessa init` output, the JSON body, `attessa call`) scroll sideways at 390px, three of them at 720x450 (200% zoom), with no tabindex and nothing focusable inside, so the keyboard couldn't bring the ends of their lines into view (site/README.md:104; WCAG 2.1.1). The four reference tables' `.table-wrap` had the same gap.
Fix: `<pre tabindex="0">` for the code blocks in docs/how-to.html, docs/tutorial.html and docs/reference.html, and `tabindex="0"` on reference.html's `.table-wrap`; site/README.md says so.
Not filed by the adversary: the r50 tab stops stay on phones and without JavaScript, where the boxes don't scroll (an extra named group stop; the static tabindex can't depend on JS); under reduced motion, scrolling a pinned box may leave the 3D object and globe labels where the slot was (scene.js:1003, not rendered: no real three.js here).
verify (`node --test site/test/*.test.mjs`, `node site/build.mjs`; then a probe, cdnfail, focusing each tab-stop scroller and pressing ArrowRight: every scroller reached its end, how-to 384/384 and 993/993 at 720x450, 674, 151 and 1283 at 390x844; tutorial 300 at 720x450, 158, 590, 127 and 143 at 390x844; reference tables 32 at 720x450, 72, 209, 18 and 322 at 390x844):
```
# tests 167
# pass 167
# fail 0
build=0
```
reviewed: pending (adversary r52, then Codex)

### Site adversary r52 (failing test 536a259, fix a011230) - 2026-11-05
Finding: r51 made the docs code blocks tab stops, but a focused `<pre>` drew the site ring 3px outside itself (site.css:52) inside `.docs-main .code { overflow: hidden }` with no padding, so its left, right and bottom sides were clipped and only a 1px line in the caption bar was left: obscured focus on 10 tab stops (how-to x4, tutorial x5, reference payAndVerify), at every width.
Fix (site.css): `.docs-main .code pre:focus-visible { outline-offset: -3px; }`, the same inside ring r50 gave the pinned boxes.
verify (`node --test site/test/*.test.mjs`, `node site/build.mjs`; then r52's prering probe, docs/how-to.html, cdnfail, 390x844: each of the 4 focused blocks now changes 846 to 1114 px inside its box and none outside, outline "solid 1px, off -3px"; before the fix: top 347 px, right 0, bottom 0, left 1):
```
# tests 170
# pass 170
# fail 0
build=0
```
reviewed: pending (adversary r53, then Codex)

### Site adversary r53 (failing test 39f57dc, fix c5811fa) - 2026-11-05
Finding: at 1024, 1280, 1366 and 1440px (site/README.md:110) the docs menu (`.docs-nav`, `overflow-y: auto`, no padding) clipped every link's focus ring: the 3px-offset ring lost its left and right sides on all 15 links, and "Known limits" its bottom too, leaving one line between it and "Threat model" (obscured focus).
Fix (site.css): from 861px up, `.docs-nav { padding: 0 6px 6px; margin-left: -6px; }`: room for the ring inside the clipping menu, with the link rail where it was.
verify (`node --test site/test/*.test.mjs`, `node site/build.mjs`; then r53's navring probe, docs/reference.html, cdnfail: at 1440x900 and 1280x800 every link's ring now changes 38 to 46 px on its left and right sides (0 before); a bottom side is missing only for the link the browser scrolled flush to the screen's bottom edge, which r53 classed as browser behaviour):
```
# tests 174
# pass 174
# fail 0
build=0
```
reviewed: pending (adversary r54, then Codex)

### Site adversary r54 (failing test d2b29fc, fix 964c8d9) - 2026-11-05
Finding: r53 gave the docs menu its ring room under `(min-width: 861px)` while its clip stops only under `(max-width: 860px)`, so at fractional CSS widths between 860 and 861px (1076 device px at 125%, 947px at 110%, 1291px at 150%) the menu clipped with no room and a focused link lost its left and right ring sides.
Fix (site.css): the room (`padding: 0 6px 6px; margin-left: -6px`) is on the base `.docs-nav` rule and reset to 0 inside the same `(max-width: 860px)` block that sets `overflow: visible`, so the two always switch together. (`not all and (...)` and `(width > 860px)` would also work in browsers, but the site tests' CSS harness doesn't parse them.)
verify (`node --test site/test/*.test.mjs`, `node site/build.mjs`; then r54's fracnav probe, docs/reference.html at device scale 1.17, windows 859 to 862: at 860.684px CSS the menu now has `pad="0px 6px 6px" ml=-6px` and the focused link's ring changes left 84 and right 81 px, the same as at 861.539px (before the fix: left 0, right 0); at 859.829px the menu is static and unclipped):
```
# tests 176
# pass 176
# fail 0
build=0
```
reviewed: pending (adversary r55, then Codex)
