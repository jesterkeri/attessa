# T19 x402 payment gateway review, round 2

## Findings

No critical, major, or minor findings.

## Round-1 findings

- **m1 fixed.** `packages/gateway/src/checks.ts:177-181` now requires both a non-expired proof and `expiresAt == issuedAt + PROOF_TTL`; a signed 601-second proof is rejected as `proof_expired` before settlement.
- **m2 fixed.** `packages/gateway/src/gateway.ts:410-425` now requires `/verify` to return a syntactically valid payer address, persists that returned payer, and rejects a mismatch with the authorization `from`.  A missing payer cannot produce a row.
- **M1 fixed.** `packages/gateway/src/reconciler.ts:112-140` starts one chain reconciliation per open row without awaiting prior rows; the three primary reads for a row run together at `:181-188`.  Checks are tracked per request and later ticks are not held by a slow RPC, while completion immediately invokes the delivery sweep.

## Delivery-liveness assessment

`holdLive` checks whether the reply/socket was already closed before marking a row, removes its mark on reply or socket close, and correctly preserves a second overlapping delivery when the first client disconnects (`packages/gateway/src/gateway.ts:258-296`).  The reconciler starts its no-live grace after the handler ends, preserves it across restarts from the stored `updated_at`, and sweeps leaked live marks after `validBefore + 55` (`packages/gateway/src/reconciler.ts:65-69`, `:143-169`).

The final sweep can intentionally classify a still-live mark as `delivery_failed` after that deadline.  That is the documented resolution of the explicit conflict between an unreleased handler mark and INV-11's `validBefore + 60` terminal deadline; it does not release an unproved body, and stored results remain available through `/v1/results`.  The five-second pass margin is already recorded in OPEN-QUESTIONS.md and is not worsened here.

## Verification and protocol notes

- `pnpm -r typecheck` passed for every workspace package.
- The required gateway suite cannot complete inside this sandbox because its local-socket delivery tests time out.  The supplied external run passed 154 tests on this exact commit; that is the evidence relied on for socket paths (U8).
- U7: 0 INSIDE, 0 OUTSIDE findings. This is indicative only because this was a single-prompt review, not a blind cold-read measurement.
- No network write, transaction, `.env`, keystore, or key file was read.

Decision: SHIP
VERDICT: implementation-ready
