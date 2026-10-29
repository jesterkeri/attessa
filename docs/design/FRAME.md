# Stage 1: frame, tier, diff, legal scope

Joshua, this is the frame for the trust layer, seeded from `SYSTEM_DESIGN_BRIEF.md`, `PLAN_V3_After_Codex_2026-10-10.md`, `CENCORI_AND_BUY_DEEP_DIVE_2026-10-10.md`, `BRIEF_CARD.md` and the 2026-10-19 research (`RESEARCH.md`).

**Route:** written plan → stage 1, seeded from the brief, then the diff below. The Gate 1 kill test runs in parallel in Claude Code (`BUILD_KICKOFF.md`), because nothing in this design changes it.

## 1. The job, solution-agnostic

When an agent pays for a service it doesn't control, it can't tell which code produced the answer, and on buy it has already paid before it finds out. The job is to let a buyer (or the marketplace acting for buyers) **check, before money moves, that a response was produced by a specific approved build, and refuse to pay or use it otherwise**.

The property, named honestly: **attested execution provenance**. It is not "trustless AI", "provably correct output" or "verified sellers".

## 2. Consumers

| Class | Who | What they need |
|---|---|---|
| Buyer agent / developer | an agent with a Celo wallet buying x402 services (via buy or directly) | one call that pays only if the response verifies, and a clear reason when it doesn't |
| Seller operator | someone running a paid service who wants to be checkable | a template enclave, a register script, and a release they can revoke |
| Marketplace / gateway operator | buy (the target adopter); in the demo, us standing in for it | a drop-in "verify before settle" step and evidence to write to ERC-8004 reputation |
| Agent owner (Self-verified human) | the person accountable for a seller agent | authority to approve and revoke releases and signing keys |
| Judges / grant reviewers | Loops panel + AI repo reader; Prezenti | a demo that shows pass / tamper-reject / modified-build-reject, real paid calls, honest limits |

## 3. Stage and hard constraints

- **Stage:** hackathon MVP that becomes grant-funded infrastructure.
- **Deadline:** Nov 9 2026 09:00 GMT (submission). Internal: mainnet demo by Nov 2.
- **Team:** one developer (Joshua), Claude Code builds, Codex reviews.
- **Chain:** Celo. Sepolia (11142220) first, then mainnet (42220). Mainnet is required for the hackathon.
- **Stack:**
  - Solidity (Foundry) using base/nitro-validator, pinned to a commit
  - TypeScript SDK and gateway
  - Rust or Go enclave app on Nitro (arm64, `c6g.xlarge`)
- **Budget:** about $0. AWS credits, Celo gas around $0.66 per cold registration, and facilitator free credits (20 mainnet per the live config).
- **Rules:**
  - Hackathon: ERC-8004 from the agent wallet; public repo; code written in the window; proof of payment.
  - Frontier: Self Agent ID, KarmaGAP, KYC.
- **Dev machine:** Windows + WSL2 (12 GB cap). Keep builds lean; the enclave image is built on the EC2 host.

### Second track (brief §4b, added 2026-10-19)

The same build also enters **"Stable Agents: Open Corridors, USA₮ with x402"**, judged on "real settlement between independent parties, with the currency choice justified by the user it serves". What that changes:

- **The gateway is token-agnostic.**
  - The endpoint config lists accepted assets.
  - The 402 offers one `accepts[]` entry per asset (USDC for buy-style buyers, USA₮ for this track).
  - The proof's `paymentId` is the EIP-3009 nonce regardless of token.
