# Codex design brief (before G2)

Codex, review the design pack, not code. Read only the files in this repo: `SPEC.md` (r4, authoritative), `FLOWS.md`, `TASKS.md`, `INVARIANTS.md`, `KNOWN-LIMITS.md`, `THREAT-MODEL.md`, `ARCHITECTURE.md`, `GLOSSARY.md`, `OPEN-QUESTIONS.md`, `PREFLIGHT.md`, `adr/`, and the three earlier reviews in `reviews/design-review-r1..r3.md`.

Three Opus rounds ran (r1: 3 critical / 20 major; r2: 0 / 10; r3: 0 / 2 major / 9 minor). The r3 findings were fixed in SPEC r4 but **nobody has reviewed those fixes** (KNOWN-LIMITS L24).

Attack these first, they are new in r4:
1. §6.2 step 11: a 400/412 terminalizes a row only if `authorizationState(payer, nonce)` is false; 2xx needs the receipt with both logs.
2. §6.3 step 5: the reconciler re-sends only `settle_pending` rows or `settling` rows older than 20 s.
3. TASKS T23: the fully local fork-revoke test with a baseline `verified` call.
4. `attest signer renew` at < 72 h, and `renewSigner` (SPEC §3.4) in general.
5. `attest agent wallet-sig --owner` after the transfer, 5-minute window (T31).
6. Fixed in-enclave vsock port 5000, CIDs 16/17/18 (SPEC §4.1, §5).
7. V10 signer status at the settlement block, with the event fallback and `uncertain{rpc_unavailable}`.
8. `check-deploy` comparing all four contracts with immutables spliced.
9. Ledger `reserved` cleanup on every V6; V0 waiting on a `reserved` entry.
10. One batched buy request per evaluate (SPEC §5).

Then anything else. Don't re-report KNOWN-LIMITS items unless the limit's statement is wrong.

Write `reviews/design-review-r4-codex.md`: findings ordered CRITICAL / MAJOR / MINOR, each with where, why, a case, and a minimal fix. Last line exactly `VERDICT: implementation-ready` or `VERDICT: changes required`. Fixes to SPEC and the other locked files go back to the design session, not into the diff.
