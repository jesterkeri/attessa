# ADR-001: Verify Nitro attestations with base/nitro-validator, pinned, unmodified

- Status: accepted (2026-10-19). Door: two-way until mainnet deploy, then one-way per registry.
- Context: we need on-chain verification of AWS Nitro attestations (P-384 COSE). Nothing is deployed on Celo.
- Options:
  1. base/nitro-validator (MIT, Cantina audit 2026-08-03, hinted P-384, ~13.8M gas warm).
  2. Automata ZK verifier (RISC0/SP1, ~220–258k gas, but not deployed on Celo and needs a prover).
  3. Marlin NitroProver (unaudited, older, ~12–13M per cert).
- Decision: (1), pinned to commit `0ea0d12`. Deploy our own instance of P384Verifier → CertManager → NitroValidator. Never modify it.
- Consequences:
  - We gain an audited verifier with no prover infrastructure.
  - We give up cheap per-boot verification (≈ $0.34–0.68 per boot today).
  - The consumer must add freshness, debug-PCR and binding checks itself (SPEC §3.4).
  - CertManager owner/revoker powers exist (DoS only), held by the admin key.
- Confirmation: Gate 1 kill test; a test asserting the submodule commit equals `0ea0d12`.