- **USA₮ works on mainnet only.** The Celo facilitator's Sepolia `/supported` lists only USDC. So USA₮ flows are tested end to end on mainnet with small amounts, after the Sepolia USDC path passes. The mainnet USA₮ contract is `0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771`; its EIP-712 domain name/version must be read from the contract before signing **[to check in Gate 3]**.
- **Settlement log is a deliverable.** Per settled call: payer, payTo, asset, amount, tx hash, requestId, verdict. It's exportable as CSV/JSONL for the submission. For x402 txs the submission gives our **payTo address** (no attribution tag).
- **Independent buyers.** Self and Google Cloud run a USA₮ mainnet faucet for Self-verified humans (blog.celo.org "The First (F)air Drop", amounts **[unverified]**). That gives independent buyers a way to get USA₮ without us funding them, which also keeps them "not first funded by you".
- **Currency justification** (for the submission): the evaluator's buyers are agents paying per check in dollars. USA₮ is a regulated dollar stablecoin on Celo, claimable by verified humans, so a buyer can pay a few cents per check without holding a volatile asset or being funded by us.

## 4. Non-goals (MVP)

Confidential VM marketplace, GCP or other TEE types, native Cencori integration, refunds/escrow, dashboard, key recovery/KMS sealing (v1 = ephemeral key per boot), polished frontend, multi-seller discovery, proving model correctness or input truth.

## 5. Tier

**Tier 2, scoped to the MVP.** This is a security and payments protocol: contracts that hold authority, a gateway that moves money, and an attestation chain whose every link is a place to lie. That needs the full pass. Capacity, cost and UI phases stay short because the MVP has one seller, one gateway and no frontend.

## 6. Diff against the plan

**Already decided (keep):**

- Nitro + base/nitro-validator, used unmodified
- EnclaveRegistry that extracts the key from the attestation itself
- EIP-712 signed output with the listed fields
- lifecycle states; liveness challenge; endpoint-origin binding
- Mode A / Mode B split
- one seller + one buyer demo
- Sepolia → mainnet
- the out-of-scope list
- milestones and gates

**Silently assumed (each needs a decision; the design makes it):**

1. **Who runs the pre-settlement gateway.** This is the biggest one.
   - x402 has the buyer sign the payment authorization *before* execution. Whoever holds that signed authorization can settle it until `validBefore`.
   - So Mode B protects the buyer only if the gateway is run by a party the buyer already trusts with settlement. That's **the marketplace (buy)**, which is already merchant of record with one payTo. It is **not the seller**.
   - The design therefore frames the gateway as a reference "verify-before-settle" step for buy's gateway, run by us in the demo.
   - Buyer-side safety net either way: a short `validBefore`, and the SDK cancels the authorization (EIP-3009 `cancelAuthorization`) when verification fails.
2. **Registration is one transaction.** It isn't: the cold path is 5 transactions (~41.3M gas), and the 30M block limit already forces the split.
   - Design every tx under 16.7M, because EIP-7825 arrives with Karst in Q4 2026.
   - The Nitro leaf cert lives ~3 h, so the whole cold path must land inside that window.
3. **x402 version.** buy's gateway and client speak v1. The Celo facilitator and docs speak v1 and v2. buy's client may mis-map v2 Celo Sepolia (`eip155:44787`). So the gateway serves **v1 `exact` on `celo` / `celo-sepolia`** for buy-client compatibility. v2 comes later.
4. **"buy sellers" can be paid through our gateway.** buy is a curated reseller (single payTo). Whether a listed seller keeps its own x402 origin and payTo is unverified.
   - Mode B works for any x402 client (including the buy client) pointed at our gateway's origin.
   - Getting the endpoint into buy's catalogue is a Gate 2 conversation, not an assumption.
5. **The enclave signs "every paid response".** The enclave has no network. Requests reach it over vsock through an untrusted parent, so TLS termination, request integrity and the parent's power to withhold or reorder all need stating.
6. **Buyers can check "which code".** Only if the PCR0 maps to published source through a **reproducible build**. Otherwise "approved release" is just a hash the seller asserts.
7. **One identity.** Hackathon wants ERC-8004 on the reference registry (`0x8004…`), while Frontier wants Self Agent ID, a separate registry. The design binds both and says which one gates what.
8. **Our own seller earns score.** It doesn't. Paid calls to ourselves don't count. Scoring comes from the buyer client paying buy services we don't control.
9. **The facilitator is free.** Live config says 20 free mainnet settlements and the docs say 1. After that it's gas + 0.3%, and `/settle` needs an API key.

**Never mentioned (the real work):**

