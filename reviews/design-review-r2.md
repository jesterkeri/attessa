# Design review r2: attested execution provenance on Celo

Reviewer: independent adversarial design review (Opus 5.5). I had no access to the project discussion, only the artifacts listed in the brief.

Scope: `pack/SPEC.md` (r2, authoritative), `FLOWS.md`, `TASKS.md`, `INVARIANTS.md`, `KNOWN-LIMITS.md`, `THREAT-MODEL.md`, `ARCHITECTURE.md`, `GLOSSARY.md`, `OPEN-QUESTIONS.md`, `PREFLIGHT.md`, `AGENTS.md`, `PIPELINE.md`, `adr/001-014`, `RESEARCH.md`, and `reviews/design-review-r1.md`. KNOWN-LIMITS L1-L22 are not re-reported, except where a limit's own statement is wrong (finding 13).

External facts checked on 2026-10-19:
- **base/nitro-validator**, cloned at HEAD `0ea0d12` (https://github.com/base/nitro-validator):
  - `src/NitroValidator.sol`: `Ptrs` index into `attestationTbs`; `decodeAttestationTbs` skips the unprotected header; PCR lengths of 32, 48 or 64 are accepted.
  - `src/CborDecode.sol`: `slice(bytes, CborElement)` and `keccak(bytes, CborElement)` live in library `CborDecode`, not `LibCborElement`.
  - `src/CertManager.sol`: `IP384Verifier public immutable p384Verifier` (line 85).
  - `foundry.toml`: solc 0.8.26, `optimizer_runs = 10000`, no `via_ir`.
  - `script/BaseSepoliaDemo.s.sol`: 3 deploys, 4 cert-cache calls, then a cold and a warm `validateAttestationWithHints`.
  - `docs/hinted-p384-nitro-attestation.md` §8: CertManager runtime is 22,297 bytes, 2,279 under EIP-170.
  - I decoded the bundled fixture with the repo's own `tools/nitro_attestation_input.js`: PCR0-2 are non-zero 48-byte values (not debug mode), `public_key` is null, `user_data` is 20 bytes, and the timestamp is 1767472867402 ms.
- **ERC-8004 reference contracts** (https://github.com/erc-8004/erc-8004-contracts, `IdentityRegistryUpgradeable.sol`):
  - `setAgentWallet` requires `msg.sender` to be the owner or an approved address, plus an EIP-712/1271 signature from the new wallet.
  - `_update` clears `agentWallet` on transfer.
- **x402-rs** main at `e75adda` (2026-07-13) (https://github.com/x402-rs/x402-rs):
  - The `ErrorReason` enum has no `settlement_pending`, `unexpected_settle_error` or `invalid_transaction_state`.
  - Settle verification failures return HTTP 400 (or 412) with `success:false`. Failures after broadcast (pending-receipt error, reverted tx) return HTTP 500 with `unexpected_error`.
  - `assert_time` requires `validBefore >= now + 6`.
- **coinbase/x402** legacy v1 (https://github.com/coinbase/x402, `typescript/packages/legacy/x402`):
  - `PaymentPayloadSchema` is `{x402Version, scheme, network, payload}`. There is no asset field.
  - `findMatchingPaymentRequirements` matches on scheme and network only.
- **Live Celo facilitator** `GET /supported` (https://api.x402.celo.org, https://api.x402.sepolia.celo.org): mainnet v1 `celo` lists USDC, USDT and USAT (all eip3009). Sepolia v1 `celo-sepolia` is listed with no asset list. `POST /settle` without a key returns 401.
- **Live RPC** via viem at https://forno.celo.org and https://forno.celo-sepolia.celo-testnet.org:
  - Chain ids are 42220 and 11142220.
  - Both USDC tokens return `name()`/`version()` = "USDC"/"2", and `eip712Domain()` reverts on both.
  - USA₮ `eip712Domain()` returns "Tether America USD"/"1"/42220, and `version()` reverts.
  - `DOMAIN_SEPARATOR()` equals the locally computed separator for mainnet USDC and USA₮.
  - The implementation bytecode of all three tokens contains the `AuthorizationUsed`, `AuthorizationCanceled` and `Transfer` topic hashes.
  - On both identity registries, `owner()` = `0x5472…2603`, `getVersion()` = 2.0.0, and `ownerOf` of a nonexistent id reverts.
  - Self registries on both networks answer `ownerOf`/`hasHumanProof`/`isProofFresh` for ids 1 and 2.
  - Forno `eth_getLogs` on mainnet USDC works for a 1,000-block span and fails for 10,000.
  - `eth_gasPrice` is 202.5 gwei, and the head timestamp equals wall-clock time.

---

## r1 fix status

| r1 # | Status | Reason |
|---|---|---|
| 1 | Fixed | SPEC §3.4 step 2 names `tbs`. T04 uses a mock with `tbs ≠ attestation`, T05 runs a mutation, T07b pads the header and T16b is a positive real-attestation test. Nit: the helpers are in `CborDecode`, not `LibCborElement` (finding 18) |
| 2 | Fixed | Copy says "owner says it's built from …", backed by L20, the claims table and "Never say". FLOWS §11 still says "the exact build the seller published" (finding 18) |
| 3 | Fixed, but the fix opened a hole | `refused` waits for chain proof, and ambiguous settles go to `settle_pending`. But `refused` treats any non-2xx (including a proxy 502 after a real settle) as a gateway refusal and never fetches the result (finding 3) |
| 4 | Fixed | 202 `settle_pending`; response persisted before settle; `/v1/results` serves `settled\|delivered\|delivery_failed`; `settled` → `delivery_failed` after 30 s |
| 5 | Fixed | Expiry is read at block H with `H.timestamp > validBefore + 5`, in both gateway and SDK (INV-11, INV-20) |
| 6 | Fixed | The reconciler and V11 require `AuthorizationUsed` and `Transfer(payer→payTo, amount)` in one tx from the pinned asset |
| 7 | Fixed | Idempotency table, startup sweep, and no row before `/verify` (INV-21) |
| 8 | Fixed (accepted) | L17 plus registering the origin on deploy day (T31, PREFLIGHT) |
| 9 | Fixed (accepted) | Trust table rows, L19, ADR-002 amendment; live owner EOA re-confirmed on both networks |
| 10 | Partially fixed | T31 transfers to a cold owner if the rules allow it (BLOCKING in OPEN-QUESTIONS). `setAgentWallet` must be sent by the cold owner, not "signed by the agent wallet" as a tx (finding 15) |
| 11 | Fixed | Informational link (ADR-014), try/catch, `isProofFresh`, `linked` mode only, live SDK re-check; T08 calls all three selectors |
| 12 | Fixed | Derived `requestId`, and T22 treats a 400 as a bug. The derivation uses `asset`, which a v1 payload doesn't carry (finding 2) |
| 13 | Fixed | Domain pinned via `eip712Domain()`; T26 updated; values re-confirmed live |
| 14 | Fixed | Reservation at V6, release only on chain-confirmed not-charged, all settled outcomes count (INV-19). Where reservations are stored is unspecified (finding 16) |
| 15 | Fixed, but the fix opened a hole | `inputs` are in the response and the block hash and age are checked. Only the block is checked, not the values, so "verified" still covers fabricated inputs (finding 6) |
| 16 | Fixed | Strict grammar, `chainId == configured`, amount regex, enclave error → HTTP mapping |
| 17 | Fixed | Ledger schema defined; `verifyPaidResponse` takes the entry |
| 18 | Fixed | Unpaid evaluate 120/min/IP |
| 19 | Fixed | Pause/resume CLI, 429 backoff, 503 before verify; `resume` probes `/supported` |
| 20 | Mostly fixed | Revoke and modified-build runs on a fork, port 5006, 1 vCPU each. New ambiguities: `--network local` chain id, and "throwaway release" on the fork (finding 14) |
| 21 | Partially fixed | `cast code` check and T01 receipt parsing are fixed. But T10/T30's CertManager hash check can't pass (finding 7), and T01's "exactly 8 lines" doesn't match base's script, which sends 9 txs (finding 11) |
| 22 | Fixed in intent, but the check can't pass | The demo stack is separated and DeployValidatorStack is production-only. The check meant to prove it (code hash equality) fails because CertManager has an immutable (finding 7) |
| 23 | Partially fixed (still open, MAJOR) | Cuts: Self enforcement, `--via buy` and `release verify` are optional, G3+G4 reviews merged, S3 decision on Oct 26. Still open: no per-gate dates, three Codex STOP cycles before Nov 2, AWS enclave approval and the domain not obtained, Sepolia broadcasts still manual (OPEN-QUESTIONS undecided). r2 also adds work (T07b, T16b, mutate.sh, reconciler retry, Nov 8 renewal, two-network ops; findings 4, 9) |
| 24 | Fixed | SPEC step 3 has the underflow guard; tests cover `(now, now+60]` |
| 25 | Fixed, but the fix opened a hole | `--fresh` re-attests without a restart, and `configure` is one-shot. Copy and runbooks now also use `--fresh` to *renew* an expiring signer, which reverts `SignerExists` (finding 4) |
| 26 | Fixed, but the fix opened a hole | Verifiers reject \|issuedAt − now\| > 120, but they apply it at verification time, so late but honest results fail (finding 1). L6's new "720 s" is wrong (finding 13) |
| 27 | Fixed | WHATWG + UTS-46 non-transitional, trailing dot and IP literals rejected, 9-267 bytes, vacuous check removed |
| 28 | Fixed | Header grammar table, string-only JSON encodings, std base64 with padding, network table, pinned assets |
| 29 | Fixed | 4-6 CELO copy, 324 h / $50 alarm, `health.sh` expiry alert, Nov 8 re-registration (but see finding 4) |
| 30 | Mostly fixed | The listed contradictions are resolved. New stale text remains (finding 18) |
| 31 | Fixed | L18 for CRLs; `attestationHash = keccak256(tbs)` |
| 32 | Fixed | `OPERATOR_MISMATCH` binds the operator into checkSigner (INV-8) |
| 33 | Fixed | Window based on `chainNow`, with `validAfter = chainNow − 60` |

---

## New findings

### 1. [MAJOR] Results that arrive late are checked against "now", so honest paid calls become `paid_but_rejected`
**Where:** SPEC §7 V9 (polls `/v1/results` until `validBefore + 60`), V10 ("every §6.2 step-9 check"), `getResult`/`reconcilePending`; SPEC §6.2 step 9 (`|issuedAt − now| ≤ 120`, `expiresAt > now`, `now − inputs.block.timestamp ≤ 300`, `checkSigner == OK`); FLOWS §6 "J1 interrupted" ("Charged … Fetching your answer… done. It checks out").

**What a user/judge sees:** "Warning: you were charged 0.02 USDC but the answer didn't check out (clock_skew)". The copy blames the gateway and tells the user to report it, even though the gateway was honest and the proof is valid.

**Why:** every freshness check compares to the verifier's current time. A result fetched later fails even when it was produced and settled correctly:
- the 202 poll path can run until about 180 s after signing;
- the Ctrl-C path, `attest status --pending` and `reconcilePending` can run minutes or hours later;
- `/v1/results` serves results for 24 h.

After 120 s the proof fails `clock_skew`, after 300 s `stale_inputs`, and after 600 s `proof_expired`. If the 7-day signer has expired by then, it also fails `signer_not_active`.

**Reproduce/case:**
1. `attest call`, then Ctrl-C after V8.
2. The gateway settles at t = 3 s.
3. Run `attest status --pending` at t = 200 s. `getResult` → 200 → V10 → `|issuedAt − now| = 197 > 120` → `paid_but_rejected{clock_skew}`.

**Fix:** for a paid call, evaluate the time checks against the ledger entry and the settlement, not against the current time:
- `|issuedAt − ledger.createdAt| ≤ 120 + window`;
- `issuedAt ≤ settlementBlock.timestamp ≤ expiresAt`;
- `inputs.block.timestamp ≥ ledger.createdAt − 300`;
- signer Active at the settlement block (read `SignerRevoked` events, or `checkSigner` at that block via `eth_call`).

Keep the "now" checks only for the live gateway step 9. Add an INV-13 test: a result fetched 200 s and 2 h after settlement returns `verified`.

**Confidence:** confirmed (spec text)

### 2. [MAJOR] An x402 v1 payment doesn't say which asset it pays in, so the mainnet USDC + USA₮ gateway can't follow §6.2 steps 3-4
**Where:** SPEC §6.2 step 2 (one `accepts` entry per asset, same payTo, default price 20000 for both), step 3 ("must match an offered one exactly (network, scheme, **asset**, payTo, amount)"), §2.2 derived `requestId = keccak256(asset ‖ payer ‖ nonce)`, step 4 lock on `(asset, payer, nonce)`, §6.4 `UNIQUE(asset, payer, auth_nonce)`; TASKS T32 (≥ 1 USA₮ verified), claim C5.2.

**What a user/judge sees:** USA₮ calls on mainnet fail with `payment_invalid{invalid_signature}`, or a builder ships an improvised matcher. The second-track demo (C5.2) fails on or after Nov 2.

**Why:**
- The v1 `X-PAYMENT` is `{x402Version, scheme, network, payload:{signature, authorization:{from,to,value,validAfter,validBefore,nonce}}}`. Neither the asset nor the token's EIP-712 domain is in it (checked in x402-rs `proto/v1.rs` and coinbase legacy `x402Specs.ts`).
- With two assets at the same network, payTo and amount, the gateway can't pick the requirements to send to `/verify`.
- The reference v1 server picks the first entry matching scheme and network, which is USDC. A USA₮ authorization then fails signature verification.
- The derived requestId and the idempotency key need the asset *before* `/verify`.
- Sepolia has one asset, so G3+4 never exercises this. It shows up first at G5.

**Reproduce/case:** configure the mainnet gateway with both assets. `attest call --asset usat` signs under the "Tether America USD" domain. The gateway matches the USDC requirements, and `/verify` returns `invalid_signature`.

**Fix:** add to §6.2 step 3: "asset = the pinned asset whose EIP-712 domain makes `authorization` recover to `authorization.from`; if none or more than one matches (or the signature is EIP-1271/6492), try `/verify` against each offered requirement and use the single valid one". Compute the derived requestId and the lock only after the asset is known. Add a T19 case where two assets are offered and a USA₮ payment is made.

**Confidence:** confirmed (v1 wire format checked in two implementations)

### 3. [MAJOR] A proxy error after a successful settle becomes `settled_after_refusal`, and the paid result is never fetched
**Where:** SPEC §7 V9 ("4xx/5xx → `refused`"), the `refused → not_charged` paragraph ("true with a matching Transfer → `settled_after_refusal`"); FLOWS §7 Call statechart (`Refused → SettledAfterRefusal`, terminal); FLOWS §6 copy ("This is the gateway's fault"); SPEC §6.5 (Caddy in front of Fastify).

**What a user/judge sees:** "Warning: the service refused this call, but your payment permission was used anyway … This is the gateway's fault." The user paid. The verified result sits in `/v1/results` (`delivery_failed`), and the SDK never asks for it.

**Why:** the SDK treats any non-2xx as a refusal by our gateway logic. If Fastify crashes or restarts after `/settle` returns `success:true` (row `settled`, or still `settling` and later reconciled to `settled`), Caddy answers 502 with no SPEC §10 error body. The SDK records `refused` and waits out the window. It then reads `authorizationState == true` and goes straight to the terminal `settled_after_refusal`. The cancel path does fetch the result when the authorization was already used ("Too late to cancel … Fetching your answer"), but the default wait path doesn't.

**Reproduce/case:** gateway test hook that kills the process after `settled` is persisted and before the response is written. The SDK sees 502 from Caddy, waits about 125 s, and records `settled_after_refusal`. Gateway: after the 30 s rule the row is `delivery_failed`, and `/v1/results` returns 200.

**Fix:**
- Treat a non-2xx with no well-formed §10 body (`error` code plus matching `requestId`) as `uncertain`, not `refused`.
- On any outcome where the chain shows the authorization used with the matching Transfer, call `getResult` first. Report `verified` if it passes V10 (with finding 1's fix). Otherwise report `paid_but_rejected` or `settled_after_refusal`.
- Add an INV-20 sibling test.

**Confidence:** confirmed (spec logic)

### 4. [MAJOR] `attest signer register --fresh` can't renew an expiring signer: the same key reverts `SignerExists`
**Where:** SPEC §3.4 `registerSigner` step 8 (`status == None`, else `SignerExists`), §4.2 (`attest` returns "a fresh attestation for the same key"); FLOWS §6 J3 copy ("To renew without a restart: attest signer register --fresh"); THREAT-MODEL §7 alert runbook ("Signer expires in < 24 h … run `attest signer register --fresh` (no restart). Planned: Nov 8"); TASKS T36; ADR-010 amendment.

**What a user/judge sees:** on Nov 8, the planned renewal reverts. The CLI prints a renewal instruction that can't work. The mainnet signer expires on Nov 9 (registered Nov 2) unless the enclave is restarted the day before judging.

**Why:** a fresh attestation from the same enclave carries the same `public_key`, so it derives the same signer address. That address already has status Active, so step 8 reverts. Nothing in the registry extends `expiresAt`. Renewal therefore needs a restart: a new key, 4-6 CELO, downtime, and a Joshua broadcast, all on the eve of judging. Neither T36 nor the runbook budgets for that.

**Reproduce/case:** register a signer, then run `attest signer register --fresh` with the same enclave. The revert is `SignerExists`.

**Fix:** either:
- add `renewSigner(address signer, bytes attestation, bytes hints)`. It is operator-only, requires a fresh attestation whose `public_key` derives `signer` and whose binding still matches, and sets `expiresAt = now + SIGNER_TTL` for an Active signer; or
- make T36 a restart (start + register), schedule it with a drill, and fix the copy and runbook.

Either way, add a T36 verify that runs the chosen path on Sepolia first.

**Confidence:** confirmed (spec text)

### 5. [MAJOR] The reconciler's `/settle` retry can't be built from the stored row, and a failed retry can terminalize a settlement that actually landed
**Where:** SPEC §6.3 step 5 ("retry `/settle` once per tick"), §6.4 schema (no payment payload, signature or validAfter columns), §6.2 step 11 outcome table; TASKS T23 ("kill gateway between persist and settle → reconciler resolves and `/v1/results` serves"); THREAT-MODEL §7 ("Never logged: … X-PAYMENT signatures").

**What a user/judge sees:** either T23 can't pass when the kill lands before `/settle` is sent, or the buyer is charged while the gateway records `settle_failed` and withholds the result.

**Why:**
1. x402 `/settle` takes `paymentPayload` and `paymentRequirements`. After a restart, the reconciler has neither: the `calls` row stores no signed authorization. A builder must either add a column (a SPEC deviation) or drop step 5. If step 5 is dropped, a row killed before `/settle` just expires, and T23's done-when can't be met.
2. SPEC doesn't say how a retry's answer maps to a state. A builder who reuses the step 11 table will map a 4xx from the retry to terminal `settle_failed`. In x402-rs a 4xx is `transaction_simulation` or `invalid_payment_expired`. But a rejected *retry* says nothing about the *first* attempt, which may have broadcast and landed while the log query lagged. The row then becomes `settle_failed`: the buyer is charged, the result is withheld, and `/v1/results` returns 404.

**Reproduce/case:**
1. The first `/settle` times out after broadcast, and the tx is mined at t+16 s.
2. The reconciler tick at t+20 s hits a lagging log index and retries.
3. The facilitator simulates against the used nonce and returns 400 `transaction_simulation`.
4. If that is mapped as pre-broadcast, the row ends in `settle_failed`.

**Fix:**
- Add a `payment_payload TEXT` column (base64 X-PAYMENT, retained until a terminal state, then NULL) and the requirements needed to rebuild the request.
- State that a retry's response never moves a row to a terminal state. Only steps 1-4 (chain evidence) do.
- Add a T19 case for a retry that returns 400 while the first tx lands late.

**Confidence:** plausible (depends on builder mapping; the schema gap is confirmed)

### 6. [MAJOR] Inputs are block-checked but their values aren't, so "verified" covers fabricated code, nonce and balance
**Where:** SPEC §6.2 step 9 (inputs check = block hash + age only), §7 V10; SPEC §1 trust table ("inputs are returned and block-checked"); ARCHITECTURE §1.3 ("the operator can't quietly feed it lies"); FLOWS §6 J1 ("The answer came from that approved build … using Celo data from block 31,204,118"); ADR-012 amendment.

**What a user/judge sees:** a "verified" allow verdict for a contract payTo. The seller-host fed `code:"0x", nonce:"57"` with a real block header, and nothing flagged it.

**Why:** seller-host is untrusted (SPEC §1), and the enclave only checks grammar and that `inputs.payTo.address` matches the request. The gateway and the SDK confirm that block N exists and is ≤ 300 s old. Neither reads `eth_getCode` / `eth_getTransactionCount` / `eth_getBalance` for payTo at block N, although both already make an RPC call for that block. R3/R4 can be flipped at will, and the buyer's record says the answer used Celo data. FLOWS lists "input truth" as a no-go, but ARCHITECTURE, the trust table and the J1 copy claim more than that. KNOWN-LIMITS has no limit for unchecked values (L22 covers only the choice of block).

**Reproduce/case:** a seller-host shim that rewrites `inputs.payTo.code` to `"0x"`. The gateway settles, and the SDK reports `verified`.

**Fix:**
- In gateway step 9 and SDK V10, read the three values at `inputs.block.number` and compare them to `inputs.payTo`. A mismatch gives `inputs_mismatch`: the gateway refuses before settling, and the SDK reports `paid_but_rejected`. That costs three `eth_call`s.
- Otherwise, add a KNOWN-LIMITS line and change the ARCHITECTURE §1.3 and J1 copy to "inputs claimed for block N (not checked)".

**Confidence:** confirmed (spec text)

### 7. [MAJOR] T10/T30's CertManager code-hash check can never pass: CertManager has an immutable
**Where:** SPEC §3.5 ("`extcodehash(certManager)` equals the compiled production `CertManager` runtime hash"); TASKS T10, T30 (`node scripts/check-deploy.mjs` "prints OK for every check"); PREFLIGHT On chain.

**What a user/judge sees:** G2 and G5 can't close on their verify commands. Or the builder weakens the check, which AGENTS forbids.

**Why:** `CertManager.sol` line 85 declares `IP384Verifier public immutable p384Verifier`. Solidity writes immutables into the runtime code at deploy time. The artifact's `deployedBytecode` has placeholders at `immutableReferences`, so `extcodehash(deployed) != keccak256(artifact.deployedBytecode)` for every real deployment. This is the check meant to prove "never CertManagerDemo" (r1 #22). CertManagerDemo also has its own immutable.

**Reproduce/case:** deploy the production stack on anvil. `cast keccak $(cast code $CM)` differs from `keccak256(out/CertManager.sol/CertManager.json .deployedBytecode.object)`.

**Fix:** in `check-deploy.mjs`:
- take the artifact's `deployedBytecode`, splice the deployed `p384Verifier` address into every `immutableReferences` offset, then compare hashes;
- also assert `certManager.p384Verifier() == deployed P384Verifier` and `nitroValidator.certManager() == certManager`.

**Confidence:** confirmed (source read)

### 8. [MAJOR] The proof checks never say "recover the signer from the signature", and the proof header carries a `signer` field
**Where:** SPEC §6.2 step 9 (first two bullets: "signature low-s", "`checkSigner(signer, originHash) == OK`"), §7 V10 ("every §6.2 step-9 check"), §2.5 `X-Attested-Proof` (`"signer":"0x…"`). Compare V7 for liveness, which does say "signer recovered".

**What a user/judge sees:** if built literally, a forged proof with any low-s signature and the real signer's address in the header is reported `verified`. A fake answer looks genuine.

**Why:** the step-9 checklist is the contract both the gateway and the SDK implement. It names a low-s check and a `checkSigner` call on "signer" but never requires `ecrecover(proofDigest(p), sig) == signer`. A builder working the list item by item can take `signer` from the JSON. The on-chain `verifyProof` recovers, but SPEC lists separate off-chain checks rather than "call verifyProof".

**Reproduce/case:** modify a valid `X-Attested-Proof` by replacing the response, recomputing `responseHash`, and substituting a random low-s signature, keeping `signer`. An implementation that follows the checklist literally accepts it.

**Fix:** make the first step-9 bullet "recover `r = ecrecover(proofDigest(proof), signature)` (reject high-s, v ∉ {27,28}); require `r == header.signer`; use `r` for every later check". Add ProofCheck `bad_signature` vectors for "valid signature by another key" and "header signer ≠ recovered".

**Confidence:** plausible (an omission in the spec; the impact is critical if built literally)

### 9. [MAJOR] Nothing specifies how the Sepolia seller (the default for every new user) keeps running alongside mainnet during judging
**Where:**
- FLOWS §6 J0 ("Default: Sepolia until the user runs attest init --network mainnet"); NFR-5 (first verified call on Sepolia in 10 min); TASKS T34 (`pnpm docs:tutorial-test` runs on Sepolia), T36 (renews the mainnet signer only).
- SPEC §4.1 one-shot `configure` binds one chainId per enclave; §5 allocator 2 vCPU, with 5005 = production and 5006 = test build.
- SPEC §6.6 one network, registry, agentId and origin per gateway config; ARCHITECTURE §7 (one host, Nov 2-13).

**What a user/judge sees:** a judge follows the README tutorial in Nov 9-13. Either the Sepolia call fails (`liveness_failed` / `enclave_unavailable`) or the mainnet seller was stopped to make room for it.

**Why:**
- Serving both networks needs two enclaves (each binds one chain), two seller-host and gateway instances, two Caddy origins, two SQLite files and two sets of systemd units. That uses both allocator slots, and the T35 modified-build demo also needs the 5006 test enclave for a fresh attestation.
- The Sepolia signer from T16 (late October) expires 7 days later, and nothing renews it (and `--fresh` can't, finding 4).
- None of this is in SPEC §5/§6, TASKS or the cost model.

**Reproduce/case:** on Nov 10, run `attest init && attest call https://<sepolia-origin>/v1/evaluate …`.

**Fix:** decide one of these and write it into SPEC §5/§6 and TASKS:
- (a) Sepolia stays live: a second origin, a second gateway config, ports 5005 (mainnet), 5007 (Sepolia) and 5006 (test-on-demand), allocator 3 vCPU / 4096 MiB (c6g.xlarge has 4 vCPU), and a Sepolia renewal task next to T36; or
- (b) Sepolia is retired at G5, and J0/README/tutorial default to mainnet with small `--max-amount`.

**Confidence:** plausible (whether judges use Sepolia is unverified; the resource conflict is confirmed from the spec)

### 10. [MAJOR] (carried) r1 #23: the schedule still has no slack and no per-gate dates
**Where:** TASKS G2-G5; OPEN-QUESTIONS (Sepolia broadcast permission, domain, AWS approval); STATUS "blocked on".

**What a user/judge sees:** the mainnet demo slips past Nov 2, and outreach (RISK-5) starts late.

**Why:** 14 days remain for about 30 tasks, three Codex STOP/fix/re-review cycles and every testnet broadcast by hand. Prerequisites are still pending: the AWS enclave approval (apply "by Oct 21"), the domain, and Loops enrollment. r2 adds work: T07b, T16b, mutation scripts, reconciler retry, two-network ops and the Nov 8 renewal. Only S3 has a decision date.

**Fix:**
- Put target dates on gates: G2 done Oct 24, G3+4 done Oct 30, G5 Nov 2.
- Pre-decide a cut list in order if a gate slips (for example T29, T14 second build, USA₮ to post-Nov 2).
- Decide the Sepolia broadcast question today.

**Confidence:** plausible

### 11. [MINOR] T01 requires exactly 8 tx lines; base's demo script broadcasts 9
**Where:** TASKS T01 ("3 deploys + 5 calls", "exactly 8 lines"); SPEC §11 G1.

**Why:** `script/BaseSepoliaDemo.s.sol` deploys 3 contracts, sends 4 cache txs, then the cold `validateAttestationWithHints` and one warm validation (base docs §11). That is 9 txs. A builder running base's script can't meet "exactly 8" without editing the table.

**Fix:** "exactly 9 lines (3 deploys, 4 cache, cold and warm validate)", or "≥ 8 with the 5 verification txs labelled".

**Confidence:** confirmed

### 12. [MINOR] The settle outcome table uses reason names the facilitator doesn't emit, and leaves real ones unmapped
**Where:** SPEC §6.2 step 11; TASKS T19 fake-facilitator modes.

**Why:** x402-rs (`ErrorReason`) has no `settlement_pending`, `unexpected_settle_error` or `invalid_transaction_state`. Its settle failures before broadcast are HTTP 400 (412 for allowance) with reasons such as `transaction_simulation`, `invalid_payment_expired`, `chain_id_mismatch`, `recipient_mismatch` or `accepted_requirements_mismatch`. Failures after broadcast are HTTP 500 `unexpected_error`. A 400 with `transaction_simulation`, which is what a front-run nonce produces, matches no row. The fake facilitator in T19 then tests fictional strings.

**Fix:** key the table on HTTP status first: 2xx + `success:true` → settled; 400/412 → `settle_failed{reason}` (first attempt only, see finding 5); 401/402 → pause; 429 → backoff; 5xx, timeout or network error → `settle_pending`. Build the fake facilitator from x402-rs's actual responses.

**Confidence:** confirmed for x402-rs main; the hosted Celo build is unverified

### 13. [MINOR] KNOWN-LIMITS L6's "a proof lives at most 720 s" is wrong
**Where:** KNOWN-LIMITS L6; SPEC §2.3 (`expiresAt = issuedAt + 600`, plus the ±120 s rule).

**Why:** a verifier accepts a proof only while `|issuedAt − now| ≤ 120`. A host can shift `issuedAt` forward by 120 s at most, so a proof is accepted for at most 240 s after real issuance. The 600 s `expiresAt` never binds for a verifier that applies the skew rule. Finding 1 is the practical consequence.

**Fix:** correct L6 to "at most 240 s", or drop the skew rule for proofs and keep it for liveness (with finding 1's fix).

**Confidence:** confirmed

### 14. [MINOR] Fork-based tasks don't say which chain id or which release they use
**Where:** TASKS T17 (`--network local --rpc http://127.0.0.1:8545` against `anvil --fork-url $SEP`), T23 (`e2e:fork-revoke` "against a throwaway release, never the live one"); SPEC §2.6 (`local` = 31337).

**Why:**
- By default anvil keeps the forked chain id (11142220). A CLI that enforces `local = 31337` refuses with `network_mismatch`, and one that runs `anvil --chain-id 31337` breaks any binding check. Two builders will pick differently.
- On a fork, revoking the live release is harmless and the state is discarded. A "throwaway release" has no enclave that signs for it unless a second enclave or a mock signer is used, so T23's fork run is unspecified.

**Fix:** "`local` = whatever chain id the RPC reports when `--fork` is used; the deployments entry is copied from the forked network". In T23, revoke the live release on the fork.

**Confidence:** confirmed (ambiguity)

### 15. [MINOR] `setAgentWallet` after the transfer must be sent by the cold owner
**Where:** SPEC §8 (`attest agent transfer` "then `setAgentWallet` signed by the agent wallet"), TASKS T31.

**Why:** in `IdentityRegistryUpgradeable`, `setAgentWallet` requires `msg.sender` to be the owner or an approved address, and takes the new wallet's EIP-712 signature (with a bounded deadline) as a parameter. Sent from the agent wallet after the transfer, it reverts. The flow also needs two keys on two machines: the cold key off EC2 and the agent key on EC2.

**Fix:** "the agent wallet signs the EIP-712 `setAgentWallet` message on EC2 (`attest agent wallet-sig`); the cold owner submits the tx". Add `getAgentWallet(agentId) == agent wallet` to T31's done-when.

**Confidence:** confirmed (source read)

### 16. [MINOR] Ledger and reservation details two builders will fill in differently
**Where:** SPEC §7 V0, V6, V8, ledger entry; §6.1 `/v1/results`; §6.4 retention.

**Why:**
- V6 reserves an amount "under the file lock", but SPEC never says where the reservation is stored or how it is tied to the ledger entry, which is only written at V8. A crash between V6 and V8 leaks the reservation for the day.
- SPEC doesn't say whether a re-run after a terminal outcome reuses the buyer's requestId. Reuse after a refused call hits 409 `request_id_conflict` forever, because the gateway row for that id is terminal and holds a different payment.
- `/v1/results` serves 200 for `settled|delivered|delivery_failed` rows, but `response` is set to NULL after 24 h. It should be 404 `result_not_found` once NULL.

**Fix:** store reservations as ledger entries in state `reserved` (written at V6, released at V7 failure); every new call gets a fresh CSPRNG requestId; serve 404 when `response IS NULL`.

**Confidence:** confirmed (ambiguity)

### 17. [MINOR] Input reads are paid before settlement, so a buyer can drain the agent wallet cheaply
**Where:** SPEC §6.2 steps 5-8 (`/verify` → evaluate, which pays buy for the reads → settle), §5 input fetch, THREAT-MODEL TB1 DoS (unpaid limits only).

**Why:**
1. The attacker signs a valid authorization. It passes `/verify`, and seller-host pays buy for three reads ($0.001-0.01, per the ASSUMPTION).
2. The attacker then calls `cancelAuthorization` (about 0.0004 CELO) or moves the funds before settle.
3. Settle fails, and the seller has paid for nothing.

Paid requests have no per-IP or per-payer limit, only an in-flight cap of 16. The agent wallet holds at most 5 USDC, so the attack exhausts it quickly and pushes inputs onto the Forno fallback, which breaks the RISK-6 scoring path.

**Fix:** a per-payer limit on paid calls that fail to settle (for example 5 per hour gets `rate_limited`). Alert when buy spend exceeds settled revenue.

**Confidence:** plausible

### 18. [MINOR] Cross-file inconsistencies that remain or are new
**Where / why:**
- SPEC §3.4 step 2 says to read with `tbs.slice(ptr)` / `tbs.keccak(ptr)` "from the validator's `LibCborElement`". Those functions are in library `CborDecode` (`using CborDecode for bytes`). `LibCborElement` has only `start/end/length/isNull`.
- ARCHITECTURE §5 pins "`runs = 200`, `via_ir` as the dependency requires". The dependency uses `optimizer_runs = 10000` and no `via_ir`, and its CertManager has only 2,279 bytes of EIP-170 margin under those settings. Compile it with the dependency's settings, or check `forge build --sizes` in T02.
- FLOWS §10 still maps facilitator 402 to `settle_failed{facilitator_out_of_credits}` and then argues with itself ("…? No: …"). SPEC maps it to `settle_pending` + `paused`.
- FLOWS §11's one-sentence explanation says "signed by the exact build the seller published". That phrasing is on the "Never say" list without S3 (SPEC §12), and the README may reuse it.
- SPEC §2.5 says `X-PAYMENT-RESPONSE` is "present … on 202", but §6.2 step 11 says "if a tx hash is known". x402-rs returns an empty `transaction` on 500.
- SPEC §2.5 says `X-Request-Id` is "always echoed", but an unpaid 402 without one has nothing to echo.
- KNOWN-LIMITS L10 says "$0.34-0.68" for 4-6 CELO. At $0.082, 4-6 CELO is $0.33-0.49; $0.68 is the cold 8.3 CELO case.
- FLOWS §2 Endpoint object omits `operator`, and FLOWS §7's Signer statechart has no `OPERATOR_MISMATCH` inert path.

**Fix:** one pass over FLOWS, ARCHITECTURE and KNOWN-LIMITS; SPEC wins.

**Confidence:** confirmed

---

## What I could not verify

- The Celo hosted facilitator's actual build and responses. I read x402-rs `main` (`e75adda`); the hosted service may wrap it differently (API-key layer, status codes, whether `/settle` waits for the receipt).
- Whether `buy curl` (or buy-core) picks USDC or USA₮ when a v1 402 offers both, and whether it sends any request-id header.
- AWS Nitro: two (or three) 1-vCPU / 1024 MiB enclaves side by side on c6g.xlarge with this allocator config, and whether the EIF fits in 1024 MiB. S2 is meant to confirm this.
- That Caddy returns 502 to the client when Fastify dies mid-request. Standard reverse-proxy behaviour; not tested.
- Whether the hackathon judges are expected to use Sepolia, and whether the rules allow the ERC-8004 NFT transfer (finding 9, T31).
- Self `linked`-mode semantics of `ownerOf`. The selectors respond on both networks, but I didn't identify registration modes.
- `registerSigner` gas on Celo. ~14.0M is extrapolated from base's Base Sepolia receipts; I didn't simulate the registry's extra decode and calldata cost.
- Whether `via_ir` would push CertManager over EIP-170 (finding 18).
- Facilitator credit counts (20 vs 1 free mainnet settlements).

Answer to an OPEN-QUESTIONS item, for the design session: base's fixture is not debug mode. PCR0-2 are non-zero, `public_key` is null and `user_data` is 20 bytes, so T07(a)'s expected revert is `BindingMismatch(0)`.

VERDICT: changes required
