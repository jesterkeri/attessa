# Design review r4: attested execution provenance on Celo

Reviewed 2026-10-19. SPEC r4 is authoritative for this review.

## External facts checked

- `base/nitro-validator` is an AWS Nitro attestation validator and requires integrators to enforce their own replay and freshness policy: https://github.com/base/nitro-validator (commit pin `0ea0d12` was not fetched from this environment).
- The x402 v2 specification defines the `authorization` flow as verify → resource → settle and uses `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE` headers: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
- ERC-3009 defines `authorizationState(authorizer, nonce)` and `AuthorizationUsed(authorizer, nonce)`: https://eips.ethereum.org/EIPS/eip-3009
- ERC-8004's reference registry clears `agentWallet` on transfer and requires the new wallet's EIP-712 signature, while the current owner submits `setAgentWallet`: https://github.com/erc-8004/erc-8004-contracts/blob/master/contracts/IdentityRegistryUpgradeable.sol
- On 2026-10-19, JSON-RPC `eth_chainId` succeeded at `https://forno.celo.org` (`0xa4ec`, 42220) and `https://forno.celo-sepolia.celo-testnet.org` (`0xaa044c`, 11142220).
- On 2026-10-19, `GET https://api.x402.celo.org/supported` listed v1 `celo` EIP-3009 USDC, USDT, and USAT, plus v2 `eip155:42220`. `GET https://api.x402.sepolia.celo.org/supported` listed v2 `eip155:11142220` USDC, but its v1 `celo-sepolia` entry had no assets.

## r3 fix status

| r3 finding | Status in r4 | Notes |
|---|---|---|
| 1. Concurrent settle senders terminalize a paid row | Partially fixed | Retry ordering is fixed, but the handler can still trust a stale negative nonce read. See finding 2. |
| 2. Fork-revoke test refuses before the revoke | Fixed | T23 now has a baseline verified call, fork inputs, block production, and a fake facilitator. |
| 3. Signer renewal comes too late | Fixed | Renewal is triggered below 72 h and the schedule requires it every four days. |
| 4. Wallet signature precedes ownership transfer | Fixed | T31 transfers first and binds the cold owner in the signature. |
| 5. Per-enclave vsock port cannot be passed in | Fixed | The EIF listens on 5000; CID selects the enclave. |
| 6. V10 historical reads have no RPC fallback | Fixed | State read falls back to replaying events, then returns `uncertain{rpc_unavailable}`. |
| 7. Deploy check omits three contracts | Fixed | The check compares all four deployed runtimes with immutable references spliced. |
| 8. `success:true` contradicts receipt evidence | Fixed | A receipt without both required logs remains `settle_pending`. |
| 9. Input-read batching and cost unspecified | Fixed | One batched buy request per evaluation and both cost cases are stated. |
| 10. Ledger reservation cleanup and V0 race unclear | Fixed | Every V6 cleans stale reservations and V0 waits for a matching reservation. |
| 11. Stale text across files | Partially fixed | Several documents still carry r3 headers or task text that names r3. See finding 3. |

## New findings

### 1. [CRITICAL] The Sepolia paid path cannot use the specified x402 v1 facilitator

**Where:** SPEC §1 FR-8, §2.6, §6.2, §7 V2–V9; TASKS T19–T23 and T34; FLOWS J0/J1; ARCHITECTURE §5.

**What a user sees:** The default Sepolia tutorial receives a v1 quote, but the public facilitator has no v1 `celo-sepolia` asset to verify or settle it. The first real paid call cannot complete, so G3+4 and the tutorial gate cannot pass.

**Why:** The live facilitator advertises Sepolia USDC only for x402 v2 `eip155:11142220`; its legacy v1 `celo-sepolia` kind has an empty asset list. r4 still requires v1 on both networks.

**Case:** A buyer signs the r4 v1 USDC authorization for a Sepolia gateway. `/verify` cannot select a supported v1 USDC requirement, so no paid, public Sepolia E2E exists.

