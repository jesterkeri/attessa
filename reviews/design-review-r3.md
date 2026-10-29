# Design review r3: attested execution provenance on Celo

Reviewer: independent adversarial design review (Opus 5.5). I had no access to the project discussion, only the artifacts listed in the brief.

Scope: `pack/SPEC.md` (r3, authoritative), `FLOWS.md`, `TASKS.md`, `INVARIANTS.md`, `KNOWN-LIMITS.md`, `THREAT-MODEL.md`, `ARCHITECTURE.md`, `GLOSSARY.md`, `OPEN-QUESTIONS.md`, `PREFLIGHT.md`, `AGENTS.md`, `PIPELINE.md`, `STATUS.md`, `adr/001-014`, `RESEARCH.md`, `reviews/design-review-r1.md`, `reviews/design-review-r2.md`. KNOWN-LIMITS L1-L23 are not re-reported.

External facts checked on 2026-10-19:
- **base/nitro-validator** at `0ea0d12` (https://github.com/base/nitro-validator):
  - `script/BaseSepoliaDemo.s.sol`: the parser contract is created before `vm.startBroadcast`. Inside the broadcast: 3 deploys, a cache loop over `cabundle[1..]` plus one client cert (4 txs for the fixture), then a cold and a warm `validateAttestationWithHints`. 9 txs, so T01's "exactly 9 lines" is right.
  - `src/CborDecode.sol`: `slice`/`keccak` are in library `CborDecode`; `isNull` is in `LibCborElement`. SPEC §3.4 step 2 now matches.
  - `src/CertManager.sol:85` `p384Verifier` is immutable. `src/NitroValidator.sol:56-57` `certManager` and `p384Verifier` are immutable too. `test/helpers/CertManagerDemo.sol` adds its own immutable and overrides `_certificateExpired`.
  - `validateAttestationWithHints` is `public` (not view) and re-walks the cached bundle with empty hints, so the whole bundle must be cached first.
- **x402-rs** `main` at `e75adda` (https://github.com/x402-rs/x402-rs):
  - `crates/x402-facilitator-local/src/handlers.rs`: `/settle` answers 400 (412 for allowance) for `PaymentVerification` errors and 500 for `OnchainFailure`.
  - `crates/chains/x402-chain-eip155/src/v1_eip155_exact/facilitator.rs`: v1 `settle` runs `assert_valid_payment` (chain, recipient, `validBefore ≥ now + 6`, domain from `extra`, **payer balance ≥ amount**, value), then sends. It does **not** simulate: `TransactionSimulation` is raised only on the `/verify` path. A used nonce fails in `estimate_gas` (pending block) as a transport error, which is a 500. A reverted receipt is a 500.
  - `crates/chains/x402-chain-eip155/src/chain/provider.rs`: settle waits for the receipt, default `receipt_timeout_secs = 30`.
  - `assert_domain` uses `extra.name`/`extra.version` when present, so USA₮'s reverting `version()` is never called. `PaymentRequirementsExtra` doesn't deny unknown fields, so `extra.attestedExec` is accepted.
- **ERC-8004** `IdentityRegistryUpgradeable.sol` (https://github.com/erc-8004/erc-8004-contracts):
  - `AGENT_WALLET_SET_TYPEHASH = keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)")`, with `owner = ownerOf(agentId)` read at submission.
  - `MAX_DEADLINE_DELAY = 5 minutes`.
  - `register` sets `agentWallet = msg.sender`, and `_update` clears it on transfer.
- **AWS Nitro Enclaves docs**:
  - https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave.html: "You can create up to four individual enclaves per parent instance."
  - https://docs.aws.amazon.com/enclaves/latest/user/cmd-nitro-run-enclave.html: options are name, cpu-count/cpu-ids, memory, eif-path, enclave-cid, debug-mode and attach-console. There is **no way to pass arguments or environment** to the enclave app. Without multithreading (Graviton), leave at least 1 vCPU for the parent.
- **Live Celo RPC** (curl JSON-RPC, https://forno.celo.org and https://forno.celo-sepolia.celo-testnet.org):
  - `eth_chainId` returns 0xa4ec (42220) and 0xaa044c (11142220).
  - 3,600 blocks span exactly 3,600 s on both networks (1 s blocks).
  - Mainnet Forno serves `eth_getBalance` and `eth_call` at least 200,000 blocks back.
  - Sepolia Forno serves state 400, 7,200 and 9,000 blocks back. At 11,000 and beyond it refuses with `"block is more than 10064 blocks behind head"` (about 2 h 48 min).
- **Celo facilitator** `GET /supported` (https://api.x402.celo.org, https://api.x402.sepolia.celo.org): mainnet v1 `celo` lists USDC, USDT and USAT ("Tether America USD"/"1", eip3009). Sepolia v1 `celo-sepolia` lists no assets. `POST /settle` without a key returns 401.

---

## r2 fix status

| r2 # | Status | Reason |
|---|---|---|
| 1 Late results checked against "now" | Fixed, residual | V10 time anchors (signing time, settlement block) replace "now". The anchor needs historical state at block S. Sepolia Forno drops state after about 10,064 blocks, and the spec has no fallback for `checkSigner` (finding 6) |
| 2 v1 payload has no asset | Fixed | Asset identified by `ecrecover` under each pinned domain, `/verify`-per-requirement fallback, requestId and lock computed after the asset, T19 two-asset case. x402-rs takes the domain from `extra`, so USA₮ works |
| 3 Proxy 502 after settle | Fixed | V9 treats a non-2xx without a well-formed §10 body as `uncertain`, chain-used goes to `getResult` first, INV-23 and T20 test. FLOWS §5/§7 still draw the old path (finding 9) |
| 4 `--fresh` can't renew | Fixed, new problem | `renewSigner` is well ordered: operator, Active and unexpired, steps 2-7 including release Approved, SignerMismatch/ReleaseMismatch, INV-24. The schedule pins renewal to Nov 8, but the Sepolia signer expires before then (finding 3) |
| 5 Reconciler retry can't be built / can terminalize | Fixed, new problem | `payment_payload` and `requirements` are stored, and a retry's answer never terminalizes. The reconciler now retries `settling` rows whose first `/settle` is still in flight, and a 400 on a later send still terminalizes (finding 1) |
| 6 Inputs values unchecked | Fixed | Gateway re-reads code, nonce and balance at block N (`inputs_mismatch`), SDK too or `inputsChecked:false` (L23), ADR-012 amendment, T19 case. Forno serves −400 on both networks (S8 premise holds) |
| 7 CertManager immutable | Fixed, residual | `check-deploy` splices immutables and checks wiring; T10 self-test against CertManagerDemo. NitroValidator, P384Verifier and the registry code are not compared (finding 7) |
| 8 Signer recovery | Fixed | Step 9 first bullet recovers and uses `r`; T19 forged-proof case; INV-13 vectors; THREAT-MODEL row |
| 9 Sepolia seller during judging | Fixed, residual | FR-13, the §5 per-network table, allocator 3 vCPU / 3072 MiB (AWS allows 4 enclaves per parent), T37, cut item 6. The per-enclave vsock port "given at start" can't be passed into an enclave (finding 5) |
| 10 Schedule | Fixed (accepted) | SPEC §13 has per-gate dates, an ordered cut list and a never-cut list. I found nothing concrete that makes a date infeasible |
| 11 T01 tx count | Fixed | "exactly 9 lines" matches base's script (checked) |
| 12 Settle reason names | Fixed, residual | Table keyed on HTTP status. Its example `400 transaction_simulation` is a `/verify` reason in x402-rs, not a `/settle` one (finding 1) |
| 13 L6 wording | Fixed | "at most 240 s" is correct for the live checks |
| 14 Fork chain id / release | Partially fixed | `local` takes the RPC's chain id (§2.6), and T23 revokes the live release on the fork. But T23's fork setup makes every call fail whether or not the release is revoked (finding 2) |
| 15 `setAgentWallet` sender | Fixed, residual | Cold owner submits. The signed struct binds `owner` and a deadline ≤ 5 min, which the CLI shape and T31 ordering don't respect (finding 4) |
| 16 Ledger details | Fixed, residual | `reserved` entries, a fresh requestId per call, 404 when `response IS NULL`. Stale reservations are cleaned only at startup (finding 10) |
| 17 Input-read drain | Fixed | Per-payer unsettled limit and buy-spend guard |
| 18 Cross-file | Mostly fixed | Items listed in r2 are fixed. New stale text in FLOWS, THREAT-MODEL, ARCHITECTURE and TASKS (finding 11) |

r1 items r2 left open:

| r1 # | Status now |
|---|---|
| 10 (cold owner) | Fixed in structure; typed-data detail in finding 4 |
| 20 (fork tasks) | T17 is fine; T23 fork-revoke can't prove its claim (finding 2) |
| 21 (verify commands) | Fixed (T01 count, check-deploy splice) |
| 23 (schedule) | Fixed (accepted), see r2 #10 |

---

## New findings

### 1. [MAJOR] Two `/settle` senders run for one row, and a 400 on the later send records `settle_failed` for a buyer who was charged
**Where:** SPEC §6.2 step 11 (table header "Result (first attempt only)"; 429 row "retry with `Retry-After` (≤ 5 s) while `validBefore − now ≥ 10`"; "400 or 412 → `settle_failed{reason}`"); SPEC §6.3 "`settling` / `settle_pending`" step 5 (retry `/settle` once per tick); INV-11; TASKS T19 fake-facilitator modes and cases.

**What a user/judge sees:** "Payment didn't go through: insufficient funds. The result was withheld." Then, about 2 minutes later: "Warning: the service refused this call, but your payment permission was used anyway … This is the gateway's fault." The buyer paid. The verified result is stored but `/v1/results` returns 404, because the row is terminal `settle_failed`. This is SEV-1 ("charged without a verified result").

**Why:**
- The reconciler runs every 5 s and step 5 applies to `settling` rows. A row is `settling` exactly while the request handler's own `/settle` call is in flight, including the up-to-5 s `Retry-After` sleep after a 429. So two senders can act on one authorization.
- In x402-rs, `/settle` doesn't simulate. It checks the payer's balance first, then sends. If the other sender's settlement has already landed and the payer's remaining balance is below the price, the handler's re-send gets **400 `insufficient_funds`**. If the balance is still enough, the send fails in `estimate_gas` and returns 500, which is safe.
- The step 11 table maps any 400 to terminal `settle_failed`. Nothing says whether a post-429 re-send counts as the "first attempt", so a builder will apply the table.
- Once the row is terminal, the reconciler never looks at it again and `payment_payload` is nulled.

The r3 principle "only chain evidence terminalizes" is applied to reconciler retries but not to the handler's own re-sends.

Side note: the table's example reason `transaction_simulation` and T19's fake mode "400 `transaction_simulation`" are a `/verify` reason in x402-rs. A front-run nonce at `/settle` produces a 500, then the reconciler gives `nonce_used_elsewhere`, which is what T19 expects. With the SPEC example as the fake's behaviour, T19 would get `settle_failed{transaction_simulation}` instead.

**Reproduce/case:**
1. The payer holds exactly 0.02 USDC.
2. The gateway's `/settle` #1 gets a 429 with `Retry-After: 4`.
3. At +2 s the reconciler tick sends `/settle` #2 from the stored payload. It succeeds and the tx is mined.
4. At +4 s the handler re-sends #3. The payer balance is 0, so the facilitator returns 400 `insufficient_funds`.
5. The row becomes `settle_failed{insufficient_funds}`, the buyer gets a 502, and `/v1/results` returns 404. The SDK sees `authorizationState == true`, `getResult` gets 404, and the call ends `settled_after_refusal`.

**Fix (minimal):**
- In §6.3, the reconciler retries only `settle_pending` rows, or `settling` rows whose `updated_at` is older than the 15 s settle timeout plus 5 s (left behind by a crash). Track in-flight handler sends in process.
- In §6.2 step 11, before writing `settle_failed` from a 400/412, read `authorizationState(payer, nonce)` at latest. If it is true, go to `settle_pending` and let the chain decide.
- In T19, add "429, reconciler retry succeeds, handler re-send gets 400 → row ends `settled`, result served". Change the fake's 400 mode to x402-rs's real settle reasons (`insufficient_funds`, `invalid_payment_expired`, `recipient_mismatch`) and model a used nonce at settle as a 500.

**Confidence:** plausible. The spec text permits it; it needs a 429 (or a slow facilitator) plus a payer balance below twice the price. x402-rs behaviour is confirmed from source; the hosted build is unverified.

### 2. [MAJOR] T23's fork-revoke test refuses every call whether or not the release is revoked, so it can't prove C4.5
**Where:** TASKS T23 ("run a second gateway (127.0.0.1:8082, `RPC_URL` = the fork) in front of the **real** Sepolia seller-host, and call it with the SDK pointed at the fork"); SPEC §11 C4.5; SPEC §5 input fetch (block N = latest − 1 from the real chain); SPEC §6.2 step 9 inputs block and value checks; INVARIANTS header ("A test that would still pass with the property removed doesn't count").

**What a user/judge sees:** "pass" for revocation, backed by a test that passes even without revocation.

**Why:**
1. **The inputs block isn't on the fork.** The real seller-host reads inputs at the real Sepolia block N. The fork gateway runs `eth_getBlockByNumber(N)` against anvil. Above the fork block, anvil has either no block N (no `--block-time`) or a locally mined block N with a different hash. Either way the result is `proof_rejected{stale_inputs}` on every call, before and after the revoke.
2. **The fork clock is stale.** The SDK on the fork reads `chainNow` from anvil's head. Without block production, that is the fork time, so `validBefore` can already be in the past for the real Sepolia facilitator that the second gateway calls for `/verify`. The result is `payment_invalid`, revoked or not.
3. **The gateway path is never exercised.** After the revoke, the SDK on the fork stops at V7 (`checkSigner` ≠ OK → `liveness_failed`, nothing signed). The gateway's 60 s refusal path never runs.

**Reproduce/case:** run `pnpm e2e:fork-revoke` with the revoke step commented out. Calls still fail (`stale_inputs` or `payment_invalid`), so a "refused" assertion passes.

**Fix (minimal):**
- Run fully local: `anvil --fork-url $SEP --block-time 1`, a second seller-host instance whose inputs RPC is the fork (it can share the Sepolia enclave over vsock), and T19's fake facilitator.
- Require a baseline call that ends `verified` before the revoke.
- Then revoke via impersonation and send calls with a raw paid client (or SDK test mode that skips V7) for 60 s. Assert `enclave_unavailable` or `proof_rejected{release_not_approved}` within 60 s and 0 settles.
- Make `e2e:fork-revoke` fail if the baseline isn't `verified`.

**Confidence:** confirmed (anvil fork semantics and the spec text).

### 3. [MINOR] Renewal is pinned to Nov 8, but the Sepolia signer expires before then and an expired signer can't be renewed
**Where:** TASKS T16 (Sepolia signer in G3+4, by Oct 30), T24 (renew drill, G3+4), T36 ("Renew both signers on Nov 8 … both signer addresses unchanged (no restart)"); SPEC §3.4 `renewSigner` step 1 (`now < s.expiresAt`); SPEC §13; THREAT-MODEL §7.

**Why:**
- T16 and the T24 drill both happen by Oct 30, so the Sepolia signer's `expiresAt` is at most Nov 6. On Nov 8, `renewSigner` reverts `SignerNotActive`, and T36's "unchanged address" can't hold.
- The same applies to mainnet if G5 finishes before Nov 1.
- Only `health.sh`'s < 24 h alert stands between this and a Sepolia outage at the start of judging (the tutorial path).
- Renewing a 6-day-old enclave also needs a new instance CA, and possibly the zonal cert, cached. That is 3-4 cache txs plus the renew (about 5.5-6.9 CELO on mainnet), above the runbook's "about 4–6 CELO".

**Fix:**
- Renew whenever `expiresAt − now < 72 h` (cron on the host or a daily runbook step), and schedule Sepolia renewals at least every 6 days from T16.
- T36 done-when: both `expiresAt ≥ 2026-11-14T00:00Z`, with "address unchanged" only if no restart happened.
- Update the cost line.

**Confidence:** confirmed (dates in TASKS plus the spec rule).

### 4. [MINOR] `attest agent wallet-sig` before the transfer produces a signature that `setAgentWallet` rejects
**Where:** SPEC §8 (`attest agent wallet-sig --agent <id> --deadline <s>`, "run on EC2 … (no tx)"), TASKS T31 order (wallet-sig, then transfer, then set-wallet from the cold owner).

**Why:**
- The ERC-8004 reference contract hashes `AgentWalletSet(agentId, newWallet, owner, deadline)` with `owner = ownerOf(agentId)` at submission time, and requires `deadline ≤ block.timestamp + 5 minutes`.
- Signed before the transfer, the natural implementation fills `owner` with the agent wallet itself. After the transfer the owner is the cold wallet, so the call reverts `invalid wallet sig`.
- Even with the right owner, the hot signature on EC2 and the cold submission on another machine must happen within 5 minutes, and nothing says so.

**Fix:**
- `attest agent wallet-sig --agent <id> --owner <cold owner> --deadline <≤300 s>`, run after the transfer (or with the cold owner address given explicitly).
- T31 states the 5-minute window.

**Confidence:** confirmed (source read, same `getVersion` 2.0.0 as the live registry per r2).

### 5. [MINOR] An enclave can't receive its vsock port at start
**Where:** SPEC §4.1 step 1 ("vsock listener on the port given at start (`attest enclave start --port`): 5005 mainnet, 5007 Sepolia, 5006"); SPEC §5 socat `VSOCK-CONNECT:<cid>:<port>` (CID unspecified); ARCHITECTURE §5 host row.

**Why:**
- `nitro-cli run-enclave` takes no arguments or environment for the enclave app, and `configure` arrives over vsock, so it can't carry the port either.
- A builder will either bake the port into the image, which gives a different EIF and different PCRs per network (two releases, two S3 comparisons), or pick some other mechanism.
- The CID is never pinned, so after a restart socat may target the wrong CID. That fails closed (connection refused) rather than cross-talking, but it is an outage.

**Fix:**
- Use one fixed in-enclave listen port (for example 5000) and the same EIF on both networks.
- Distinguish enclaves by `--enclave-cid` (16 mainnet, 17 Sepolia, 18 test).
- `attest-vsock@<network>`: `TCP-LISTEN:5005 → VSOCK-CONNECT:16:5000`, and so on.

**Confidence:** confirmed (AWS docs).

### 6. [MINOR] V10/V11 chain reads at a specific block have no defined behaviour when the RPC can't serve them
**Where:** SPEC §7 V10 time anchors ("`checkSigner(r, originHash)` via `eth_call` **at the settlement block**"), V11 ("the receipt at `settlementTx` … if not, `uncertain`"); INV-13 (+2 h test); TASKS T19a ("−7200 decides whether the SDK's late re-read usually works"); §6.1 `/v1/results` 24 h retention.

**Why:**
- **(a) Old results on Sepolia.** Sepolia Forno refuses state more than about 10,064 blocks (about 2.8 h) behind head. Mainnet Forno serves at least 200,000. A Sepolia user who Ctrl-Cs and runs `attest status --pending` the next morning (the copy invites this, and results are kept 24 h) hits an RPC error in the `checkSigner` anchor. The spec defines a fallback only for input values (`inputsChecked:false`). A builder will map the error either to a ProofCheck, which makes an honest result `paid_but_rejected` with "This is the gateway's fault", or to a retry that never succeeds. INV-13's +2 h test passes on mocks and on Sepolia by a 2,800-block margin.
- **(b) Fresh results on a lagging RPC.** Right after a 200, the buyer's RPC may not yet have the settlement block (the facilitator waits for its own node's receipt). V11 then goes straight to `uncertain`, and the happy path prints "Lost the connection after you signed" and waits about 2 minutes. That risks T35's 3/3 and NFR-4.

**Fix:**
- V11: poll the receipt for up to 10 s before `uncertain`. V10: wait until the RPC head is at or past the settlement block.
- When state at S is unavailable, rebuild signer, release and endpoint status at S from events (`SignerRegistered/Renewed/Revoked`, `ReleaseStatusChanged`, `Endpoint*`, all ≤ S), or record `signerCheckedAt:"latest"` in evidence like `inputsChecked`.
- An RPC error is never a ProofCheck.
- Record T19a's answer: both networks pass −400 and −7200; Sepolia stops at about −10,064.

**Confidence:** confirmed for the Sepolia depth (live read); plausible for receipt lag.

### 7. [MINOR] `check-deploy` proves the CertManager code but not the NitroValidator, P384Verifier or registry code
**Where:** SPEC §3.5 T10/T30 checks; PREFLIGHT On chain; TASKS T04 (a mock NitroValidator exists in the repo).

**Why:**
- The registry trusts `nitroValidator` completely. `check-deploy` compares only CertManager's runtime code, then checks address wiring.
- A deployment that wires in T04's mock validator (or a modified P384Verifier, which CertManager's spliced immutable would simply point to) passes every check while accepting any attestation.
- NitroValidator has two immutables, so its comparison also needs splicing.

**Fix:** compare the runtime code of all four contracts (P384Verifier, CertManager, NitroValidator, EnclaveRegistry) against the compiled artifacts, splicing `immutableReferences`. The T10 self-test should also fail on a mock validator.

**Confidence:** confirmed (spec text, source).

### 8. [MINOR] `settled` on a 2xx `success:true` contradicts INV-11, which requires both logs
**Where:** SPEC §6.2 step 11 ("2xx and `success:true` → `settled` (record `transaction`)"); INV-11 ("A row becomes `settled` only on a tx containing both `AuthorizationUsed(payer, nonce)` and `Transfer(payer → payTo, amount)`"); OPEN-QUESTIONS ("whether `success` means mined").

**Why:** x402-rs returns success only after a successful receipt, but the hosted build is unconfirmed. Two builders will diverge: one trusts the 2xx, the other fetches the receipt. INV-11's test as written can't pass on the first implementation.

**Fix:** on 2xx `success:true`, fetch the receipt (wait up to 5 s) and require both logs from the asset. Otherwise go to `settle_pending`.

**Confidence:** confirmed (cross-file).

### 9. [MINOR] Paid input reads: count, batching and cost per evaluate are unspecified
**Where:** SPEC §5 input fetch (block header plus three reads via the buy capability); ARCHITECTURE §7 ("Input reads via buy: ASSUMPTION $0.001–0.01 per call", "positive margin at any assumed input price", W ≈ 4 s); NFR-4.

**Why:**
- If each RPC method is a separate buy call, one evaluate makes four paid calls, each settled on chain before upstream.
- At the assumed upper price that is $0.04 against $0.02 revenue, so the budget guard flips to Forno and the RISK-6 scoring path dies.
- Done sequentially, it adds about 4-8 s, past NFR-4's 6 s p95.

**Fix:** after S7, state one JSON-RPC batch per evaluate if the capability allows it (else parallel calls), and restate the cost model per evaluate, not per call.

**Confidence:** plausible (buy capability pricing unknown until S7).

### 10. [MINOR] Remaining ledger and rate-limit ambiguities
**Where:** SPEC §7 ledger paragraph, V0; §6.1 per-payer limit; TASKS T20, T23, T35.

**Why:**
- Stale `reserved` entries are deleted only "at startup". An agent that embeds the SDK in a long-lived process keeps a crashed reservation for the rest of the day, and T20's "doesn't hold the reservation past 10 minutes" needs a restart to pass. Clean up on every V6 instead.
- V0 can "resume" a `reserved` entry that has no nonce (another process between V6 and V8). It should treat `reserved` as "in progress, wait" and never call `getResult` without a nonce.
- §6.1 places the per-payer 429 "before execution" but not in §6.2's step order. Before or after `/verify`? With or without a row?
- The demo payer hits the limit quickly. T23 runs J2 twice and T35 runs J2 three times, all `proof_rejected` from one payer, so one demo retake inside an hour gets 429. Use a dedicated payer per script, or exempt the demo payer in test config.

**Fix:** as stated per bullet.

**Confidence:** confirmed (ambiguity).

### 11. [MINOR] Stale or contradictory text across files
- FLOWS §5 trace row 5 ("4xx/5xx → Call: Refused") and §7 Call statechart (`AwaitingResponse --> Refused: 4xx/5xx`, `Refused --> SettledAfterRefusal` with no `getResult`) contradict SPEC V9 and INV-23.
- FLOWS §9 "Minimalism": "`--fresh` renews without a restart" (now `attest signer renew`).
- THREAT-MODEL §7 runbook uses `systemctl status attest-gateway attest-seller-host attest-vsock`. The units are now templated (`attest-gw@…`, `attest-seller@…`, `attest-vsock@…`).
- ARCHITECTURE header "(r2)":
  - §1.3 still says only the block is checked;
  - §3 shows one socat on 5005;
  - §7 says "including the planned Nov 8 re-registration".
- TASKS T25 briefs claims "C3.1–C4.5", so C4.6 and C4.7 (added in SPEC §11) are never put to the G3+4 reviewer.
- SPEC §11 G5 says "USA₮ may slip to Nov 6", but T32's done-when (≥ 1 USA₮ verified) blocks T33's G5 review. Say whether G5 closes on USDC.
- SPEC §13 cut item 6 (retire the Sepolia seller, tutorial on mainnet) conflicts with T34's `docs:tutorial-test` on Sepolia and NFR-5. Add the T34 change to the cut.
- T37 (Sepolia live alongside mainnet) has no date in §13.
- T35's J2 tamper must run against the live demo, but the tamper proxy "must not be reachable in the production gateway config". Say which gateway instance the demo tampers.

**Fix:** one pass over FLOWS, THREAT-MODEL, ARCHITECTURE and TASKS; SPEC wins.

**Confidence:** confirmed.

---

## What I could not verify

- The Celo hosted facilitator's actual `/settle` behaviour: whether it is x402-rs `main` unmodified, whether `success:true` means mined, which status a used nonce or a drained balance gets, and its 429 policy. Findings 1 and 8 rest on x402-rs source.
- Whether a facilitator 429 happens at demo load (about 1 req/s). This sets finding 1's likelihood.
- RPC lag between the facilitator's node and Forno right after settlement (finding 6b).
- buy's Celo RPC capability: per-method pricing, batching support and latency (finding 9).
- Whether the three 1 vCPU / 1024 MiB enclaves fit with this EIF. AWS allows 4 enclaves per parent and 1 vCPU on Graviton; the EIF size is unknown until T12.
- `registerSigner` and `renewSigner` gas on Celo (about 14.0M is extrapolated from Base); calldata floor pricing could add about 1M.
- Exact AWS cert rotation for a running enclave after 6 days (finding 3's cost estimate).
- The coinbase legacy v1 payload shape: I relied on r2's reading and didn't re-check it.
- Hackathon rules on transferring the ERC-8004 NFT (BLOCKING in OPEN-QUESTIONS).

Answer for OPEN-QUESTIONS (S8, T19a), from live reads on 2026-10-19: both Forno endpoints serve state 400 and 7,200 blocks back. Sepolia refuses beyond about 10,064 blocks. Mainnet served 200,000 blocks back.

VERDICT: changes required
