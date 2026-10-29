# THREAT MODEL, FAILURE MODES, OPERATIONS (r5)

Joshua, this covers system design phases 9, 10 and 12. Diagram and trust boundaries are in ARCHITECTURE.md §3.

## 1. Four questions

1. **What are we working on?** A registry of enclave keys bound to approved builds, a gateway that settles only after a proof verifies, and a buyer SDK that re-checks everything.
2. **What can go wrong?** The tables below.
3. **What are we doing about it?** The "mitigated by" columns and INVARIANTS.md.
4. **Good enough?** Stage 4 adversarial review (Opus), per-gate Codex review, and the invariant suite.

## 2. Actors, roles and privileges (including us)

| Actor | Key | Can do | Can't do | Blast radius if the key is stolen | Rotation |
|---|---|---|---|---|---|
| Agent owner | ERC-8004 NFT holder (hardware wallet recommended) | approve/deprecate/revoke releases, add/retire endpoints, revoke signers, link Self | register signers (operator only), move buyer funds | Can approve a malicious build and add endpoints with their own payTo/operator. Buyers calling the real origin still see the real payTo in the 402, so a payTo mismatch stops them. The attacker can DoS by revoking | Transfer the NFT to a new wallet (ERC-721); re-link Self |
| Endpoint operator | EOA on the EC2 host (`OPERATOR_PRIVATE_KEY`, 0600) | register signers for its endpoint | approve releases; register a key that isn't from a genuine enclave running an approved build | Can register another genuine enclave of the approved build bound to this origin (one they run themselves). It can't reach buyers unless it also serves the origin's TLS | Owner retires and re-adds the endpoint with a new operator; every signer registered by the old operator stops verifying (`OPERATOR_MISMATCH`, INV-8) |
| Agent wallet (buyer for inputs) | EOA on seller-host (`AGENT_PRIVATE_KEY`) | pay buy services | anything in the registry once T31 has transferred the agent NFT to the cold owner | Spends its USDC balance (keep ≤ 5 USDC). If the rules forbid the transfer, it **is** the owner and must not live on EC2 (OPEN-QUESTIONS) | New wallet; update buy config; `setAgentWallet` |
| Gateway operator | none (holds no private key) + `FACILITATOR_API_KEY` | ask the facilitator to settle authorizations it was given | redirect funds (EIP-3009 fixes to/value) | The API key lets someone spend our facilitator credits and settle authorizations they possess | Regenerate at x402.celo.org |
| CertManager owner/revoker (admin) | cold EOA | revoke/unrevoke AWS certs in the cache, transfer ownership | forge attestations or change the root | DoS on new signer registrations (revoke certs); existing signers unaffected | `transferOwnership` / `setRevoker` |
| Deployer | throwaway EOA | deploy immutable contracts | anything after deploy (CertManager ownership goes to admin at deploy) | none after deploy | n/a |
| Buyer | EOA (OS keychain) | sign authorizations within limits, cancel | n/a | Spends up to `dailyCap` per day until noticed | `attessa init` new wallet |
| Celo facilitator | its settle signer | submit settlements | change amount or recipient | n/a | n/a |
| AWS | root CA | issue attestations | n/a | Total (accepted) | n/a |
| ERC-8004 Identity Registry upgrade key | EOA `0x547289319c3e6aedb179c0b8e8af0b5acd062603` (not ours) | upgrade the proxy, so rewrite `ownerOf` | n/a | Can act as owner of any agent: approve builds, change endpoints (L19) | not ours |
| Self registry upgrade key | not ours | upgrade the proxy | block registrations (no `requireSelf`, ADR-014) | Fake the "Self-verified owner" badge (L19) | not ours |

