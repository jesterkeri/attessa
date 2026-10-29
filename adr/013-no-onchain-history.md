# ADR-013: Current-state checks on chain; historical "approved at execution time" reconstructed from events off chain

- Status: accepted (MVP).
- Context: the brief asks that historical evidence can check "approved at execution time" while new executions use current policy.
- Options:
  1. Current state on chain + events; the SDK reconstructs history from logs when asked.
  2. Checkpointed status history in storage.
  3. Ignore history.
- Decision: (1).
- Consequences:
  - `verifyProof` and `checkSigner` answer "valid now".
  - `attessa audit` (M1) answers "was valid at block N" from `ReleaseStatusChanged` / `SignerRevoked` logs.
  - We give up on-chain historical queries.
- Confirmation: KNOWN-LIMITS L7.
