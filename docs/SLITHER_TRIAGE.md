# Slither triage: EnclaveRegistry

Slither 0.11.6, 102 detectors, run as `cd contracts && slither . --config-file slither.config.json`. `slither.config.json` sets `include_paths` to `contracts/(?!lib/nitro-validator/)` and `exclude_dependencies` to false: a result is reported whenever any of its elements is outside the pinned `lib/nitro-validator` submodule (its own dependencies under `lib/nitro-validator/lib/` included), even if it also touches that submodule. Slither builds with `forge build --skip ./test/** ./script/** --force`, so the analysis holds exactly what the contracts in `src/` compile from: a file in `test/`, `script/`, `lib/` or any other folder under `contracts/` is analysed and reported as soon as a `src/` contract imports or inherits from it, and test and script files no `src/` contract imports are not built. Results only in `lib/nitro-validator/` are dropped, on purpose: the pinned nitro-validator stack (P384Verifier, CertManager, NitroValidator) is deployed but unmodified and pinned at 0ea0d12 (adr/001), and a full-stack run on it reported no High and 21 Mediums (uninitialized-local, write-after-write in vendor/ECDSA384, divide-before-multiply, unused-return), so a High in the validator would not fail this gate. If the checkout itself sits under a folder named `contracts/`, the regex also matches that outer folder and lib results come back; with `--fail-high` this still exits 0, but the plain command lists them. Before Slither runs, the CI slither job refuses two things under `contracts/`, after the recursive submodule checkout. First, any symlink (`find contracts -type l`), committed or inside a submodule, because Slither resolves a symlink before matching `include_paths`, so a symlinked file could point outside the scope. Second, any file containing the text `slither-disable` (`grep -rn` over every folder, `lib/` included; it runs before any build, so no `out/` or `cache/` exists yet), because Slither honours `// slither-disable-next-line`, `slither-disable-start` and `slither-disable-end` in any file a result touches and would drop that result without an id. A grep error also fails the step. Files outside `contracts/` are not scanned: foundry compiles them only if `foundry.toml` adds them to `allow_paths`. `exclude_dependencies` stays off because crytic-compile treats any absolute path with a `lib` folder in it as a dependency, which would hide every result if the checkout itself sat under a `lib/` folder. Run it from `contracts/`: Slither finds `slither.db.json` relative to the working directory, so the repo-root form fails closed with all 16 results. (The earlier `filter_paths "lib/|test/|script/"` dropped any result with a matching element and would also have hidden a src file named like `Transcript.sol`.) The first run on `src/EnclaveRegistry.sol` at 0d9e8bd found 15 results; the switch to `include_paths` surfaced a 16th (pragma). None were fixed in code: each is a false positive or accepted by design, for the reason given below.

Every triaged result is listed by its Slither id in `contracts/slither.db.json`, the only place a result may be suppressed, which Slither reads by default and uses to hide those results. In Slither 0.11.6 the id hashes the function's canonical name, the message text and the flagged expression with its line number (`utils/output.py`). Guards and the rest of the function are not hashed, so a change that leaves the flagged line in place (for example removing a length check) keeps the finding suppressed. A suppression is not re-review: any change to a function listed here needs its triage re-read, and the unit and invariant tests, not Slither, are what catch a removed guard. A new finding fails the command (exit 255).

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
| 16 | 4b6e69a12a80 | pragma (Informational) | `src/EnclaveRegistry.sol` 0.8.26 vs `lib/nitro-validator` ^0.8.15 | by design: the dependency is pinned at 0ea0d12 (adr/001) and compiles under the same solc 0.8.26 set in foundry.toml; hidden before only because the old filter_paths dropped any result with a lib/ element |

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
