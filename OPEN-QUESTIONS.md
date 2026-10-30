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

## From T03 (core) and T13 (enclave), 2026-10-30
Each was resolved with the smallest reading and pinned by a test or vector, so a ruling changes one place.
- [ ] **Frame size vs large payTo code (T13, likely to bite).** SPEC §4.2 caps messages at 65,536 bytes, but an evaluate reply carries `inputs` including payTo's code, base64-encoded: a 24,576-byte contract makes the reply ~67 KB. The enclave enforces the cap on incoming frames only. Rule needed: raise the reply cap, or bound the inputs.
- [ ] **Local-network IP literals (T03).** §2.1 "IPv4/IPv6 literals (except local)" read as: on `--network local`, IP literals are allowed over https; http only for `localhost:<port>`. `http://localhost` with no port (or `:80`, which WHATWG drops) is refused.
- [ ] **Empty host labels (T03).** §2.1 rejects only a trailing dot; WHATWG accepts `https://a..b` and `https://.example.com`, and so does core. No vector pins it.
- [ ] **Method case (T03 + T13).** core's `requestHash` uppercases the method (`post` == `POST`, pinned by a vector); the enclave rejects a lowercase method as `bad_frame`. Should the enclave accept lowercase?
- [ ] **`configure` reply (T13).** Unspecified; the enclave returns the same as `attest`: `{"attestation","signer"}`.
- [ ] **`rpcAllowedChains` (T13).** No stated purpose; validated as uint256 decimals and otherwise ignored.
- [ ] **How the enclave learns `releaseId` (T13).** Unspecified; it reads PCR0-2 via NSM `DescribePCR` at configure.
- [ ] **Deny list contents (T13).** Unspecified; ships `[]`, R2 tested with an injected list.
- [ ] **Error codes outside evaluate's list (T13).** Malformed messages map to `bad_frame`; bad body `bad_request`; bad inputs `bad_inputs`.
- [ ] **`source` capability-id grammar (T13).** Accepts `buy:<visible ASCII>` or `forno`.
- [ ] **NSM error after boot (T13).** Treated like boot: exit 3. `nsm_init` runs at process start, so a missing `/dev/nsm` exits before listening; SPEC lists the NSM step after configure.
- [ ] **Incoming frames need not be canonical JCS (T13).** Parsed strictly instead; every outgoing frame is exact JCS (tested).
- [ ] **Payer-sig hex case (T03).** §2.5 doesn't say; core requires lowercase hex, matching §2's lowercase rule.
- [ ] **Error for a null or wrong-length PCR in `registerSigner` (T04).** SPEC §3.4 step 4 requires PCR0-2 "non-null and each 48 bytes" but names only `DebugPcrs` (all-zero). The build uses `InvalidPcr` (approveRelease's error). Security-relevant: a 64 ‖ 32 ‖ 48 split concatenates to the same 144 bytes as an approved 48 ‖ 48 ‖ 48 release (`test_InvalidPcr_lengthShiftCollision`). Confirm `InvalidPcr` or name another error.
- [ ] **try/catch can't map two cases (T04).** A `selfRegistry`/identity registry address with no code, or a return that doesn't ABI-decode, reverts with empty data instead of `SelfLinkInvalid`/`NotOwner`. Both are fixed constructor args pointing at real contracts, so left as is.
- [ ] **Unicode version for UTS-46 is not pinned (T03 re-attack).** core uses tr46 5.1.1 (Unicode 16); Rust url 2.5.8 / idna 1.1.0 (ICU, Unicode 17) accepts code points added in Unicode 17 that TS refuses (e.g. U+1E6C0, U+10EC5, U+A7CE, U+11DD0, U+16EA0, U+10940). 19 of 2,130 fuzzed inputs differ, all from this; no input produced two different originHashes. SPEC §2.1 could pin the version (then the enclave refuses the same set).
- [ ] **JCS `-0` vector loses its sign in the file (T03 re-attack).** `JSON.stringify(-0)` writes `0`, so the Appendix B case never shows a Rust or Solidity runner a `-0`. Store it as raw bit patterns if it matters.
