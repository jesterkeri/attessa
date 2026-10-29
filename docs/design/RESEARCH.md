# Research facts (checked 2026-10-19)

Every number the design relies on, with its source. Anything marked **[unverified]** must be checked before it is quoted publicly or relied on in code.

## Chain (Celo)

| Fact | Value | Source | Confidence |
|---|---|---|---|
| Chain IDs | mainnet 42220 (`https://forno.celo.org`), Celo Sepolia 11142220 (`https://forno.celo-sepolia.celo-testnet.org`) | live `eth_chainId` | high |
| L2 status | OP Stack L2 since Mar 2025; Jovian live (Sepolia 2026-03-17, mainnet 2026-03-31) | docs.celo.org/operate/specification/upgrades/jovian.md | high |
| Block gas limit | 30,000,000 on both chains, 1 s blocks | live RPC | high |
| Per-tx gas cap (EIP-7825, 16,777,216) | **not active yet**; arrives with Karst, planned Q4 2026, date TBD. Design every tx to fit under 16.7M anyway | forum.celo.org H2 2026 roadmap; gov.optimism.io Upgrade 19b | medium |
| P-256 precompile (RIP-7212 at 0x100) | present, 3450 gas (doubles at Karst). Nitro uses P-384, so this doesn't help | live RPC | high |
| Gas price | mainnet ~200 gwei base; 40M gas ≈ 8.1 CELO ≈ $0.66 at $0.082/CELO | live RPC, CoinGecko | medium (moves daily) |
| Faucets | CELO: faucet.celo.org/celo-sepolia; test USDC: faucet.circle.com (Celo Sepolia) | faucet pages | high |

## x402 and the Celo facilitator

| Fact | Value | Source | Confidence |
|---|---|---|---|
| Spec versions | v1 and v2 (v2 dated 2025-12-09) both live | github.com/coinbase/x402 specs | high |
| Resource-server order | v2 §6.1 `authorization` flow: verify → resource → settle → respond is the default for `exact` | x402-specification-v2.md | high |
| Facilitator API | `POST /verify` → `{isValid, invalidReason?, payer}` (no state change); `POST /settle` → `{success, errorReason?, payer, transaction, network}`; `settlement_pending` is non-terminal and carries the tx hash | x402 v2 spec §7 | high |
| Celo facilitator | Celo Core Co., built on x402-rs. Mainnet API `https://api.x402.celo.org`, Sepolia `https://api.x402.sepolia.celo.org`. `/settle` needs `X-API-Key` (401 none, 402 out of credits, 429 rate limit) | live `/supported`, docs.celo.org x402 | high |
| Facilitator networks | v2 `eip155:42220`, `eip155:11142220`; v1 `celo`, `celo-sepolia` | live `/supported` | high |
| Facilitator settle signer | `0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48` | live config | high |
| Fees | gas at cost + 0.3%; free credits: live config says 20 mainnet / 1000 testnet, docs say 1 per network | live `/api/config` vs docs | high (live) / conflicting |
| Tokens | mainnet EIP-3009: USDC `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` (name USDC, version 2), USDT `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`, USAT `0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771` (EIP-712 domain via `eip712Domain()`: name "Tether America USD", version "1", chainId 42220; `version()` and `VERSION()` revert; decimals 6; has `authorizationState` and `cancelAuthorization`; checked 2026-10-19 by design review r1); Sepolia: USDC `0x01C5C0122039549AD1493B8220cABEdD739BC44E` only | live `/supported`, Circle docs, RPC | high |
| Duplicate settle | token reverts "FiatTokenV2: authorization is used or canceled" | circlefin/stablecoin-evm EIP3009.sol | high |
| Settle-timeout recovery | `authorizationState(from, nonce)` (true if used OR cancelled) + confirm via `AuthorizationUsed` event | Circle EIP3009 | high |
| Idempotency key | `payment-identifier` extension: advertised on Sepolia, **not** on mainnet | x402 extensions spec, live `/supported` | medium |
| Celo docs gotcha | `price: "$0.01"` shorthand throws on Celo; use an explicit `{amount, asset, extra}` | docs.celo.org | high |

## r5 verification update

| Fact | Value | Source | Confidence |
|---|---|---|---|
| Sepolia production payment path | On 2026-10-19 the hosted facilitator listed USDC for x402 v2 `eip155:11142220`, while legacy v1 `celo-sepolia` had no assets. The r5 design therefore uses x402 v2 on both networks. | live `GET /supported` at `https://api.x402.sepolia.celo.org/supported` | high |
| Mainnet production payment path | On 2026-10-19 the hosted facilitator listed EIP-3009 USDC and USAT for both v1 and v2; r5 selects v2 `eip155:42220` for a common protocol. | live `GET /supported` at `https://api.x402.celo.org/supported` | high |

