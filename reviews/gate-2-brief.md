# Gate 2 review brief (T11)

Codex: you are the Gate 2 reviewer. This gate was not reviewed when the work passed it; later work continued while it stayed open. Review it now as if nothing later depended on it. A finding here can stop a mainnet deployment.

## Scope

Commit `25c768d` on `feat/gate-2`. Gate 2 ships EnclaveRegistry, its tests, and the Sepolia deployment with the production CertManager (SPEC §11, tasks T02 to T11).

Main paths: `contracts/src/EnclaveRegistry.sol`, `contracts/test/`, `contracts/mutations/`, `scripts/mutate.sh`, `contracts/script/`, `scripts/check-deploy.mjs`, `docs/DEPLOYMENTS.md`, `docs/SLITHER_TRIAGE.md`, `packages/core/src/deployments.ts`, `vectors/`.

Later changes in the same contract area, for example the tagged mainnet deploy route on `feat/t30-mainnet-deploy` (PR 21), are not on this commit and have their own review.

## Claims to attack (SPEC §11)

- **C2.1** SPEC §3.4 is enforced, and fields are read from `tbs` only.
- **C2.2** INV-1 to INV-8 hold under fuzz.
- **C2.3** `registerSigner` stays under 16M gas.

Evidence for a claim counts only if you can reproduce it, or it is a chain read you made yourself.

## Evidence the author collected at this commit

`forge test`:
```

Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 132.90s (132.89s CPU time)

Ran 11 test suites in 132.90s (138.46s CPU time): 242 tests passed, 0 failed, 3 skipped (245 total tests)
```
Skipped in that run, because they run only on a Sepolia fork:
```
[SKIP] test_realFixture_a_registerReverts_BindingMismatch0() (gas: 0)
[SKIP] test_realFixture_b_paddedUnprotectedHeader_sameTbsSameRevert() (gas: 0)
[SKIP] test_realFixture_c_validateGas_under16M() (gas: 0)
```
The same three tests with `forge test --match-path 'test/fork/RealFixture.t.sol' --fork-url https://forno.celo-sepolia.celo-testnet.org -vv`:
```
[PASS] test_realFixture_a_registerReverts_BindingMismatch0() (gas: 28817506)
[PASS] test_realFixture_b_paddedUnprotectedHeader_sameTbsSameRevert() (gas: 42965196)
[PASS] test_realFixture_c_validateGas_under16M() (gas: 45904844)
  validateAttestationWithHints gas (measured)            : 12994642
  validateAttestationWithHints gas (projected post-Fusaka): 13907842
  registerSigner gas to BindingMismatch (measured)       : 13104719
  registerSigner tx gas (projected post-Fusaka, calldata): 14547623
  hint bytes / MODEXP calls                              : 27312 3044
Suite result: ok. 3 passed; 0 failed; 0 skipped; finished in 6.89s (973.36ms CPU time)
```
`FOUNDRY_INVARIANT_RUNS=256 FOUNDRY_INVARIANT_DEPTH=50 forge test --match-path 'test/invariant/*'`:
```
Ran 1 test for test/invariant/RegistryInvariants.t.sol:RegistryInvariants
[PASS]
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
Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 12.24s (12.24s CPU time)
Ran 1 test suite in 12.25s (12.24s CPU time): 1 tests passed, 0 failed, 0 skipped (1 total tests)
```
`forge coverage --report summary --match-path 'test/*'`:
```
| File                               | % Lines            | % Statements       | % Branches       | % Funcs          |
| src/EnclaveRegistry.sol            | 100.00% (207/207)  | 100.00% (298/298)  | 100.00% (61/61)  | 100.00% (29/29)  |
| Total                              | 94.04% (1958/2082) | 93.38% (2453/2627) | 81.80% (337/412) | 92.07% (151/164) |
```
`slither . --config-file slither.config.json`:
```
'forge config --json' running
'forge build --build-info --deny never --skip ./test/** ./script/** --force' running (wd: /home/hr/myvscode_linux/attessa/.worktrees/build-gate-2/contracts)
INFO:Slither:. analyzed (11 contracts with 102 detectors), 0 result(s) found
```
`node scripts/check-deploy.mjs celo-sepolia`, last lines:
```
OK    CertManager.revoker() == 0xd32af5b881ec424435eca3262065537dccb64e65
OK    EnclaveRegistry.allowLocalOrigins() == false
OK: all 27 checks passed
```