**Admin and debug surfaces (enumerated; anything not listed doesn't exist):**
- No admin functions in EnclaveRegistry.
- Gateway: no admin HTTP routes. `paused` is set automatically on facilitator 401/402 (not 429, which backs off) or by `attessa gateway pause`, and cleared by `attessa gateway resume` on the host (local CLI, file-system access), which first checks the API key works.
- Enclave: debug mode is a launch flag and produces all-zero PCRs, which the registry refuses.
- Seller-host: listens on 127.0.0.1 only.
- No GraphQL, no API docs endpoint, no seed/reset routes, no profiler.

## 3. STRIDE per trust boundary

| Boundary | Threat | Mitigated by / accepted because |
|---|---|---|
| TB1 buyer↔gateway | **S**poofing: a fake seller copies attestation metadata into its 402 | The SDK resolves the registry by the origin it called; payTo must equal the registered payTo (V4) before signing; liveness signed by an Active signer bound to that origin (V7) |
| TB1 | **T**ampering: the gateway alters the request or response | requestHash and responseHash are inside the signed proof; the SDK recomputes both (V10) |
| TB1 | **R**epudiation: the gateway denies settling | Settlement tx with `AuthorizationUsed` and `Transfer` logs on chain; evidence file; "not charged" only from chain state (INV-20) |
| TB1 | **S**poofing: a squatter binds the real origin first | Buyers safe (`.well-known` agentId + payTo cross-check); seller blocked (**accepted**, L17); register the origin the day of deploy |
| TB1 | **T**ampering: buyer front-runs the nonce with a 0-value authorization to itself during `settle_pending` | Reconciler requires `Transfer(payer → payTo, amount)` from the asset in the same tx; else `settle_failed{nonce_used_elsewhere}`, result withheld |
| TB1 | **I**nformation disclosure: request bodies visible to the gateway/parent | **Accepted** (L5): MVP requests are public chain addresses, nothing secret. Encrypting to the enclave key is M3 |
| TB1 | **D**oS: spam the free liveness/quote | Per-IP limits (SPEC §6.1): liveness 30/min, unpaid evaluate 120/min, in-flight cap 16 → 503 `gateway_busy`. The body is validated before any enclave call |
| TB1 | **S**poofing: forged proof with another key's valid signature and the real signer in the header | Signer is recovered from the signature and must equal the header (SPEC §6.2 step 9, INV-9, INV-13) |
| TB4 | **T**ampering: seller-host fabricates input values on a real block | Gateway and SDK re-read code, nonce and balance at that block (`inputs_mismatch`) |
| TB1 | **E**levation: replay a valid proof for a different request | The proof binds requestId (buyer-chosen random) + requestHash + paymentId; the SDK rejects mismatches |
| TB2 gateway↔facilitator | **T**ampering with settle | EIP-3009 signature fixes from/to/value/nonce; the facilitator can't alter them |
| TB2 | **D**oS: facilitator down or out of credit | 429 → backoff; 401/402 → `paused` (503 before verify); ambiguous settles → 202 `settle_pending` and the reconciler; prepaid balance |
| TB3 gateway↔seller-host | **T**ampering by a co-located process | Covered by the proof: any change breaks verification and the gateway won't settle |
| TB4 parent↔enclave | **S**poofing: the parent pretends to be the enclave | It can't sign as the signer; the key is enclave-only (INV-15) |
| TB4 | **T**ampering with inputs | Inputs are in the signed response; gateway and SDK check the block hash and age ≤ 300 s; re-readable by anyone at that block. Choice of block inside 300 s **accepted** (L22) |
| TB4 | **D**oS / reorder / withhold | **Accepted** (L4): attestation proves provenance, not availability |
| TB4 | **E**levation: a wrong `configure` (agentId, origin, chain) | Bound into `user_data`; the registry refuses a mismatch (`BindingMismatch`) |
| TB5 registry reads | **S**poofing via a malicious RPC returning fake state | The SDK uses the configured RPC; default Forno; `--rpc` is the user's choice. **Accepted**: same trust as any dapp |
| TB6 seller-host↔buy | **T**ampering: buy returns false reads | Inputs committed and auditable at block N |
| TB7 chain writes | **S**poofing: a non-owner/non-operator | `ownerOf` / `msg.sender == operator` checks (INV-5) |
| TB7 | **T**ampering: register a genuine attestation for another agent or chain | `user_data` binding (agentId, chainId, registry, originHash) |
| TB7 | **R**eplay of an old attestation | 30-minute window from the NSM-signed timestamp; replay of a fresh one only re-registers the same key → `SignerExists` |
| TB7 | **T**ampering: padded COSE unprotected header shifts offsets | Fields read only from `tbs` via `Ptrs` (SPEC §3.4 step 2, INV-1, T07b) |
| TB7 | **E**levation: upstream registry upgrade rewrites `ownerOf` | **Accepted** (L19), disclosed in the README |
| TB7 | **E**levation: a debug enclave | All-zero PCRs refused (`DebugPcrs`) |
| TB7 | Key substitution (address submitted separately) | No such parameter exists: the signer is derived from the attestation's `public_key` only |

## 4. Smart contract checklist (OWASP SC Top 10 2026 focus)

| Item | Status |
|---|---|
| Access control | `ownerOf` from an external ERC-721 read at call time; operator check; no admin. Read-only reentrancy via `ownerOf`: the identity registry is the reference deployment, a view call, state is written after all reads |
| Business logic | Release/endpoint/signer state machines with explicit transition tables (SPEC §3.4); `checkSigner` reference model in invariant tests |
| Input validation | PCR length 48 and non-zero; origin prefix/length; user_data exactly 160 bytes; public_key 65 bytes with prefix 0x04 |
| External calls | NitroValidator (pinned, audited), IdentityRegistry, Self registry: view calls plus a validator call that only reverts or returns. `ownerOf` and Self calls wrapped in try/catch → custom errors |
| Arithmetic | Timestamp ms→s division (floor); `now − ts` computed only after `ts ≤ now + 60` to avoid underflow when ts is slightly in the future: use `ts > now ? 0 : now − ts` |
| Upgradeability | EnclaveRegistry: none (immutable). Upstream ERC-8004 and Self registries are upgradeable proxies (L19) |
| Gas griefing / unbounded loops | No loops over user-controlled arrays; validator gas bounded by its own size checks |
| Signature malleability | `verifyProof` enforces low-s and v ∈ {27,28} (OpenZeppelin ECDSA) |
| Static analysis | Slither in CI, required |

## 5. Failure modes (severity first)

| Component | Failure | Effect | Cause | Control | Detection | Severity |
|---|---|---|---|---|---|---|
| Gateway | Settles after a failed proof check | Buyer charged for bad output | Bug in step ordering | INV-9 tests; state persisted before settle; SDK re-verifies → `paid_but_rejected` | SDK evidence + gateway log `settle_called` without `proof_ok` | **Critical** |
| Registry | Accepts a signer outside the rules | Forged trust | Bug in §3.4 | INV-1…4 fuzz; Opus + Codex reviews; immutable, so fix = new registry + SDK pin | Off-chain monitor re-checks every `SignerRegistered` attestation | **Critical** |
| Enclave | Key exfiltration (enclave bug) | Attacker signs proofs | Memory-safety bug, debug build | Rust, no debug, 7-day TTL, owner can revoke | Proofs signed while the enclave was off (monitor liveness vs proof timestamps) | **Critical** |
| Gateway | Settle times out or errors after broadcast | Buyer unsure if charged | Facilitator/network | 202 `settle_pending`; reconciler via logs (AuthorizationUsed + Transfer) and `authorizationState` at a block past validBefore + 5; result served from `/v1/results` | `settle_pending` age > 60 s alert | High |
| Gateway | Delivery fails after settle | Paid, no answer yet | Client drop | 24 h `/v1/results` + SDK pending ledger | `delivery_failed` count | High |
| Facilitator | Out of credits / 429 | No sales | Usage | `gateway_paused`, not charged | 503 rate; credit balance check at startup | Medium |
| Enclave | Restarted (new key) | Calls fail until re-registered | Host reboot, deploy | Runbook: start + register (about 4–6 CELO) | Liveness fails; `checkSigner` not OK at gateway | Medium |
| Registry | Signer expires mid-judging | All paid calls fail `enclave_unavailable` | 7-day TTL from Nov 2 | `renewSigner` Nov 8 (T36), drilled on Sepolia (T24) | `health.sh`: `expiresAt − now < 24 h` | High |
| Seller-host | Input-read drain: valid authorizations that never settle make us pay buy for reads | Agent wallet emptied; inputs fall back to Forno | A buyer cancels or empties funds after `/verify` | Per-payer limit (5 unsettled paid calls per hour); buy-spend guard switches to Forno | `health.sh` buy spend > revenue + 1 USDC | Low |
| Gateway | Crash with rows in `payment_verified`/`executing` | Stuck rows | Process crash | Startup sweep → `exec_failed`, never settle | Startup log count | Medium |
| Seller-host | buy input read fails | Can't evaluate | buy down | Fallback to Forno with `source:"forno"` | Fallback counter | Low |
| Chain | Reorg/RPC divergence | Stale endpoint/signer state | RPC | Celo L2 1 s blocks; reads at latest; revocation takes effect within 60 s cache | n/a | Low |
| Clock skew | Enclave or buyer clock off | Liveness/proof expiry misjudged | Host time | ±120 s tolerance; proof TTL 600 s | Liveness failures with skew reason | Low |
| Duplicate delivery | Buyer retries | Double pay | Retry logic | Pending ledger + requestId idempotency + nonce uniqueness | `payment_reused` 409 count | Low (prevented) |

**Kill switches:**

| Switch | Who | Effect | Doesn't stop |
|---|---|---|---|
| Revoke release | owner, one tx | All its signers stop verifying; gateways refuse within 60 s | Authorizations already signed (≤ 120 s) |
| `attessa gateway pause` | gateway operator | 503 `gateway_paused` before verify: no new quotes, no execution, no new settles. Reconciler keeps resolving open rows from chain state | Same |
| Stop the enclave | operator | No new proofs | n/a |

## 6. Risk register

| ID | Risk | Likelihood | Impact | Mitigation | Owner | Status |
|---|---|---|---|---|---|---|
| RISK-1 | Nitro validator doesn't work on Celo (gas/precompiles) | Low (Celo is OP-stack; 30M blocks) | Fatal | Gate 1 kill test; fallback Automata ZK (not on Celo, needs prover) | Joshua | Open (G1 running) |
| RISK-2 | EIF not reproducible → provenance claim unbacked | Medium | High (credibility) | Copy is "owner says it's built from …" by default; S3 by Oct 26; `attessa release verify` optional (L20) | Joshua | Open |
| RISK-3 | Self ABI differs / not on Sepolia | Medium | Low (link is informational, ADR-014) | Spike S4; disable linking on that network if selectors revert | Joshua | Open |
| RISK-4 | buy client can't pay our v2 Sepolia gateway | Medium | Low (our CLI pays directly) | Spike S5 against the canonical v2 quote; report a confirmed incompatibility to buy | Joshua | Open |
| RISK-5 | Not enough independent users by Nov 8 | High | High (scoring qualifier) | Outreach from Nov 2 with a working demo; USA₮ faucet path; Cencori intro via Defi Messiah | Joshua | Open |
| RISK-6 | Scoring query rewards only calls into others' services; our gateway calls score nothing | High | Medium | Seller-host input reads via buy (real paid calls into a service we don't control) | Joshua | Mitigated by design |
| RISK-7 | Gateway operator = seller in the demo, so Mode B doesn't protect against a malicious seller | Certain | Medium (narrative) | Say so; frame the gateway as the marketplace step buy would run; SDK independent checks | Joshua | Accepted (L1) |
| RISK-8 | AWS credits run out / account not approved for enclaves | Low | High | Apply early (by Oct 21); 324 h × $0.136 ≈ $44; billing alarm $50 | Joshua | Open |
| RISK-10 | Demo origin squatted on the immutable registry | Low | High (demo) | Add the endpoint the day of deploy, before announcing (L17) | Joshua | Open |
| RISK-11 | Plan doesn't fit one developer by Nov 2 | Medium | High | G3+4 merged review; `--via buy` and `release verify` optional; S3 decision Oct 26; Sepolia broadcast by builder (OPEN-QUESTIONS) | Joshua | Open |
| RISK-9 | USA₮ EIP-712 domain unknown / facilitator issues | Low | Medium (second track) | Spike S6 on mainnet with 0.01 | Joshua | Open |

