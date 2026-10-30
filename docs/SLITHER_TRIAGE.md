# Slither triage: EnclaveRegistry

Slither 0.11.6, 102 detectors, run as `cd contracts && slither . --config-file slither.config.json`. `slither.config.json` filters `lib/`, `test/` and `script/`, so only `src/` is analysed. The first run on `src/EnclaveRegistry.sol` at 0d9e8bd found 15 results. None were fixed in code: each is a false positive or accepted by design, for the reason given below.

Every triaged result is listed by its Slither id in `contracts/slither.db.json`, which Slither reads by default and uses to hide those results. The id hashes the finding's source, so editing a flagged function brings its finding back and it has to be triaged again. A new finding fails the command (exit 255).

| # | id (prefix) | Detector (impact) | Where | Verdict |
|---|---|---|---|---|
| 1 | 80700e41d7c3 | encode-packed-collision (High) | `_releaseIdOf`, L511-517 | false positive |
| 2 | 80a86ec09c1b | encode-packed-collision (High) | `approveRelease`, L271-289 | false positive |
| 3 | 40dfb01229a7 | incorrect-equality (Medium) | `checkSigner`, L412 | false positive |
| 4 | fd741bdefe76 | incorrect-equality (Medium) | `checkSigner`, L413 | false positive |
| 5 | 498b01bbe95e | reentrancy-no-eth (Medium) | `renewSigner`, L369-385 | accepted |
| 6 | 7a975c3815ff | reentrancy-benign (Low) | `registerSigner`, L341-367 | accepted |
| 7 | 4af4090b8b78 | reentrancy-events (Low) | `registerSigner`, L341-367 | accepted |
| 8 | ce72229a608c | reentrancy-events (Low) | `renewSigner`, L369-385 | accepted |
| 9 | 6644011e32c7 | missing-zero-check (Low) | constructor `identityRegistry_`, L239 | accepted |
| 10 | b833d434e047 | missing-zero-check (Low) | constructor `nitroValidator_`, L239 | accepted |
| 11 | e0141419858e | missing-zero-check (Low) | constructor `selfRegistry_`, L239 | by design |
| 12 | 353954dca46f | timestamp (Low) | `_verifyAttestation`, L482-508 | by design |
| 13 | 40d707e93546 | timestamp (Low) | `renewSigner`, L369-385 | by design |
| 14 | 81a1016ae935 | timestamp (Low) | `checkSigner`, L405-423 | by design |
| 15 | 97984c41f98a | timestamp (Low) | `verifyProof`, L425-441 | by design |

## 1, 2. encode-packed-collision

`releaseId = keccak256(abi.encodePacked(pcr0, pcr1, pcr2))` is the format SPEC §2.2 fixes ("each PCR as its raw 48 bytes"), and the T03 vectors pin it across TypeScript, Rust and Solidity. A packed collision needs two dynamic arguments whose lengths can shift. Neither path allows that:

- `approveRelease` rejects any PCR that is not exactly 48 bytes, through `_validPcr` (L550). Tested by `test_approveRelease_InvalidPcr_length`.
- `_releaseIdOf` reads each PCR through `_pcrAt`, which reverts `InvalidPcr` when the PCR is null or not 48 bytes (L545). Tested by `test_InvalidPcr_null` and `test_InvalidPcr_lengthShiftCollision`, which builds a 64 ‖ 32 ‖ 48 split that concatenates to the same bytes as an approved release and checks that it reverts.

## 3, 4. incorrect-equality

The detector targets strict equality on balances or timestamps, which an attacker can nudge. These compare a `SignerStatus` enum the contract alone writes, so strict equality is the correct check.

## 5 to 8. reentrancy

The only external calls are to `nitroValidator`, which is fixed at construction (SPEC §3: constructor arguments are immutable). T10's `check-deploy.mjs` checks that address against the compiled production NitroValidator and CertManager wiring. The validator does no callback to its caller, and no ETH moves.

The state written after the call depends on the call's result (signer, releaseId, attestation hash), so checks-effects-interactions cannot reorder it. The guards before the call (`s.status`, endpoint status and operator in `renewSigner`; `EndpointInactive`, `EndpointMismatch` and `NotOperator` in `registerSigner`) are re-established for any re-entry, because every path re-runs them. A reentrancy guard would add gas to a transaction whose headroom under the 16,000,000 cap is already about 1.45M (T07, OPEN-QUESTIONS), so it was not added.

## 9, 10. missing-zero-check on `identityRegistry_`, `nitroValidator_`

SPEC §3 names only `selfRegistry` as allowed to be zero. A zero `identityRegistry` or `nitroValidator` gives a registry where every owner action and every registration reverts. That is useless, but it fails closed. The contract is immutable, so the fix is to redeploy. T10's `check-deploy.mjs` checks the wiring before any address is published. No code change was made: it would add an error SPEC §3.3 does not list, to a contract under review.

## 11. missing-zero-check on `selfRegistry_`

By design. SPEC §3 constructor: "`selfRegistry` may be zero (linking disabled)". `linkSelfAgent` reverts `SelfDisabled` in that case (L250).

## 12 to 15. timestamp

The windows SPEC §3.4 defines use `block.timestamp`:

- attestation age ≤ 1,800 s, and at most 60 s in the future;
- the signer TTL;
- the proof `expiresAt`, and `issuedAt` skew ≤ 120 s.

Celo's block proposer can shift the timestamp by far less than these windows, and the boundaries are tested at ±1 s (T04: 1799/1800/1801 s, +59/+60/+61 s, 120/121 s).
