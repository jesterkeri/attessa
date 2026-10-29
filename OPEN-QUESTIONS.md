# Open questions (r5)

Anything genuinely undecided, and anything the build discovers that the design didn't answer. `BLOCKING` means the gate can't close without an answer.

- [ ] **BLOCKING G3+4:** The public origin for the seller endpoint: a domain Joshua controls, with a subdomain pointed at the EC2 Elastic IP (TLS by Caddy, auto Let's Encrypt). Needed before `endpoint add`. Don't announce it before the mainnet endpoint is added (L17).
- [ ] **BLOCKING G5:** Do the hackathon rules allow transferring the ERC-8004 NFT to a cold owner after registering it from the agent wallet (T31)? Ask at office hours (Thu 12:00 GMT). If not, the agent wallet stays owner and must live off the EC2 host; seller-host then uses a separate buy-payer key for input reads.
- [x] Product name: **Attessa** (Joshua, 2026-10-29). Packages `@attessa/*` (npm name and scope looked free on 2026-10-29; claim the scope before G6), binary `attessa` with alias `attest`, data dir `~/.attessa`. Still open: domain (main + one typo, e.g. attesa), X handle.
- [ ] Price per call. Default 20000 atomic (0.02 USDC / USA₮). Confirm before mainnet.
- [ ] **Decide by Oct 21 (schedule, SPEC §13):** Should the builder be allowed to broadcast on Celo Sepolia (testnet only)? Recommended: yes. The harness currently blocks every `--broadcast` (L15). Allowing it saves Joshua roughly a dozen hand-run broadcasts in G2–G4. Changing it means editing `.claude/hooks/guard-bash.sh` to allow `--rpc-url` containing `celo-sepolia`. Joshua decides.
- [ ] Spike results to bring back to design: S2 (NSM fields, three enclaves), S3 (reproducible PCRs, by Oct 26), S4 (Self selectors, informational), S5 (buy client vs the canonical x402 v2 Sepolia quote), S6 (USA₮ domain, confirmed live 2026-10-19 as "Tether America USD"/"1"), S7 (buy RPC capability and price).
- [x] Is base's fixture attestation debug-mode? **No** (design review r2 decoded it: PCR0-2 non-zero, `public_key` null, `user_data` 20 bytes, timestamp 1767472867402 ms). T07(a) expects `BindingMismatch(0)`.
- [ ] Celo facilitator `/settle` semantics on the hosted build: x402-rs main answers 400/412 before broadcast and 500 `unexpected_error` after; confirm the hosted service does the same (T19's fake facilitator assumes it), and whether `success` means mined.
- [x] S8 (answered by design review r3, live read 2026-10-19): mainnet Forno serves state ≥ 200,000 blocks back; Sepolia Forno ~10,064. Both pass −400 and −7,200. T19a still records it.
- [ ] Whether `buy curl` accepts the canonical x402 v2 quote and preserves its selected `accepted` requirement (S5; the direct SDK path is independent).
- [ ] Where the ERC-8004 registration JSON (`agentURI`) is hosted: GitHub raw in the public repo (default) or the seller origin `/.well-known/agent.json`.
- [ ] Facilitator credits: confirm the live config's 20 free mainnet settlements vs the docs' 1, before the judging window.
- [ ] Frontier cap ($15k per the forum vs "$25k+" per the site): confirm on the call with Defi Messiah.
- [ ] ADR-003 deviates from the brief (no on-chain challenge; key in `public_key`). Confirm Joshua accepts it.

## Found by the build (2026-10-29)
- [ ] **CI is red on the untouched pack.** `scripts/check-reviews.sh` fails on `reviews/design-review-r1.md`, `-r2.md`, `-r3.md` (each ends `VERDICT: changes required`; all superseded by later rounds), and the pack-integrity step fails while any `BLOCKING` open question is unchecked. With `guardrails` required on `main`, nothing can merge until the design session decides: move r1 to r3 to `docs/design/` as history, or record them as overrides in KNOWN-LIMITS (design-owned, the build can't edit it).
- [ ] **guard-edit.sh blocks worktree builders.** It denies any Edit/Write path matching `*/.claude/*`, and Claude Code puts subagent worktrees under `<repo>/.claude/worktrees/`. With the hooks loaded, a builder in a worktree can't write a single file. Needs a carve-out for `.claude/worktrees/` (a `.claude/` change, so Joshua approves it).
- [ ] **Signer renewal threshold is stated three ways:** "fewer than 72 h" (TASKS.md header, SPEC §13), "fewer than 6 days" (T36), "cover the next 48 h" (PREFLIGHT.md:43). Which one does `scripts/health.sh` (T24) alert on?
- [ ] **guard-bash.sh doesn't catch `cast send`**, which broadcasts without a `--broadcast` flag (guard-bash.sh:23, settings.json:18 cover `forge`/`--broadcast` only). The builder treats `cast send` as blocked regardless; the hook needs the pattern (a `.claude/` change, Joshua approves).
