# Design review r1: attested execution provenance on Celo

Reviewer: independent adversarial design review (Opus). Scope: `pack/` files named in the brief only. KNOWN-LIMITS L1-L16 are not re-reported except where the limit's own statement is wrong (finding 26).

External facts checked on 2026-10-19:
- base/nitro-validator `src/NitroValidator.sol`, `src/CertManager.sol`, `README.md`, `docs/hinted-p384-nitro-attestation.md` (main branch): https://github.com/base/nitro-validator
- ERC-8004 reference contracts: https://github.com/erc-8004/erc-8004-contracts (`IdentityRegistryUpgradeable.sol`, UUPS, `_authorizeUpgrade onlyOwner`)
- Self Agent ID registration modes: https://docs.celo.org/build-on-celo/build-with-ai/self-agent-id.md
- Live Celo mainnet RPC (`https://forno.celo.org`) and Celo Sepolia RPC: proxy slots, `owner()`, `eip712Domain()`, `version()`, `authorizationState`, gas price (202.5 gwei).

Findings are ordered by severity, then by claim.

---

## CRITICAL

### 1. [CRITICAL] Ptrs are offsets into `attestationTbs`, but SPEC never says which buffer to slice, and the tests cannot tell
Where: SPEC §3.4 `registerSigner` steps 2, 4, 6, 7; INVARIANTS INV-1; TASKS T04, T07.
What a user/judge sees: a registered "genuine enclave" signer whose key, PCRs and binding came from bytes the operator wrote.
Why: `validateAttestationWithHints` returns `CborElement` pointers into `attestationTbs` (the reconstructed COSE Sig_structure), not into the submitted COSE `attestation`. base's own consumer example slices `attestationTbs` (`attestationTbs.keccak(ptrs.pcrs[0])`, `attestationTbs.slice(ptrs.publicKey)`). SPEC passes `attestation` into `registerSigner` and then says "PCR0..2 are present", "`user_data` ... equals", "`public_key` is 65 bytes" without naming the buffer. A builder who slices the calldata `attestation` reads at the wrong offsets. In `attestation` the unsigned COSE *unprotected header* sits between the protected header and the payload; `decodeAttestationTbs` skips it with `skipValue` and accepts any map. An attacker pads the unprotected header so the tbs offsets land inside it, and every value the registry reads (PCRs, user_data, public_key) becomes attacker-chosen, while the AWS signature still verifies over the real tbs. Any genuine attestation from any enclave (even debug) with a fresh timestamp then registers an arbitrary non-enclave key against any PCRs the owner approved, for example the honest published release.
The test plan can't catch it: INV-1 unit tests use a mock validator whose crafted `Ptrs` follow whatever convention the builder picked, and T07's only real-fixture assertion is `BindingMismatch`, which a wrong-buffer read also produces.
Reproduce/case: build `att' = 0xD2 0x84 <protected> <unprotected map with K bytes of chosen content> <payload> <sig>` from a real document, with K chosen so `ptrs.userData.start()` points into the unprotected map. A registry that slices `attestation` accepts it.
Fix: SPEC step 2 gets "All `ptrs` offsets index `tbs`; read every field with `tbs.slice(ptr)` / `tbs.keccak(ptr)`; check `!isNull()` first". Add a real-attestation positive test (T12 output, fork-warped) asserting the stored signer equals `keccak(public_key[1:])` and a negative test with a padded unprotected header that must revert.
Confidence: plausible (depends on the builder's reading; consequence confirmed against the validator source)

### 2. [CRITICAL] The buyer is told "produced by the code published at <sourceRef>", but sourceRef is an unverified string the owner types
Where: SPEC §3.4 `approveRelease` (sourceRef 1-256 bytes, no check), §7 `CallResult.sourceRef`, FLOWS §6 J1 copy ("Runs the code published at github.com/acme/risk @ a1b2c3d ... The answer was produced by that published code"), GLOSSARY "published code".
What a user/judge sees: a "verified" call that says it ran acme's published code, when it ran a malicious build.
Why: nothing on chain or in the SDK links PCRs to `sourceRef`. Any agent owner (minting an ERC-8004 identity is permissionless) can approve the PCRs of a modified build and set `sourceRef` to a reputable repo and commit. They then register a genuine enclave of that build at their own origin. V1-V12 all pass, and the CLI prints the false provenance as fact. Reproducibility is only something "anyone can" check; the SDK never does, and the claims table doesn't cover it. This defeats the product's premise line ("whether the seller's published code ran").
Reproduce/case: owner B runs `attest release approve --from-build evil/measurements.json --source https://github.com/acme/risk/commit/a1b2c3d` and serves `https://risk-check.example`. A buyer given that link gets "verified" plus the acme line.
Fix: change the copy to "owner says this build comes from {sourceRef} (not checked)" unless a reproduction check passes. Either ship an `attest release verify` that rebuilds and compares PCRs (and show "reproduced by you at <time>"), or drop sourceRef from buyer-facing success lines. Add the gap to the claims table.
Confidence: confirmed

### 3. [CRITICAL] "not_charged" is declared while the authorization is still live, and an ambiguous settle error is never reconciled
Where: SPEC §7 V9 ("On 4xx/5xx with no X-PAYMENT-RESPONSE: not_charged"), §6.2 step 8 ("error → settle_failed"), §6.3 (reconciles only settling/settle_pending), INV-11; contradicts GLOSSARY "not charged: none can after validBefore" and FLOWS J2 step 4 (waits out validBefore).
What a user/judge sees: evidence and CLI say "You were not charged" while USDC left the wallet and no result was delivered.
Why: (a) The SDK finalises `not_charged` on the first non-2xx, but the authorization can be settled by its holder until validBefore. A buggy or dishonest gateway can return 502 and settle 60 s later. ADR-006 rests buyer protection on "independent evidence", and that evidence is wrong here. (b) The gateway maps any facilitator "error" to terminal `settle_failed`. A facilitator that broadcast the tx but errored afterwards (RPC hiccup, receipt wait failure) leaves the gateway saying not charged with the result withheld. The reconciler never looks at `settle_failed`, so the row never becomes `settled` and `/v1/results` never serves it. That is a charged-without-result path for an honest gateway, which violates the §9 minimal guarantee and SLO-1.
Reproduce/case: fake facilitator that submits `transferWithAuthorization` and then returns HTTP 500. Gateway: 502 `settle_failed`; SDK: `not_charged`; chain: `AuthorizationUsed(payer, nonce)`.
Fix: SDK: non-2xx means `pending_not_charged` until `authorizationState(payer, nonce) == false` is read at a block with timestamp > validBefore (see finding 5), then `not_charged`; a later true means `settled_after_reject`. Gateway: treat every non-success settle answer except a facilitator-side *pre-broadcast* rejection as `settle_pending`, and let the reconciler decide.
Confidence: confirmed (spec text); facilitator error-after-broadcast behaviour plausible

---

## MAJOR

### 4. [MAJOR] settle_pending has no HTTP answer, and reconciled or crashed-after-settle rows are never retrievable
Where: SPEC §6.2 step 8-9, §6.1 `/v1/results` (serves only delivered/delivery_failed), §6.3, §10 (no settle_pending row), FLOWS J1-interrupted copy.
What a user/judge sees: charged, then `result_not_found` forever.
Why: (1) After `settlement_pending` or a 15 s timeout, SPEC doesn't say what the gateway sends the waiting client: hold, 202, or 5xx (and with or without X-PAYMENT-RESPONSE). If it sends a 5xx without the header, V9 records not_charged (finding 3). (2) The reconciler moves rows to `settled`, but `/v1/results` serves only `delivered`/`delivery_failed`. "Settled rows whose client is gone are delivery_failed" never says who moves them or when. (3) Step 8 persists `settling` without persisting `response` and `proof_header`, so a crash after settle loses the result. (4) A crash between `settled` and the socket write leaves the row in `settled`, which no process scans.
Fix: persist response + proof_header + state `settling` in one transaction before `/settle`. Reconciler: `settled` with no live client means `delivery_failed`. `/v1/results` serves `settled|delivered|delivery_failed`. Define the pending answer: 202 `settle_pending{tx}` with `Retry-After`, and the SDK polls `/v1/results`.
Confidence: confirmed

### 5. [MAJOR] Expiry is judged by local clock against an RPC that may lag
Where: SPEC §6.3 ("false and now > validBefore → settle_failed{expired}"), §7 V9/V11 reconcile, FLOWS Call statechart `Uncertain → Expired`.
What a user/judge sees: the row is marked "not charged", then the facilitator tx lands in a block with timestamp ≤ validBefore.
Why: `authorizationState` read from a node whose head timestamp < validBefore says false even though a pending tx may still be included before validBefore. Gateway host clock, buyer clock and Forno head can each be seconds apart.
Fix: decide "expired" only from a read whose `block.timestamp > validBefore` (use `eth_call` at a block number whose header timestamp you checked), plus a small margin.
Confidence: confirmed (logic)

### 6. [MAJOR] Any `AuthorizationUsed(payer, nonce)` is accepted as payment
Where: SPEC §6.3 reconciler, §7 V11.
What a user/judge sees: the seller delivers a result for a payment that went elsewhere.
Why: EIP-3009 nonces are per authorizer, not per payee. During `settle_pending` the buyer can front-run with a second authorization using the same nonce: `to = self`, value 0 (or minimal). Gateway path: the AuthorizationUsed log exists, the row becomes `settled`, and the result is served via `/v1/results` without the gateway being paid. SDK path: V11 doesn't check the log's emitter equals the quoted asset.
Fix: require, in the same tx, a `Transfer(payer → payTo, amount)` emitted by the quoted asset, and `AuthorizationUsed` from that same contract.
Confidence: plausible (needs the facilitator to report settlement_pending, which RESEARCH says happens)

### 7. [MAJOR] Gateway idempotency and crash recovery leave undefined and stuck states
Where: SPEC §6.2 step 2, §6.4 state CHECK list, INV-9..11, claim C3.
Why: (a) Step 2 defines only three cases. The same requestId + same payment with state in {received, payment_verified, executing, exec_failed, proof_rejected, too_late, settling, settle_pending, settle_failed, payment_invalid} falls to "Otherwise insert", which violates the PK and UNIQUE constraints (a 500, or a builder-chosen re-run). Retries from generic x402 clients hit this. (b) `payment_verified` and `executing` are in the schema but no step sets them. (c) A crash during steps 3-6 leaves rows in `received`/`executing` forever: the reconciler scans only settling/settle_pending, so "every in-flight row resolves" (C3) is false. (d) A failed row's payer is taken from the undecoded-then-unverified payload and inserted before `/verify`, so rows exist for unverified `from` addresses.
Fix: add an explicit table: (existing state × same/different payment) → response. On startup, mark pre-settle rows `exec_failed` (never settle them). Insert only after `/verify` succeeds, or key unverified rows separately.
Confidence: confirmed

### 8. [MAJOR] Anyone can squat any origin forever on the immutable registry
Where: SPEC §3.4 `addEndpoint` (prefix + length only), FR-2, ADR-002; not in THREAT-MODEL or KNOWN-LIMITS.
What a user/judge sees: the real seller's `attest endpoint add` returns `origin_taken`, with no admin and no recovery.
Why: ERC-8004 registration is permissionless. Owner X calls `addEndpoint(X, "https://risk.example", ...)` before the real seller does, or front-runs after seeing announcements or the `.well-known` file. Nothing proves control of the origin. Buyers are protected (payTo mismatch), but the origin is dead on this registry until X retires it. A judge-visible demo origin could be squatted the day it is announced.
Fix: require proof of origin control in `addEndpoint`. Cheapest options: (a) the SDK also requires `/.well-known/attested-exec.json` to name the same agentId (already fetched), and the registry allows a *different* agent to `addEndpoint` over an Active one only with a challenge served from that path. Or (b) accept the risk in KNOWN-LIMITS and register the demo origin on day 0.
Confidence: confirmed

### 9. [MAJOR] The ERC-8004 Identity Registry and Self registry are upgradeable; the trust model says authority comes only from the agent owner
Where: SPEC §1 trust table, ADR-002 ("Any admin key is a key that can make a fake seller look genuine"), ADR-009, THREAT-MODEL §2.
Why: confirmed on Celo mainnet. `0x8004A169…a432` is an ERC-1967 proxy (impl `0x7274e874…9c02`), `IdentityRegistryUpgradeable` uses `_authorizeUpgrade onlyOwner`, and `owner()` = `0x547289319c3e6aedb179c0b8e8af0b5acd062603`, an EOA (no code). Self `0xaC3DF9AB…5944` is also an ERC-1967 proxy (impl `0xbe81bd95…4c66`). Whoever controls those keys can rewrite `ownerOf` (and so approve releases, add or retire endpoints, revoke) or `hasHumanProof`. With `requireSelf = true` they can also brick every future registration on the immutable mainnet registry. This is a real admin over the "no admin" root of trust, and it isn't in the trust table.
Fix: add both registries' upgrade keys to the trust table and ADR-002 consequences. Consider `requireSelf=false` on mainnet, or snapshot ownership at link time. State it in the explanation docs.
Confidence: confirmed

### 10. [MAJOR] The hackathon's "ERC-8004 from the agent wallet" rule makes the hot EC2 key the agent owner
Where: TASKS T31 ("ERC-8004 agent from the agent wallet, ... release approve, endpoint add"), SPEC §5 (`AGENT_PRIVATE_KEY` on seller-host), THREAT-MODEL §2 ("keep them separate"), PIPELINE secrets.
Why: the wallet that registers holds the NFT and is therefore `ownerOf`. If that is the seller-host agent wallet (a hot key, 0600 on EC2), compromise of the parent equals owner compromise: approve any build, re-point endpoints. T31 then performs owner actions from it, which contradicts the separation rule.
Fix: register from the agent wallet, then immediately `transferFrom` the NFT to the cold owner, if the hackathon rules allow that. Otherwise keep the agent wallet off the EC2 host and use a separate buy-payer key for inputs. Add a T31 step and a check.
Confidence: confirmed

### 11. [MAJOR] Self link validity is underspecified, and spike S4 doesn't test what it claims
Where: SPEC §3.4 `linkSelfAgent`, `approveRelease` ("still pass ownerOf + hasHumanProof"), step 0; TASKS T08.
Why: "still pass ownerOf" compared to what: the current agent owner, the linker, or just nonzero? After an agent NFT transfer, one builder blocks the new owner and another lets an unverified owner inherit the link. Self NFT ownership differs by registration mode (human wallet in `linked`, the agent's own key in `wallet-free`, smart wallets in `privy`/`smartwallet`), so `ownerOf(selfAgentId) == msg.sender` fails for most modes. Proof freshness (`isProofFresh`) and `revokeHumanProof` are ignored, and a burned token makes `ownerOf` revert with a non-custom error. T08's verify calls only `hasHumanProof(1)` and never checks `ownerOf`, freshness or semantics. (`ownerOf(1)` does return an address on Sepolia.)
Fix: specify `ownerOf(selfAgentId) == IdentityRegistry.ownerOf(agentId)` at check time, plus `hasHumanProof && isProofFresh`, wrapped in try/catch mapping to `SelfLinkInvalid`. Name the supported Self mode. Extend T08 to call each selector against a known linked-mode agent.
Confidence: plausible

### 12. [MAJOR] The gateway rejects standard x402 clients (and buy) before quoting
Where: SPEC §6.2 first bullet ("Missing X-Request-Id → 400" before the 402), ADR-005 ("The buy client and our SDK can both pay us"), TASKS T22/S5, ADR-006 (gateway as the marketplace step).
Why: generic x402 v1 clients, including `buy curl`, don't send `X-Request-Id`, so they get 400 `request_id_required` instead of a 402. S5 can only "fail", and the story of buy using this gateway doesn't work as specified.
Fix: when absent, derive `requestId = keccak256(nonce ‖ payer)` server-side and return it in a response header. The SDK still sends its own.
Confidence: confirmed

### 13. [MAJOR] USA₮ `version()` reverts on mainnet, so T26 and gateway startup fail
Where: SPEC §6.2 ("name/version read from the contract at startup"), TASKS T26 verify command.
Why: live RPC on `0xD2ab3C9A…F771`: `version()` and `VERSION()` revert. `eip712Domain()` returns name `"Tether America USD"`, version `"1"`, chainId 42220. `cast call ... "version()(string)"` errors, so T26's verify cannot produce its done-when, and a gateway that reads `version()` at startup throws. The 402 `extra.name` must be "Tether America USD", not "USA₮". (The token does expose `authorizationState`, `cancelAuthorization` and both `transferWithAuthorization` selectors; decimals = 6.)
Fix: read the domain via EIP-5267 `eip712Domain()` and cross-check `DOMAIN_SEPARATOR()`. Update T26 to call `eip712Domain()(bytes1,string,string,uint256,address,bytes32,uint256[])`.
Confidence: confirmed

### 14. [MAJOR] The daily cap ignores in-flight, uncertain and paid-but-rejected spend
Where: SPEC §7 V6/V12, INV-12, FLOWS "two concurrent calls" claim.
Why: V6 compares *recorded* spend + amount under a lock, but spend is written only at V12 (the verified path). Two processes both pass V6 before either reaches V12. An `uncertain` call isn't counted until it reconciles. If `paid_but_rejected` exits at V10 without V12, a dishonest gateway that always settles and returns a bad proof drains past `dailyCap` while an agent loops. INV-12's "today's spend + amount > dailyCap" is not enforced as written.
Fix: reserve the amount at V8 under the lock. Release the reservation only after not-charged is proven (finding 5). Count every settled outcome, whether `verified`, `paid_but_rejected` or `settled_after_reject`. Count spend in the asset's units, per asset.
Confidence: confirmed

### 15. [MAJOR] The input-audit claim isn't supported by the design
Where: ARCHITECTURE §1.3 ("That closes the main gap ... anyone can re-read the chain at that block and audit the inputs"), ADR-012, SPEC §4.3/§5.
Why: (a) The response body is `{verdict, reasons, block, rulesVersion}`. The buyer gets neither `inputs` nor `source`, yet `inputsHash` covers `source` ("buy:<capability-id>" or "forno"), which the buyer can't know, so it can't recompute inputsHash without guessing. (b) The inputs object doesn't name the address read. (c) The operator chooses block N. Nothing (enclave, gateway or SDK) checks that N is recent, so the operator can pick a historical block where payTo had nonce 0 or no code and flip R3/R4 with a "correct" audit. (d) `attest audit` is M1, so in the MVP nobody audits.
Fix: return `inputs` (including the address) in the response body so responseHash covers them, or drop `source` from the hashed object. Have the SDK check `block.timestamp(N)` is within a bound of settlement time. Soften the claim to "auditable after the fact" until `attest audit` exists.
Confidence: confirmed

### 16. [MAJOR] Workload input rules are ambiguous enough to produce wrong signed verdicts
Where: SPEC §4.3, §4.2 error codes, §6.2 step 5.
Why: (a) Address case: the deny list (R2) and known-asset table (R1) compare against `payTo`/`asset`, and SPEC doesn't say whether checksummed input is rejected (`bad_request`) or lowercased. With a string compare, a checksummed deny-listed address passes R2. (b) The request `chainId` isn't required to equal the configured chain, so a mainnet chainId on the Sepolia enclave evaluates the mainnet asset table over Sepolia inputs. (c) `amount` grammar is undefined (leading zeros, "+", >2^256). (d) "block number/hash don't match between fields" can't be checked by the enclave and isn't defined. (e) There is no gateway mapping for enclave `bad_request`/`bad_inputs`/`not_configured` (status, charged or not).
Fix: require lowercase 20-byte hex (or lowercase after a strict parse) and `chainId == configured`, define `amount` as `^(0|[1-9][0-9]{0,77})$`, delete (d) or define it. Map `bad_request` → 400 not charged, `bad_inputs` → 503 not charged.
Confidence: confirmed (ambiguity)

### 17. [MAJOR] The pending ledger schema is undefined, so resume and reconcile can't fully re-verify
Where: SPEC §7 V0, V8, `getResult`, `reconcilePending`, `verifyProof` (takes `body`, `paymentId?` optional).
Why: re-verification needs requestId, requestHash (or the body), method, pathAndQuery, nonce, payer, asset, amount, payTo and validBefore. SPEC never lists what `pending.jsonl` stores. `reconcilePending()` and `attest status --pending` run without the original body, and `getResult(url, requestId)` has no body parameter. A builder either reports `verified` after signature and signer checks only (no request or payment binding, which breaks C4) or can't produce an outcome. `paymentId` being optional in `verifyProof` invites calls that skip payment binding.
Fix: define the ledger row schema (the fields above plus state). Make `getResult` and reconcile verify against it. Make `paymentId` required whenever the call was paid.
Confidence: confirmed

### 18. [MAJOR] The quote rate limit throttles the SDK's normal flow
Where: SPEC §6.1 (10 req/min/IP), THREAT-MODEL TB1 DoS row (challenge-bearing quotes share the limit), SPEC §7 V2 (always sends `X-Attest-Challenge`), ARCHITECTURE §7 (peak 1 req/s).
Why: every `payAndVerify` sends a challenge-bearing quote. One buyer agent (or a demo loop, or several users behind one NAT) making more than 10 calls a minute gets 429, which V2 maps to `quote_unavailable` and `stopped`. This contradicts the 1 req/s design peak and risks SLO-1 during judging.
Fix: rate-limit by payer address after `/verify` rather than by IP for quotes, raise the limit to at least 120/min, or cache a liveness per (challenge-free) quote and let the SDK use `/v1/liveness` only when needed.
Confidence: confirmed

### 19. [MAJOR] `paused` is sticky, and the commands to clear or set it don't exist in SPEC
Where: SPEC §6.2 step 8 (401/402/429 → paused), §8 CLI table (only `attest gateway export`), THREAT-MODEL §2 (`attest gateway resume`), §5 kill switch (`attest gateway pause`), §7 runbook.
Why: a transient facilitator 429 pauses the whole gateway until a human runs a command the builder was never told to build. SPEC also doesn't say what happens to quotes or paid requests while paused (ARCHITECTURE says quotes are refused; §6.2 is silent), or whether `/verify` 401/402/429 also pause. One burst during judging can burn the SLO-1 budget.
Fix: add `attest gateway pause|resume` to SPEC §8. Treat 429 as backoff with auto-resume, not a pause. Define paused behaviour: 503 `gateway_paused` before `/verify`, with no execution.
Confidence: confirmed

### 20. [MAJOR] The e2e and demo scenarios destroy or disrupt the live Sepolia seller and can't repeat
Where: TASKS T23 (revoke → refused), T24, T35 (3 runs incl. modified build), T17; SPEC §3.4 (Revoked terminal; approveRelease needs status None); §3.4 step order (freshness step 3 before release step 5); SPEC §5 socat on fixed port 5005; SPEC §8 `--cpu-count 2`.
Why: (a) Revoking the release is permanent for that releaseId. `approveRelease` of the same PCRs then reverts `ReleaseExists`, so after one T23 run the approved build can never serve again on that agent, and T23 and T35 can't run twice. (b) The "modified build refused" scenario needs a *fresh* attestation (a stale one hits `AttestationStale` before `ReleaseNotApproved`), and SPEC's single host with one socat port and a fixed 2-vCPU allocation runs one enclave. So each run stops the real enclave, which means a new key, a re-registration (about 4 CELO and a Joshua broadcast) and downtime. (c) T17's `--dry-run` can't reach `ReleaseNotApproved`: the new enclave's leaf cert isn't cached, and `validateAttestationWithHints` reverts "inverse hint underflow" first unless the dry-run forks and simulates the cache txs.
Fix: run the revoke scenario on a throwaway agent or release (or use `revokeSigner`). Run modified-build checks on an anvil fork with the cache txs simulated. Give the modified enclave its own vsock port and `--cpu-count 1`, or accept a restart and budget it.
Confidence: confirmed (a, c); plausible (b)

### 21. [MAJOR] Several verify commands don't prove their done-when
Where: TASKS T01, T05, T07, T10, T30; SPEC §11 G1.
Why:
- T10 and T30: `cast code <addr> | wc -c` prints 3 for an address with no code (`"0x\n"`), so "> 2" and "4 non-empty" pass with nothing deployed.
- T01: `grep -oE '0x[0-9a-f]{64}'` also matches the first 64 hex characters of 96-hex PCR values or any hash pasted in the doc. `grep 'max gas'` prints a line but checks nothing. The required count (≥ 8) contradicts SPEC §11 G1 ("5 tx hashes").
- T07: base's fixture is a January 2026 attestation (base docs §11) with a 3 h leaf and ≤ 20 d CAs. On a current Sepolia fork, the production CertManager reverts "certificate not valid anymore" / "cert expired" inside `validateAttestationWithHints`, and freshness would fail next, so `BindingMismatch` is unreachable without `vm.warp` and re-caching. Even when reached, it doesn't show the parse is right (finding 1).
- T05: the mutation checks are "recorded" but not in the verify command.
Fix: `test "$(cast code $a)" != "0x"`. T01: parse a table and assert each `gasUsed < 16777216` with `cast receipt`. T07: warp to the fixture timestamp + 60 s, cache certs in-test, approve the fixture PCRs, assert the exact revert *and* a positive path with a re-bound mock-free attestation from T12. Script the mutations.
Confidence: confirmed

### 22. [MAJOR] The kill test can only pass with `CertManagerDemo`, and nothing stops it becoming the registry's validator
Where: TASKS T01, SPEC §3.5, RISK-1.
Why: base's demo deploys `CertManagerDemo` with an expiry grace because the fixture's certs are expired. A production `CertManager` rejects them. If T01's stack is reused as the registry's `nitroValidator` (T10 doesn't say to redeploy), the immutable registry trusts a CertManager that accepts expired AWS certs.
Fix: T01 deploys the demo stack under clearly separate addresses. `DeployValidatorStack` deploys production `CertManager`. T10/T30 assert `extcodehash(certManager)` equals the production artifact and `owner()` == admin.
Confidence: plausible

### 23. [MAJOR] The plan doesn't fit one developer by Nov 2
Where: TASKS G1-G5 (33 tasks before mainnet), AGENTS review STOPs, L15.
Why: in 14 days (Oct 19 → Nov 2), with G1 still running: a Solidity registry with invariants at 90% branch coverage; a Rust NSM enclave with JCS, k256, rules and determinism tests; a reproducible-EIF spike on arm64 EC2 (needs AWS enclave approval, not yet applied); a gateway with reconciler; an SDK; a ~20-command CLI with snapshot copy; seller-host with buy integration; four Codex review STOP/fix/re-review cycles; and every broadcast hand-run by Joshua. Each T16/T23/T31 step also waits on a human broadcast. No slack exists for one failed gate review, and outreach for RISK-5 starts the same day mainnet is due.
Fix: cut scope before G2: drop `requireSelf` (L11 already allows it), drop `--via buy` (J5) to post-Nov 2 or hand-run, merge G3+G4 reviews, let the builder broadcast on Sepolia (OPEN-QUESTIONS item), and set a hard decision date (Oct 26) for S3 reproducibility.
Confidence: plausible

---

## MINOR

### 24. [MINOR] The SPEC freshness formula underflows; THREAT-MODEL has the fix but SPEC doesn't
Where: SPEC §3.4 step 3 vs THREAT-MODEL §4 Arithmetic.
Why: `block.timestamp - ts` panics (0x11) for `ts` in (now, now+60]. A builder following SPEC, the authoritative file, reverts on valid slightly-future attestations. The +59/+60 boundary tests would catch it, but SPEC should say it. Also floor division admits up to now+60.999 s.
Fix: write `ts > block.timestamp ? 0 : block.timestamp - ts` in SPEC.
Confidence: confirmed

### 25. [MINOR] The 30-minute window doesn't mean what the copy says; `configure` re-entry is unspecified
Where: ADR-003 consequence, FLOWS J3 copy ("valid for 30 minutes", "Run attest enclave start again"), SPEC §4.2 `attest`.
Why: `{"type":"attest"}` returns a fresh attestation for the same key at any time, so the window bounds neither key age nor the operator's deadline. The repair path needlessly restarts the enclave (new key, new registration cost). SPEC doesn't say `configure` is one-shot. If it can be re-sent, one key can be bound to several chains or registries.
Fix: the repair copy should say "re-attest with `attest signer register --fresh`" (fetch from `/internal/attest`). Make `configure` one-shot (second → `bad_frame`).
Confidence: confirmed

### 26. [MINOR] KNOWN-LIMITS L6 is wrong: nothing bounds proof `issuedAt`
Where: KNOWN-LIMITS L6, SPEC §6.2 step 6, §7 V10.
Why: the ±120 s tolerance applies only to liveness (V7). Proof checks are `expiresAt > now`. A host that sets the enclave clock to 2030 yields proofs that never expire, so "a 600 s proof TTL bounds the effect" is vacuous.
Fix: gateway and SDK reject `|issuedAt - now| > 120`, or correct L6.
Confidence: confirmed

### 27. [MINOR] Origin normalisation leaves room for divergence; one SDK check is vacuous
Where: SPEC §2.1.
Why: "Parse as a URL" doesn't name WHATWG vs RFC 3986, the IDNA processing (UTS-46 transitional vs non-transitional changes `ß`), trailing-dot hosts, IPv4 shorthand (`0x7f.1`), or bracketed IPv6. TS and Rust can disagree, though vectors catch only the cases someone thought of. The on-chain 253-byte cap counts the scheme and port, so long valid hosts are rejected. "The SDK refuses to resolve an origin whose stored string ≠ its own normalisation" is vacuous, because `endpoints(originHash)` returns no string and the lookup key is already the SDK's own hash.
Fix: "WHATWG URL Standard, UTS-46 non-transitional, reject trailing dot, reject IP literals except under --network local". Cap 8+253+6 bytes. Delete the vacuous check or read `EndpointAdded` to perform it.
Confidence: confirmed (ambiguity)

### 28. [MINOR] Wire-format gaps two builders would fill differently
Where: SPEC §2.5, §4.2, §7 V3, §8.
Why:
- `X-Attest-Payer-Sig` signs `<unixSeconds>`, but there's no header or param carrying it, and no rule for requestId case in the message.
- Liveness object field encodings (agentId and issuedAt as string or number) are unspecified.
- The base64 variant (std/url, padding) for `X-Attested-Proof` is unspecified.
- Network names: SPEC `'celo'|'celo-sepolia'` vs FLOWS/CLI `--network mainnet|sepolia`.
- V3 doesn't say the SDK pins the asset address and token EIP-712 domain from its own table rather than the 402's `asset`/`extra`.
Fix: one table for each header's exact grammar; pin assets per network in `deployments.ts` and refuse other addresses.
Confidence: confirmed

### 29. [MINOR] Cost and ops numbers disagree across files
Where: FLOWS J3 copy and THREAT-MODEL runbook ("about 3 CELO") vs ARCHITECTURE §7 (warm = 20.8M gas = 4.16 CELO at 200 gwei; live gas price measured 202.5 gwei); ADR-008/§7 AWS 120 h; FLOWS "1 GiB" vs `--memory 1536`.
Why: the instance CA lives 24 h, so a next-day reboot is 3 txs (≈27.6M gas, ≈5.5 CELO), not 2. Availability is needed from Nov 2 (mainnet demo plus RISK-5 users) through Nov 13 (≈264 h + 60 h dev ≈ $44), above the $30 billing alarm. SIGNER_TTL (7 d) registered on Nov 2 expires Nov 9, mid-judging, and there is no expiry alert. The rest of §7's arithmetic checks out (41.45M → 8.29 CELO → $0.68; 20.8M → $0.34; 180 h × $0.136 = $24.48; L = 1 × 4 = 4; per-call $0.0024-0.0114; $0.07-0.34 per buyer-month; c6g.xlarge $0.136/h).
Fix: correct the copy to "about 4-6 CELO", budget 324 h and a $50 alarm, and add a `health.sh` check for `expiresAt - now < 24 h`.
Confidence: confirmed

### 30. [MINOR] Cross-reference and FLOWS/SPEC contradictions
Where: various.
Why:
- SPEC §4.3 cites INV-14 for determinism (it is INV-16).
- SPEC §2 says vectors are T05 (they are T03).
- The FLOWS §2 Proof field list omits `issuedAt` and orders `paymentId, inputsHash` the other way round from the SPEC typehash.
- FLOWS trace #13 has `--cancel-on-reject` and a "J2 default prompt", while §9 says "Cancel no longer prompts" and SPEC §8 has no such flag.
- FLOWS says "resume within 10 minutes of a paid one", but SPEC V12 clears the entry.
- The AGENTS never-edit list includes FLOWS and THREAT-MODEL; SPEC rule 2 omits them.
- FLOWS shows `GET+POST /v1/liveness`; SPEC has POST only.
Fix: reconcile them in one pass; SPEC wins, so update FLOWS.
Confidence: confirmed

### 31. [MINOR] CRL monitoring is a safety function nobody performs; attestationHash isn't canonical
Where: SPEC §1 trust table ("CertManager owner/revoker: nothing for safety"), THREAT-MODEL §2, SPEC §3.4 step 9, SPEC §12 claims evidence.
Why: base's docs say an operator *must* watch AWS CRLs and submit revocations. With a cold EOA and no process, an AWS-revoked intermediate stays trusted. `keccak256(attestation)` covers the unsigned unprotected header and the malleable P-384 `s`, so the same attestation has many hashes and makes weak evidence.
Fix: state the CRL gap in KNOWN-LIMITS (or run a monitor). Store `keccak256(tbs)` instead.
Confidence: confirmed

### 32. [MINOR] Operator rotation doesn't evict the old operator's signers
Where: THREAT-MODEL §2 (rotation = retire + add), SPEC §3.4 `checkSigner` (ignores operator).
Why: signers registered by a stolen operator key stay valid after retire + re-add for the same agent. The owner must also `revokeSigner` each one, found from events, and the runbook doesn't say so.
Fix: add it to the rotation runbook, or bind `operator` into Signer and check it in `checkSigner`.
Confidence: confirmed

### 33. [MINOR] The SDK builds its authorization window from the local clock
Where: SPEC §7 V8 (`validAfter = now − 5`, `validBefore = now + 120`), §6.2 step 1 (≥ 40 s).
Why: a buyer clock more than 5 s fast gets every payment refused by `/verify` (validAfter in the future). A clock more than 80 s slow gets `authorization_window_too_short` every time.
Fix: base both on the latest block timestamp. Use `validAfter = chainNow − 60`.
Confidence: confirmed

---

## Claim-by-claim summary

- C1 (registry rules): holds only if fields are read from `tbs` (finding 1). Also see 8, 9, 11, 24, 32. Cross-chain, cross-agent and replay binding via `user_data` + chainId/registry + `SignerExists` is sound. `public_key`-derived signer with no address parameter is sound. The PCR bank (32 slots, null sentinels, 48-byte check) matches the validator.
- C2 (ADR-003): sound against replay and cross-binding. The stated consequence about the 30-minute operator deadline and the repair copy is wrong (25), and freshness doesn't bound key age.
- C3 (gateway): at-most-once settle holds (persist-then-settle, UNIQUE nonce, no re-settle). "Never settles after a failed check" holds. "Every in-flight row resolves" fails (3, 4, 5, 6, 7).
- C4 (SDK): payTo binding prevents paying an impostor's address. "Verified" can be reported with false provenance (2), and resume/reconcile binding is unspecified (17). Not-charged reporting is premature (3). Cap enforcement is weak (14).
- C5 (formats): hashes, EIP-712 and user_data are unambiguous. Gaps: Ptrs buffer (1), origin parser (27), headers and encodings (28), workload input grammar (16).
- C6 (capacity/cost): arithmetic correct. Copy and hours inconsistent (29). Rate limit contradicts the peak (18).
- C7 (plan): see 20, 21, 22, 23.
- C8 (reproducibility): divergence points are 1, 4, 7, 11, 16, 17, 19, 27, 28, 30.

## What I could not verify

- base/nitro-validator at pinned commit `0ea0d12`: I read `main` (README states HEAD = 0ea0d12 on 2026-08-05; not confirmed byte-for-byte).
- Whether base's fixture attestation is debug-mode (all-zero PCRs), which would make T07 revert `DebugPcrs` even after warping.
- Celo facilitator (x402-rs) `/settle` semantics: whether `success` means mined, when it returns `settlement_pending`, and whether it can error after broadcasting (finding 3 assumes it can).
- Whether `buy curl` sends any request-id header (finding 12 assumes generic x402 v1 behaviour).
- Self Agent ID contract ABI beyond `ownerOf(1)` succeeding on Sepolia; who administers the Self proxy.
- AWS Nitro limits on running two enclaves on one c6g.xlarge with the spec's allocator settings.
- That selectors `0x5a049a70`/`0xb7b72899` found in both token implementations are `cancelAuthorization` variants (inferred from known selectors, not decoded from source).
- Hackathon rules on transferring the ERC-8004 NFT after registering from the agent wallet.

VERDICT: changes required