**Fix:** Make x402 v2 with EIP-3009 the sole production protocol on both Celo networks. Use the canonical v2 headers, CAIP-2 networks, `amount`, and a payload whose `accepted` requirement is byte-for-byte equal to the selected offer. Keep a v1 compatibility adapter only as a non-production future option, not in the G3+4 path. Add a live supported-asset preflight and a v2 Sepolia E2E test.

**Confidence:** confirmed live.

### 2. [MAJOR] A stale negative `authorizationState` result can again withhold a paid response

**Where:** SPEC §6.2 step 11, §6.3 steps 1–5, INV-11, TASKS T19.

**What a user sees:** The gateway returns `settle_failed{insufficient_funds}` and withholds the response. The facilitator has already settled the authorization on a fresher RPC node, so the buyer later sees a used nonce but cannot retrieve the verified result.

**Why:** The handler turns a 400/412 into terminal `settle_failed` when `authorizationState` is false “at latest”. “Latest” is not a finality guarantee and may be behind the facilitator's broadcast or receipt node. The r4 change removes the two-sender race but not this stale-node race.

**Case:** The request handler receives 400 after a prior send or an external retry landed on the facilitator's node. Its configured RPC has not indexed that block and reports `authorizationState == false`; the gateway makes the row terminal before its reconciliation log scan observes the payment.

**Fix:** A 400/412 before expiry always moves to `settle_pending`. Only the reconciler may write `settle_failed{expired}` after a block whose timestamp is greater than `validBefore + 5` proves `authorizationState == false`; other terminal failures remain chain-evidenced. Add a lagging-RPC test where a handler 400 and stale false state are followed by the matching receipt and served result.

**Confidence:** high.

### 3. [MINOR] r4 was not fully propagated into document labels and task references

**Where:** FLOWS.md, THREAT-MODEL.md, PREFLIGHT.md, and TASKS T04/T19/T20.

**What a user sees:** Nothing at runtime, but a builder can treat r3 wording as current while implementing r4 settlement and SDK behavior.

**Why:** The files have r3 headers or name “SPEC r3” even though they describe some r4 fixes.

**Case:** A builder follows T19's “400/412 → settle_failed” summary rather than r4's conditional table.

**Fix:** Mark the propagated documents r5 and point every task at the authoritative current revision.

**Confidence:** confirmed.

## What I could not verify

- Exact source contents at base/nitro-validator commit `0ea0d12`; GitHub's raw object for that abbreviated pin was unavailable from this environment.
- The hosted Celo facilitator's detailed `/settle` status behavior because no API key was supplied. The r4 fake must not claim it has tested that behavior until T19 does.
- Whether Celo buy can pay the project’s v2 Sepolia quote. This remains a spike, not a prerequisite for the direct SDK path.

## Self-check after fixes

- Re-read the r5 payment flow in SPEC against FLOWS, TASKS, INVARIANTS, ARCHITECTURE, THREAT-MODEL, GLOSSARY, PREFLIGHT, PIPELINE, OPEN-QUESTIONS, KNOWN-LIMITS, and ADR-005.
- Searched the active design pack for the replaced v1 headers, `maxAmountRequired`, asset-identification error, and stale r3 task references. No active implementation instruction retains them. Historical ADR and review text remains unchanged by rule.
- Checked that no new gateway state was added. `settle_pending` has exits through matching receipt evidence, a cancellation, or expiry after `validBefore + 5`; terminal settlement failure remains chain-evidenced.
- Added the v2 wire and stale-RPC paths to T19. INV-9 and INV-11 continue to cover no pre-proof settle, one settlement per authorization, and chain-evidenced terminalization.
- Checked the SPEC error contract and FLOWS error table after removing `payment_invalid{asset_unidentified}`. No new error code was introduced.
- Searched all Markdown files for em dashes. None were found.
- Still open: the hosted facilitator's authenticated `/settle` response details and buy's v2 compatibility. Neither is assumed by the direct SDK design; T19 and S5 verify them before their respective gates.

VERDICT: implementation-ready
