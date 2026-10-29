# ADR-003: Key in `public_key`, context in `user_data`, freshness by the NSM timestamp (no on-chain challenge)

- Status: accepted. **Deviates from the brief** (§5.2 put the key in `user_data`; §6 asked for a verifier-issued challenge in `nonce`).
- Context: the registry must bind an enclave key to (chain, registry, agent, origin) and refuse stale or replayed attestations.
- Options:
  1. Key in `public_key` (65 bytes) as base/op-enclave does; binding in `user_data`; freshness from the AWS-signed timestamp within 30 min.
  2. Key in `user_data` + an on-chain challenge nonce issued by a separate tx.
  3. Off-chain challenge from a buyer.
- Decision: (1).
- Why:
  - The NSM timestamp is signed by AWS, so it's already a trusted freshness source.
  - Replaying a fresh attestation can only re-register the same enclave key (`SignerExists`).
  - A challenge tx adds a sixth transaction inside a 3 h leaf-cert window and new state.
  - op-enclave sets the precedent for the key in `public_key`.
- Consequences:
  - We give up proof that a specific verifier challenged this enclave.
  - Buyer-level freshness ("running right now") comes from the off-chain liveness challenge instead (SPEC §2.3).
  - ~~The 30-minute window means `enclave start` → `signer register` must finish within 30 minutes.~~ Corrected in r2 below.
- Confirmation: unit tests at the window boundaries; a key-substitution test (there's no address parameter at all).

## Amendment r2 (design review r1, findings 1, 25, 31)

- The 30-minute window bounds the **attestation's** age at registration, not the key's age or the operator's deadline. The enclave returns a fresh attestation for the same key at any time (`{"type":"attest"}`), so a missed window is repaired with `attessa signer register --fresh`, never by restarting the enclave.
- `configure` is one-shot per boot (INV-22), so one key can't be bound to two chains, registries, agents or origins.
- Every field is read from `tbs` through the validator's `Ptrs` (SPEC §3.4 step 2). `attestationHash = keccak256(tbs)`, which is canonical: the unsigned unprotected header and P-384 signature malleability don't change it.
