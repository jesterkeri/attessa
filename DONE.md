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
