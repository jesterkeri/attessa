# Status

| field | value |
|---|---|
| project | attested execution trust layer for buy sellers (Celo, Agents on Open Rails + USA₮ with x402) |
| stage | ready for G2 (T02) |
| tier | 2, scoped to MVP |
| updated | 2026-10-19 |
| blocked on | Joshua: Loops enrollment, public repo, domain for the origin, AWS account with enclaves, fresh dev wallets |

## Stage log
- 0 route, done 2026-10-19 (written plan → stage 1)
- 1 frame, done 2026-10-19 (FRAME.md)
- 2 flow-design, done 2026-10-19 (FLOWS.md)
- 2.5 UX gate, PASS after 2 rounds 2026-10-19 (UX-REVIEW.md)
- 3 system-design, done 2026-10-19 (this pack)
- 4 adversarial review r1: changes required (3 critical, 20 major, 10 minor) 2026-10-19
- 4 fixes: SPEC r2 + pack r2 (TASKS, FLOWS, INVARIANTS, KNOWN-LIMITS L17–L22, ADR-014, amendments to 002/003/005/006/008/010/012) 2026-10-19
- 4 adversarial review r2: changes required (0 critical, 10 major, 8 minor) 2026-10-19
- 4 fixes: SPEC r3 (renewSigner, asset identification, proof recovery, inputs value check, V10 time anchors, settle table by HTTP status, payload stored for retries, two networks on one host, schedule §13) + pack r3 2026-10-19
- 4 adversarial review r3: changes required (0 critical, 2 major, 9 minor) 2026-10-19
- 4 fixes: SPEC r4 (no double settle send terminalizing a charged row, fully local fork-revoke test, renew at < 72 h, wallet-sig after transfer, fixed enclave port + CIDs, RPC-depth fallback, four-contract deploy check, receipt on 2xx, batched input reads, ledger cleanup) + pack r4 2026-10-19
- 4 adversarial review r4: **not run, Joshua's override** (L24). Codex reviews the r4 fixes before G2 (`reviews/codex-design-brief.md`)
- 4 Codex design review r4: changes required (1 critical, 1 major, 1 minor); r5 changes move production payments to x402 v2 and make all pre-expiry 400/412 settlement answers pending 2026-10-19
- 4 r5 self-check: implementation-ready; stage ready for G2 (T02) 2026-10-19
- 5 handoff pack + harness 2026-10-19
- Gate 1 kill test: running in parallel in Claude Code (BUILD_KICKOFF.md)
- product named Attessa; pack renamed (packages `@attessa/*`, CLI `attessa` + alias `attest`, units `attessa-*`), protocol identifiers unchanged 2026-10-29