## buy (usebuy.ai, `@celo/buy`)

| Fact | Value | Source | Confidence |
|---|---|---|---|
| Latest | 0.8.3 (2026-10-13), version bump only over 0.8.2 | npm diff | high |
| buy compatibility boundary | buy's own legacy gateway uses v1; its client behavior is a separate S5 compatibility check. It is not the r5 gateway protocol or a requirement for the direct SDK path. | `@celo/buy-gateway`, `@celo/buy-core` source | high |
| Settlement order | gateway settles **before** calling upstream ("pay, then serve"); upstream failures still cost the payer | gateway README | high |
| `onComplete` hook | present: `{transaction, status, delivered, reason, payer, payTo, asset, amount, endpoint, correlationId}`; typings name ERC-8004 reputation feedback as intended use | package source | high |
| Trust features | no `supportedTrust`, no TEE/output attestation in 0.8.3. "Attestation" in buy = Self KYC (`extra.selfRequirements`, `X-SELF-ATTESTATION`) | package source | high |
| Payment binding | EIP-3009 doesn't sign the resource, so a payment isn't bound to its endpoint (buy README says so) | README | high |
| Who submits settlement | buy's sponsor wallet; the buyer agent's wallet appears as the EIP-3009 `from` | buy-skill README | high |
| Paying programmatically | `buy curl --max-amount` / `buy quote`; MCP tools; `@celo/buy-core` `payingFetch` (undocumented, unstable) | package source | high |
| Possible bug | buy-core v2 maps `eip155:44787` (Alfajores) to `celo-sepolia`, so it may refuse v2 offers on `eip155:11142220` | buy-core v2.js | medium |
| Listing | curated: `list-your-service.yml` issue form on celo-org/buy-skill (origin, price, networks, tokens); listings ship as `PAY.md` in `@celo/buy-registry`. Whether a listed seller keeps its own payTo or is resold through buy's single payTo is **[unverified]** | docs.celo.org x402-get-discovered | medium |
| Agent402 "verified" | a live unpaid probe returned a genuine payment challenge; no output/TEE check | agent402.tools/mpp-marketplace | medium |

## AWS Nitro and the on-chain verifier

| Fact | Value | Source | Confidence |
|---|---|---|---|
| base/nitro-validator | MIT; HEAD `0ea0d12` (2026-08-05); CHANGELOG 2.0.0-rc.1; **no git tags, pin a commit** | repo | high |
| Audit | Cantina Managed, 2026-08-03, commit `05294ec0`: 1 Medium, 10 Low (incl. "debug-mode PCRs not checked against zero"), 9 Info; later commits look like fixes | `audits/` | high |
| Entry points | `CertManager.verifyCACertWithHints`, `verifyClientCertWithHints` → `VerifiedCert{ca, notAfter, maxPathLen, subjectHash, pubKey}`; `NitroValidator.decodeAttestationTbs`, `validateAttestationWithHints(tbs, sig, hints) returns (Ptrs)`. Non-hinted versions always revert | src/ | high |
| `Ptrs` | `{moduleID, timestamp(ms), digest, pcrs[32], cert, cabundle[], publicKey, userData, nonce}` as CBOR element pointers | src/ | high |
| Validator checks | sizes (user_data ≤512, nonce ≤512, public_key 1–1024), cert validity vs `block.timestamp` on cold and cached use | CertManager.sol | high |
| Validator does NOT check | attestation timestamp freshness, nonce, low-S, all-zero (debug) PCRs. **The consumer must** | README/NatSpec | high |
| Gas (Base Sepolia) | cold 5 txs ≈ 6.8M + 7.05M + 6.8M + 6.8M + 13,775,541 ≈ 41.3M; warm (chain cached) 1 tx ≈ 13.78M; ~27 KB hint calldata per tx | docs/hinted-p384-nitro-attestation.md | high (Base) / test on Celo |
| Reference consumer | base/op-enclave `SystemConfigGlobal.registerSigner()`: PCR0 allowlist, `timestamp/1000 + 60 min > block.timestamp`, signer = address(keccak(public_key[1:])) | repo | high |
| Cert lifetimes (one sample, 2026-01-03 us-east-1) | leaf 3 h, instance CA 24 h, zonal ~5.75 d, regional 20 d, root to 2049-10-28 | decoded fixture | medium |
| PCRs | 0 image, 1 kernel+bootstrap, 2 application, 3 parent IAM role, 4 instance ID, 8 EIF signing cert; debug mode = all zeros | AWS docs | high |
| Enclave networking | none; vsock to the parent only; inbound via parent TCP→vsock forwarder, TLS can terminate inside | AWS docs (+ common practice) | medium |
| NSM | `/dev/nsm`, `aws-nitro-enclaves-nsm-api` crate v0.5.2, `Request::Attestation{user_data, nonce, public_key}` | AWS repo | high |
| Reproducible EIF | kaniko `--reproducible` + `SOURCE_DATE_EPOCH` + `nitro-cli build-enclave` (+ `sign-eif` for PCR8); or Nix monzo/aws-nitro-util | AWS blog Aug 2025 | medium |
| KMS sealing (later) | condition keys `kms:RecipientAttestation:ImageSha384` / `PCR<n>` | KMS dev guide | high |
| Instance | `c6g.xlarge` (4 vCPU, 8 GiB, arm64) supported; ~$0.136/hr us-east-1 [third-party price, confirm] | AWS docs, Holori | high / medium |
| Fallback verifier | Automata ZK (RISC0/SP1) ~220–258k gas per verify, needs a prover, **not on Celo** | automata repo | high |

