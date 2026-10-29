# ADR-010: Ephemeral signer key per boot, 7-day TTL, re-register on restart

- Status: accepted (v1). Superseded later by KMS-sealed keys (Frontier M3).
- Context: the key must never leave the enclave. Sealing needs KMS with attestation-conditioned policy, which is out of MVP scope.
- Options:
  1. Ephemeral key per boot, TTL 7 days.
  2. KMS-sealed key (keys survive reboots).
  3. No TTL.
- Decision: (1). TTL bounds the damage of an undetected key leak.
- Consequences:
  - Every restart costs a registration (~$0.34 warm, ~$0.68 cold).
  - A brief outage between restart and registration.
  - We give up continuity.
- Confirmation: `SIGNER_TTL()` returns 604800; expiry tests.

## Amendment r2 (design review r1, finding 29)

- A next-day restart is a 3-tx registration (the instance CA lives 24 h): ≈ 27.6M gas ≈ 5.5 CELO at 200 gwei. Same-day warm is 2 txs ≈ 20.8M gas ≈ 4.2 CELO. Copy says "about 4–6 CELO".
- A signer registered Nov 2 expires Nov 9 (mid-judging). Re-register Nov 8 (T36); `health.sh` alerts when `expiresAt − now < 24 h`.

## Amendment r3 (design review r2, finding 4)

- The r2 note "renew with `--fresh`" was wrong: the same key reverts `SignerExists` in `registerSigner`. r3 adds `renewSigner` (SPEC §3.4): the endpoint's operator submits a fresh attestation from the same running key and the same approved build, and `expiresAt` moves to now + 7 days. No restart, no downtime. An expired signer can't be renewed.
- Planned renewals: Nov 8 on both networks (T36), drilled on Sepolia first (T24).

## Amendment r4 (design review r3, finding 3)

- An expired signer can't be renewed, so renewal is a rolling task, not a date: renew whenever fewer than 72 h remain (cron alert), on both networks. Renewing a days-old enclave usually re-caches the instance CA and leaf: about 5–7 CELO on mainnet.