## What the author knows is weak

- CI's `contracts` job does not run the three real-fixture tests; they skip off a Sepolia fork.
- `scripts/check-deploy.test.mjs`: 6 of 11 tests fail, the same on staging. Their fixtures expect placeholder addresses, and the file is not in CI. The live `check-deploy` output above is separate.
- The fixture's signer does not match the registry's binding, so the real-fixture `registerSigner` tests stop at `BindingMismatch(0)`. A successful registration with a real attestation on the public Sepolia registry (T16, T16b) has not happened. A rehearsal on a local mainnet fork registered a real signer at 14,639,544 gas (`docs/REHEARSAL.md`, branch `feat/rehearsal-fixes`), not reviewed here.
- `forge coverage` was run with `--match-path 'test/*'` as TASKS T09 states. Check that this covers what T09 claims.

## Known limits (do not re-report)

KNOWN-LIMITS.md, verbatim:

# Known limits (r5)

Accepted tradeoffs, simplifications and things deliberately not solved. Reviews are told not to re-report anything here unless the statement itself is wrong.

| # | Limit | Why accepted | Recorded at | Revisit at |
|---|---|---|---|---|
| L1 | In the demo the gateway operator is also the seller, so Mode B doesn't protect a buyer from a dishonest seller | The gateway is designed as the marketplace's step (ADR-006); the buyer's protection rests on the 120 s window, cancel, payTo binding, independent re-verification and chain-confirmed "not charged" | design 2026-10-19 | Frontier M2 (buy integration) |
| L2 | Mode A (paying through buy) has no payment protection; we only check after paying | buy settles before calling upstream; out of our control | design | M2 |
| L3 | CertManager owner/revoker is a single cold EOA, not a multisig | Its only power is DoS on new registrations; immutable registry has no admin | design | M1 (Safe 2-of-3) |
| L4 | Attestation proves which code produced a response, not availability: the operator can withhold, delay or reorder | Inherent to TEEs | design | never |
| L5 | Request bodies are visible to the gateway and parent | MVP requests are public chain addresses | design | M3 (encrypt to the enclave key) |
| L6 | **(r3)** The enclave's clock (`issuedAt`) comes from the host. The gateway and `verifyProof` accept a proof only while `|issuedAt − now| ≤ 120` s, so a fresh proof is usable for at most 240 s after real issuance (the 600 s `expiresAt` never binds first). The SDK judges paid results against the signing time and settlement block instead (SPEC §7 V10), so a host can shift `issuedAt` by at most 120 s there too. Registration freshness uses the AWS-signed timestamp | Bounded; fixing it needs a trusted time source in the enclave | design r2 | M3 |
| L7 | `checkSigner`/`verifyProof` answer "valid now"; "approved at execution time" is reconstructed from events off chain | ADR-013 | design | M1 (`attessa audit`) |
| L8 | One endpoint = one origin; no path-prefix binding | Enough for one seller; buy-style multi-capability origins need path binding | design | M2 |
| L9 | Proofs travel in an HTTP header; a proxy that strips headers (possibly buy's gateway) loses them | An envelope format is a breaking design choice best made with buy | design | M2 |
| L10 | Ephemeral key per boot; every restart costs a registration (4–6 CELO ≈ $0.33–0.49 warm, up to ~8.3 CELO ≈ $0.68 cold) and brief downtime. Renewing a running key (`renewSigner`) costs about the same but has no downtime | Keys never leave the enclave without KMS sealing | design | M3 |
| L11 | **(r2)** The Self Agent ID link is informational only; nothing on chain requires it (ADR-014 supersedes ADR-009). Only Self's `linked` mode passes the link check | Self ABI and its upgradeable proxy make enforcement on an immutable registry risky | design r2 | M1 |
| L12 | USA₮ settles only on mainnet (facilitator Sepolia supports USDC only) | Facilitator support | design | n/a |
| L13 | Inputs are auditable only because this workload's inputs are public chain facts; other workloads won't have that | Workload choice (ADR-012) | design | M3 |
| L14 | Gateway is a single instance with SQLite | Demo scale (ARCHITECTURE §7) | design | 100x |
| L15 | All broadcasts (Sepolia included) are run by Joshua, not the builder | Harness `guard-bash.sh` blocks `--broadcast` | design | if Joshua relaxes it for Sepolia (OPEN-QUESTIONS) |
| L16 | A malicious RPC can lie to the SDK about registry state | Same trust as any dapp; users choose `--rpc` | design | never |
| L17 | **Origin squatting.** ERC-8004 registration is permissionless and `addEndpoint` doesn't prove control of the origin, so anyone can bind an origin first and block the real seller on that registry forever (no admin). Buyers are still safe: the SDK cross-checks `.well-known` agentId and payTo | Proving origin control on chain needs an oracle. Mitigation: add the demo origin the same day the registry is deployed, before announcing either (T31) | design r2 | M1 (challenge served from `.well-known`) |
| L18 | **AWS CRLs aren't monitored.** base's docs say an operator should watch AWS CRLs and revoke in CertManager; we don't run that process, so an AWS-revoked intermediate stays trusted until its cache entry expires | Solo build; AWS intermediate revocations are rare; new registrations re-validate expiry | design r2 | M1 (cron monitor) |
| L19 | **Upgradeable upstream registries.** The ERC-8004 Identity Registry (ERC-1967 proxy, owner EOA `0x5472…2603`) and the Self registry are upgradeable. Whoever holds those keys can rewrite `ownerOf` (so approve builds and change endpoints for any agent) or fake a Self link | The hackathon requires the reference ERC-8004 registry; our registry can't be more trustworthy than `ownerOf` | design r2 | M2 (snapshot ownership or own identity) |
| L20 | **`sourceRef` is the owner's unverified claim.** Buyer copy says "owner says it's built from …" until S3 passes and `attessa release verify` reproduces the PCRs | Reproducibility is a spike (S3) and a G6 option | design r2 | after S3 |
| L21 | **Confirming "not charged" takes time.** After a refusal the buyer waits until a block past `validBefore + 5` (up to ~125 s), or cancels (costs gas) | x402 authorizations stay valid until validBefore; any earlier answer would be a guess | design r2 | M2 (escrow) |
| L23 | The SDK re-reads input values at the inputs block only if the buyer's RPC still serves that state; otherwise evidence says `inputsChecked:false`. The gateway always re-reads them before settling (design review r3 measured: mainnet Forno ≥ 200,000 blocks of state, Sepolia Forno ~10,000). The same applies to V10's signer-status read at the settlement block, which falls back to events, then to `uncertain{rpc_unavailable}` | Archive state isn't guaranteed on public RPCs | design r3 | n/a |
| L22 | The operator picks the inputs block. It's bounded (≤ 300 s old, hash checked by gateway and SDK) but within that window an operator can choose which block to read | Chain state of an address rarely changes inside 5 minutes; the block is in the signed response | design r2 | M3 |
| L24 | **Review gate history.** Joshua stopped the Opus design review after r3 (0 critical, 2 major, 9 minor). Codex reviewed r4, found the unavailable Sepolia v1 paid path and an unsafe pre-expiry settlement terminalization, and r5 fixes both. The r5 self-check is recorded in `reviews/design-review-r4-codex.md`. | Time; Codex is the per-gate reviewer anyway | Joshua, 2026-10-19 | before T02 |

## Output

Write `reviews/gate-2-review.md`: findings ranked critical, major, minor, each with path:line, the rule it breaks and a reproduction. Apply `/home/hr/myvscode_linux/orca-sentinel/docs/REVIEW-PROTOCOL.md` U1 to U9. End with `REVIEW DECISION: SHIP`, `REVISE` or `REJECT`, then `VERDICT: implementation-ready` or `VERDICT: changes required`.