## 7. Operations

**Logs (where, retention):**

| Log | Where | Retention | Contents |
|---|---|---|---|
| Gateway access | stdout → journald on EC2 | 30 days | route, status, latency, correlationId, requestId. **No IP persisted, no bodies** |
| Gateway audit | `calls` table | until 2026-12-31 | state transitions |
| Seller-host | journald | 30 days | input source, fallback events, enclave errors |
| Enclave | console only in debug, which is never used in prod | none in production | n/a |
| Chain | events | permanent | release/endpoint/signer changes |

**Never logged:** private keys, the API key, request bodies, PAYMENT-SIGNATURE values.

**SLIs** (gateway, from `calls`): `delivered + not_charged` / valid paid calls (SLO-1); liveness answered within 2 s (SLO-2).

**Alerts** (solo: email via a free uptime monitor + a cron script `scripts/health.sh` on the host every 5 min):

| Alert | Runbook |
|---|---|
| `/healthz` down 2 checks in a row | `systemctl status 'attessa-gw@*' 'attessa-seller@*' 'attessa-vsock@*'`; restart the failed unit; if an enclave restarted → `attessa enclave start --network <n>` + `attessa signer register` |
| Liveness failing | Same as above; check `nitro-cli describe-enclaves` |
| `settle_pending` older than 60 s | Check the facilitator `/health`; the reconciler resolves; if `authorizationState` is false at a block past validBefore + 5, the row moves to `settle_failed{expired}` automatically |
| Signer expires in < 72 h | `attessa signer renew --network <n>` (same key, no restart, about 5–7 CELO). Never let it lapse: renewing is only possible before expiry. An already expired signer can't be renewed: restart the enclave and `attessa signer register` |
| Attestation too old at registration | `attessa signer register --fresh` (fetches a new attestation for the same key; never restart for this) |
| `paused=true` | Top up the facilitator balance or fix the API key at x402.celo.org, then `attessa gateway resume` |
| Operator key suspected stolen | Owner: `attessa endpoint retire` then `attessa endpoint add` with a new operator; old signers stop at once (`OPERATOR_MISMATCH`); register a new signer |

**Severity:**

| Level | Meaning |
|---|---|
| SEV-1 | Charged without a verified result |
| SEV-2 | Paid calls failing > 10 min |
| SEV-3 | Liveness failing but no paid traffic; or loss of redundancy (Forno fallback active) |
| SEV-4 | Docs/copy defects |
| SEV-5 | Cosmetic |

**Postmortem:** any SEV-1, blameless, in `docs/postmortems/`.

**Cost watch:** AWS 324 h ≈ $44 (alarm $50); registrations ~15 × 4–6 CELO.

**Game day before submission:** run the pause drill (facilitator key removed → `gateway_paused`), the enclave-restart drill (timed), and the crash-during-settle drill (kill the gateway between persist and settle response → the reconciler resolves).
