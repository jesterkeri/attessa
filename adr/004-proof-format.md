# ADR-004: EIP-712 ExecutionProof with requestId, paymentId and inputsHash; keccak256 everywhere

- Status: accepted.
- Context: buyers, gateways and contracts must check what produced a response, for which request and which payment.
- Options:
  1. EIP-712 typed struct (domain = registry + chainId).
  2. A raw signature over a concatenated hash.
  3. JWS/COSE from the enclave.
- Decision: (1) with the fields in SPEC §2.3. Two fields are added to the brief's list:
  - `inputsHash`, so the operator's inputs are auditable
  - `issuedAt`
- Hashes are keccak256 for EVM-native verification.
- Consequences:
  - The wallet-readable domain name "AttestedExecution".
  - `verifyProof` is usable on chain.
  - We give up SHA-256 interop with non-EVM verifiers (they can still compute keccak).
- Confirmation: `vectors/eip712.json` checked in all three languages (INV-18).