- What happens to a buyer's signed authorization when verification fails (expiry and cancel).
- Delivery after settlement fails, so the buyer paid but got nothing. Needs an idempotent retrieval by `requestId` and a settlement receipt.
- `settlement_pending` / settle timeout reconciliation through `authorizationState` + `AuthorizationUsed`.
- The registry's own freshness rules: attestation timestamp window, the on-chain challenge nonce, rejecting debug (all-zero) PCRs. The validator doesn't do these.
- What the response signature covers when the response is large or streamed (MVP: no streaming, ≤ 64 KB).
- Demo availability during judging (Nov 9–13), so the enclave has to be up those days.
- Privacy of request bodies passing through the gateway and parent (they see plaintext in the MVP).
- How a buyer learns which `agentId` to resolve when all it has is a URL.
- Abuse of the free liveness endpoint (rate limits).
- Key rotation every boot means a new registration (~13.8M gas warm, or ~41M if the chain cache expired).

## 7. Legal and trust surfaces

Claude drafts these; it is not a lawyer. Jurisdictions: Nigeria (NDPA 2023, operator), plus global users (GDPR applies if EU users send personal data through the gateway).

| # | Item | Status |
|---|---|---|
| 1 | Privacy policy | **applies.** The gateway logs payer wallet addresses, request/response hashes, IPs (rate limiting). Short policy in the repo and served by the gateway at `/privacy` |
| 2 | Terms of service | **applies.** Paid service; disclosures: mainnet irreversibility, beta, no custody, "attested execution provenance" limits, Mode A has no payment protection |
| 3 | Refund policy | **applies.** Mode B: not charged if verification fails (authorization never settled, and cancelled by the SDK). After settlement: no refunds (x402 has no refund primitive). Mode A: no payment protection. Stated in ToS and the 402 `description` |
| 4 | Cookie policy | does not apply, because there's no web UI. The docs page is static with no analytics. Re-check if an explorer page ships |
| 5 | Cookie consent banner | does not apply (same reason) |
| 6 | Form consents | does not apply, because there are no forms in the MVP. Deferred to the explorer page (Frontier M4) |
| 7 | No unnecessary data | **applies.** Stage 3 data map: every stored field names its flow; request bodies are never stored |
| 8 | Third-party SDK audit | **applies.** Celo facilitator, AWS, Forno RPC, any telemetry (none planned) |
| 9 | No dark patterns | **applies.** CLI/SDK: no payment without an explicit `--max-amount`, no auto-retry that pays twice, "unattested" is shown, never hidden |
| 10 | No hidden fees | **applies.** Price in the 402 in USDC units; facilitator fee is borne by the gateway operator and disclosed; gas is sponsored by the facilitator (disclosed in the submission per the rules) |
| 11 | No fake reviews/testimonials | **applies.** No partner logos or "used by" without written permission (Cencori, buy) |
| 12 | No unsupported claims | **applies.** Claims table in SPEC: every claim is a spec, a measurement with a tx hash, or labelled. The "nothing on Celo does this" claim ships with the search method |
| 13–15 | Alt text, contrast, keyboard | applies only to the docs/README page: alt text on diagrams. Contrast/keyboard deferred to the explorer page |
| 16 | Business details | **applies (light).** Builder name + contact in README and ToS (individual, Lagos) |
| 17 | Age consent | does not apply, because it's developer/agent infrastructure with no personal data from users. ToS states 18+ |
| 18 | Unsubscribe | does not apply (no email) |
| 19 | Licensed assets | **applies.** Dependency license register (MIT nitro-validator, Apache/MIT crates); no GPL linked into the enclave without a decision |
| 20 | Data deletion | **applies** to off-chain gateway logs: request by payer address, logs purged; on-chain data (registrations, settlements) explicitly excluded, and the policy says so |

**The three that change the design:**

- **Personal data:** wallet addresses + hashes + IPs, so the stage 3 retention rules matter.
- **Minors:** no.
- **Money moves:** yes, so the refund/no-charge semantics in item 3 are a flow, not a footer.
