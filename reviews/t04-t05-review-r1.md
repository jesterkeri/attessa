# T04/T05 adversarial review r1

Protocol applied: `/home/hr/myvscode_linux/orca-sentinel/docs/REVIEW-PROTOCOL.md` (U1--U9).

## Findings

No critical, major, or minor findings.

The registry reads PCRs, `user_data`, and `public_key` only from `tbs` using validator-returned pointers; its stored attestation hash is `keccak256(tbs)`. `checkSigner` implements the specified first-failure order, including operator rotation eviction. The handler can drive the material state transitions for releases, endpoints, signers, renewal, revocation, and time advancement, and its ghost model is independently compared against `checkSigner`.

## Verification rerun

- `flock /home/hr/.cache/attessa-heavy.lock bash -lc 'cd contracts && forge test --match-path "test/unit/*" -vv && ../scripts/check-error-coverage.sh'`: 153 passed; all 24 custom errors named.
- `flock /home/hr/.cache/attessa-heavy.lock bash -lc 'cd contracts && FOUNDRY_INVARIANT_RUNS=256 FOUNDRY_INVARIANT_DEPTH=50 forge test --match-path "test/invariant/*" -vv'`: all INV-1--INV-8 and INV-24 properties passed over 12,800 handler calls.
- `scripts/mutate.sh`, run under the same lock in an isolated temporary clone to preserve this frozen working copy: all five patches printed `KILLED` and exited 0. Each compiled first; their semantic test failures were respectively `test_future_60s999ms_ok` (underflow), `test_registerSigner_NotOperator`, `test_check_OPERATOR_MISMATCH_afterRotation`, `test_DebugPcrs_pcr1`, and the fixture setup's `ReleaseNotApproved` after pointer offsets were deliberately applied to `attestation` instead of `tbs`.
- `flock /home/hr/.cache/attessa-heavy.lock bash -lc 'cd contracts && forge test --match-path "test/adv/*" -vv'`: 6 passed.

## U1--U9 record

U1: This was a single-prompt review, so the cold-read/inside-outside measurement is indicative rather than blind or rigorous. My independent checks before relying on the listed focal points included authority transitions, signer lifecycle/expiry, pointer-coordinate safety, signature recovery, and the handler's reachable state space.

U2: The completeness claims in the changed code and tests were enumerated against the relevant source. The "every field from tbs" claim covers PCRs, binding data, public key, and attestation hash; the "only" authority claim covers each mutating registry entry point; the mutation script's "every patch" loop covered all five patch files.

U3/U4/U5: No unnamed implementation invariant or changed value consumer within T04/T05 produced an actionable gap. In particular, renewal preserves identity fields while updating expiry/hash, and operator changes flow into both registration authorization and `checkSigner` validity.

U6: The immutable per-agent authority model is implemented without a registry-global administrative mutator. The inherited upgradeability of the external identity registry is an accepted, documented limit (L19), not re-reported.

U7: findings inside the prompt's stated concerns: 0; outside: 0. This count is indicative under U1.

U8: Not checked: a production Nitro attestation, certificate-cache path, and the <16M real-validator gas ceiling (deferred to T07/T16b); deployment bytecode/wiring (T10); cross-language vector agreement (T06); external ERC-8004/Self deployments; and unrelated gateway/SDK/enclave behavior. I did inspect the pinned validator source sufficiently to verify the pointer/TBS semantics relied on here.

U9: This review swept the complete T04/T05 implementation diff and directly relevant validator dependency, but was not a broader unscoped review of the remainder of the repository.

VERDICT: implementation-ready