## Identity, attribution, hackathon, grant

| Fact | Value | Source | Confidence |
|---|---|---|---|
| ERC-8004 | Draft; ERC-721 identity (`register(agentURI[, metadata])`), `agentWallet` reserved key (EIP-712 to change, cleared on transfer); registration JSON `services[]`, `x402Support`, `supportedTrust[]` incl. `"tee-attestation"` | eips.ethereum.org/EIPS/eip-8004 | high |
| 8004 on Celo | mainnet Identity `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, Reputation `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`; Sepolia Identity `0x8004A818BFB912233c491871b3d84c89A494BD9e`, Reputation `0x8004B663056A597Dffe9eCcC1965A193B7388713`. Read agentId from the `Registered` event | docs.celo.org 8004 | high |
| 8004 Validation Registry | spec under TEE revision; **not deployed** in the reference repo | erc-8004-contracts | high |
| Self Agent ID | separate ERC-8004-style deployment + ZK proof-of-human; soulbound NFT; mainnet SelfAgentRegistry `0xaC3DF9ABf80d0F5c020C06B04Cced27763355944`; Sepolia `0x043DaCac8b0771DD5b444bCC88f2f8BBDBEdd379`; checks `isVerifiedAgent(bytes32 agentKey)`, `hasHumanProof(agentId)`, `isProofFresh(agentId)`. Full ABI **[unverified]** | docs.self.xyz agent-id | medium |
| ERC-8021 | schema 0 suffix `[codes][len][0x00][0x8021 × 8]`; `@celo/attribution-tags` (`withAttribution`, `toDataSuffix`); x402 settlements not tagged yet, give the **PayTo address** | celo-org/attribution-tags | high |
| Hackathon | Nov 9 2026 09:00 GMT; mainnet only; ERC-8004 from agent wallet; public repo; code written during hackathon; Build with buy: no tag needed, list services + proof of payment; scoring query **not yet published** | loops.house | high / medium |
| Frontier S3 | to Dec 29 2026; cap $15k (forum) vs "$25k+" (site): confirm; 20/80, 4 months, KYC, KarmaGAP, Self Agent ID, ERC-8004 | forum.celo.org, prezenti.xyz | medium |
| TEE verification on Celo | none found (Automata not deployed; no 8004 Validation Registry). Not exhaustive | Automata DEPLOYMENT.md | medium |

## r2 additions (design review r1, live reads 2026-10-19)

| Topic | Finding | Source | Confidence |
|---|---|---|---|
| ERC-8004 Identity Registry (mainnet `0x8004A169…a432`) | ERC-1967 proxy, `IdentityRegistryUpgradeable` with `_authorizeUpgrade onlyOwner`; `owner()` = EOA `0x547289319c3e6aedb179c0b8e8af0b5acd062603` | Forno storage-slot read + erc-8004-contracts source | high |
| Self Agent Registry (mainnet `0xaC3DF9AB…5944`) | ERC-1967 proxy; registration modes `linked`, `wallet-free`, `privy`, `smartwallet` hold the NFT in different wallets | Forno + docs.celo.org Self Agent ID page | high (proxy), medium (modes) |
| base/nitro-validator Ptrs | `validateAttestationWithHints` returns offsets into `attestationTbs`, not into the COSE `attestation`; `decodeAttestationTbs` skips the unprotected header | repo source (main, README says HEAD 0ea0d12) | high |
| Celo gas price | 202.5 gwei | Forno `eth_gasPrice` | high (point in time) |

