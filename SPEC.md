# SPEC: attested execution provenance for x402 sellers on Celo

**Authoritative build spec, r5.** r2 answered design review r1, r3 answered r2, r4 answered r3, and r5 answers `reviews/design-review-r4-codex.md`. Where FLOWS.md and this file disagree, this file wins.

**Builder rules:**

1. Start every status message to Joshua with "Joshua," so a hallucinated report is easy to spot.
2. Never edit this file, `FLOWS.md`, `INVARIANTS.md`, `ARCHITECTURE.md`, `GLOSSARY.md`, `THREAT-MODEL.md`, `KNOWN-LIMITS.md` or `adr/`. If the design is wrong, stop and write the problem in `OPEN-QUESTIONS.md`.
3. User-facing copy comes verbatim from `FLOWS.md` §6 and §8.
4. Facts and prices come from `RESEARCH.md` (checked 2026-10-19). Re-check anything marked [unverified] before relying on it.

---

## 1. Requirements

### Functional

| ID | Requirement |
|---|---|
| FR-1 | An agent owner (ERC-721 `ownerOf(agentId)` on the configured ERC-8004 Identity Registry) can approve, deprecate, re-approve and revoke releases, where a release is the triple (PCR0, PCR1, PCR2) |
| FR-2 | An owner can add an endpoint `{origin, payTo, operator}` for their agent and retire it. An origin is bound to at most one agent while Active |
| FR-3 | An endpoint's operator can register a signer by submitting a Nitro attestation. The registry verifies it through NitroValidator and enforces every rule in §3.4 |
| FR-4 | An owner can revoke any signer of their agent. Signers expire 7 days after registration or renewal, and stop verifying if their endpoint's operator changes. The endpoint's operator can renew an Active signer with a fresh attestation from the same enclave key |
| FR-5 | An owner can record a Self Agent ID link. It's shown to buyers. Enforcement (`requireSelf`) is off on both networks in the MVP (ADR-014) |
| FR-6 | Anyone can call `checkSigner` and `verifyProof` and get a precise status code |
| FR-7 | The enclave generates a secp256k1 key at boot, never exports it, produces attestations binding that key and its context, and signs liveness and execution proofs |
| FR-8 | The gateway serves x402 v2 `exact` EIP-3009 quotes in USDC (both networks) and USA₮ (mainnet). It verifies payment with the facilitator, runs the request through the enclave, verifies the proof and the inputs' block, and only then settles |
| FR-9 | The gateway never settles after a failed check, settles each payment at most once, drives every row to a terminal state, serves results for 24 h, and exports a settlement log |
| FR-10 | The SDK/CLI resolves endpoints from the registry, cross-checks the origin's `.well-known` agentId, enforces reserved spending limits, refuses on a payTo mismatch, checks liveness, re-verifies proofs and inputs' block independently, keeps a pending ledger, confirms "not charged" only from chain state after expiry, can cancel, and writes evidence |
| FR-11 | Seller-host buys its chain reads through a buy RPC capability from the agent wallet (the scoring path). The CLI wrapper `attessa call --via buy` is optional (post-Nov 2) |
| FR-12 | The seller workload (payment check) returns a deterministic verdict that includes the chain inputs it used, read at a recent block. The gateway and the SDK re-read those values at that block |
| FR-13 | One host serves two sellers during judging: mainnet (default for real payments) and Sepolia (default for new users and the tutorial), each with its own enclave, gateway, origin and signer (§5) |

### Quality (ISO 25010 terms, in priority order)

| ID | Attribute | Target |
|---|---|---|
| NFR-1 | Security / integrity | Zero settlements without a verified proof (INV-9). Zero signers registered outside §3.4 rules |
| NFR-2 | Functional correctness | 100% of `vectors/` pass in TS, Solidity and Rust |
| NFR-3 | Reliability | Judging window (Nov 9–13): ≥ 99% of valid-authorization paid calls end in `delivered` or confirmed `not_charged` |
| NFR-4 | Performance | p95 `attessa call` to verified result ≤ 6 s on mainnet, ASSUMPTION (buy reads ~1–2 s + settle ~2 s). Refusals confirm "not charged" after the 120 s window by default |
| NFR-5 | Learnability | First verified paid call on Sepolia ≤ 10 minutes from install, 1 signature |
| NFR-6 | Maintainability | Contracts immutable; one registry address per chain in `packages/core/src/deployments.ts` |

### SLOs (from Nov 9)

- **SLO-1:** valid-authorization paid calls ending in `delivered` or confirmed `not_charged`, over all valid-authorization paid calls, ≥ 99% over 5 days.
- **SLO-2:** liveness answered with a valid signature within 2 s, over all liveness requests, ≥ 95% over 5 days.

### Trust and adversary assumptions

| Party | Trusted for | If hostile |
|---|---|---|
| AWS Nitro (NSM, root CA) | genuine attestations, isolation | the property fails (accepted) |
| AWS CRL process | revoking compromised intermediates | we don't monitor CRLs in the MVP (L18) |
| Enclave app (approved release) | computing and signing per its code | bugs in it are bugs in the product |
| Parent / seller-host / operator | nothing | can withhold, delay, reorder, deny; can't forge proofs; inputs are returned, and their block and values are re-read by gateway and SDK |
| Gateway operator | settling only after verification | can settle without delivering → short window, cancel, chain-confirmed evidence (ADR-006) |
| Celo x402 facilitator | executing settle | can refuse, delay, or error after broadcasting (handled as pending); can't redirect funds |
| Agent owner key | approving releases and endpoints | can approve any build and claim any `sourceRef` → buyer copy says "owner says" (C2 fix) |
| **ERC-8004 Identity Registry upgrade key** (EOA `0x547289319c3e6aedb179c0b8e8af0b5acd062603`, ERC-1967 proxy) | not changing `ownerOf` | can rewrite who owns any agent, so can approve builds and change endpoints for any agent (L19) |
| **Self Agent Registry upgrade key** (ERC-1967 proxy) | link display only (`requireSelf=false`) | can falsify the Self link shown to buyers |
| CertManager owner/revoker (our admin key) | nothing for safety | DoS on new registrations |
| Deployer key | deploying | no residual power after deploy |
| Celo sequencer | ordering, liveness | can delay or censor; can't forge |
| buy | delivering paid chain reads | can return wrong reads; values are visible in the response and re-checkable |

---

## 2. Formats (shared by contracts, enclave, SDK, gateway)

JSON byte strings are lowercase `0x…` hex. Numbers that can exceed 2^53 are decimal strings. base64 is RFC 4648 standard alphabet with padding. Every rule here has vectors in `vectors/` (T03).

### 2.1 Origin normalisation and `originHash`

`normalizeOrigin(input)`:
1. Parse with the WHATWG URL Standard. Scheme must be `https`. `http://localhost:<port>` is allowed only on `--network local`.
2. Host: UTS-46 non-transitional processing to ASCII (punycode), lowercase. Reject a trailing dot, IPv4/IPv6 literals (except local), userinfo.
3. Drop port 443. Keep other ports.
4. Drop path, query, fragment.
5. Result: `https://host[:port]`, 9–267 bytes.

`originHash = keccak256(utf8(normalizedOrigin))`.

On chain, `addEndpoint` checks the prefix `https://` (or `http://localhost` when the deployment is local) and the length 9–267. The SDK/CLI normalise before submitting.

### 2.2 Hashes

| Value | Definition |
|---|---|
| `requestHash` | `keccak256( utf8(METHOD) ‖ 0x00 ‖ utf8(pathAndQuery) ‖ 0x00 ‖ bodyBytes )`. METHOD uppercase; pathAndQuery as sent, starting with `/` |
| `responseHash` | `keccak256(responseBodyBytes)`, the exact bytes sent. The gateway sets `Content-Encoding: identity` and Caddy doesn't compress this route |
| `inputsHash` | `keccak256(JCS(inputs))` (RFC 8785). The `inputs` object is also inside the response body (§4.3), so a buyer can recompute it |
| `releaseId` | `keccak256(pcr0 ‖ pcr1 ‖ pcr2)`, each PCR as its raw 48 bytes |
| `requestId` | 32 bytes. Buyer-chosen (CSPRNG, a fresh one for every new call, never reused after a terminal outcome) via `X-Request-Id`. If absent, the gateway derives `keccak256(asset ‖ payer ‖ nonce)` (all 32-byte left-padded) **after** identifying the asset (§6.2 step 3) and returns it in `X-Request-Id` |
| `paymentId` | the EIP-3009 authorization `nonce` (bytes32). Required in every paid proof |
| `attestationHash` | `keccak256(tbs)`, where `tbs` is the `attestationTbs` returned by `decodeAttestationTbs`. Unaffected by the unprotected header or signature malleability |

### 2.3 EIP-712

Domain: `{ name: "AttestedExecution", version: "1", chainId, verifyingContract: <EnclaveRegistry address> }`

```
ExecutionProof(uint256 agentId,bytes32 releaseId,bytes32 requestId,bytes32 requestHash,bytes32 responseHash,bytes32 inputsHash,bytes32 paymentId,uint64 issuedAt,uint64 expiresAt)
Liveness(uint256 agentId,bytes32 releaseId,bytes32 originHash,bytes32 challenge,uint64 issuedAt)
```

- Signatures are 65 bytes `r ‖ s ‖ v`, v ∈ {27, 28}. Verifiers reject high-s.
- `expiresAt = issuedAt + 600`.
- **Live verifiers reject `|issuedAt − verifierNow| > 120` s**: liveness (V7) and the gateway's pre-settle check (§6.2 step 9). A paid result the SDK verifies later is time-checked against its ledger entry and settlement block instead (§7 V10 time anchors), never against the current time.
- JSON encodings (`X-Attested-Proof`, liveness object): every field as a string. Integers in decimal, bytes as lowercase hex, addresses lowercase.

### 2.4 Attestation binding (the enclave's NSM request)

- `public_key` = the 65-byte uncompressed secp256k1 key `0x04 ‖ X ‖ Y`. signer = `address(uint160(uint256(keccak256(X ‖ Y))))`.
- `user_data` = `abi.encode(BINDING_TYPEHASH, chainId, registry, agentId, originHash)`, exactly 160 bytes. `BINDING_TYPEHASH = keccak256("AttestedExecution.SignerBinding.v1")`.
- `nonce` is empty (ADR-003).

### 2.5 HTTP headers (exact grammar)

| Header | Dir | Grammar |
|---|---|---|
| `X-Request-Id` | both | `0x[0-9a-f]{64}`. Optional from the buyer (derived if absent); echoed by the gateway whenever it is known (always on paid requests) |
| `X-Attest-Challenge` | buyer→gw | `0x[0-9a-f]{64}`. Optional; on an unpaid request the 402 then carries a liveness object |
| `PAYMENT-REQUIRED` | gw→buyer | base64 JSON x402 v2 `PaymentRequired`. Present on 402 |
| `PAYMENT-SIGNATURE` | buyer→gw | base64 JSON x402 v2 `PaymentPayload` |
| `PAYMENT-RESPONSE` | gw→buyer | base64 JSON x402 v2 settlement response. Present on 200; on 202 `settle_pending` only when a tx hash is known |
| `X-Attested-Proof` | gw→buyer | base64 of JCS `{"proof":{…strings…},"signature":"0x…","signer":"0x…"}` |
| `X-Attest-Payer-Sig` | buyer→gw | `<unixSeconds>.<0x65-byte-hex>`. The signature is EIP-191 `personal_sign` over the ASCII string `attested-exec:results:<requestId lowercase>:<unixSeconds>`. Accepted within 300 s of gateway time |
| `Retry-After` | gw→buyer | seconds, on 202/429/503 |

### 2.6 Networks and pinned assets

| SDK name | CLI flag | Chain | Assets (address → EIP-712 domain name/version) |
|---|---|---|---|
| `celo-sepolia` | `--network sepolia` (default) | 11142220 | x402 v2 network `eip155:11142220`; USDC `0x01c5c0122039549ad1493b8220cabedd739bc44e` → "USDC"/"2" |
| `celo` | `--network mainnet` | 42220 | x402 v2 network `eip155:42220`; USDC `0xceba9300f2b948710d2653dd7b07f33a8b32118c` → "USDC"/"2"; USA₮ `0xd2ab3c9a02dbbab236bfec45d1d755df4267f771` → "Tether America USD"/"1" (read via `eip712Domain()`) |
| `local` | `--network local` | whatever chain id the RPC reports (an anvil fork keeps the forked id) | the deployments entry and pins are copied from the network whose chain id the RPC reports |

The SDK uses only these pinned addresses and domains, and refuses a 402 entry whose `asset`, `network`, `amount`, `payTo`, or `extra` differs (`quote_malformed`). x402 v2 networks are the CAIP-2 identifiers above. The legacy v1 `celo` / `celo-sepolia` kinds are not a production path.

---

## 3. EnclaveRegistry (Solidity)

Immutable, with no global admin. Constructor arguments are immutable.

### 3.1 Interface

```solidity
interface IEnclaveRegistry {
  enum ReleaseStatus { None, Approved, Deprecated, Revoked }
  enum EndpointStatus { None, Active, Retired }
  enum SignerStatus { None, Active, Revoked }
  enum Check { OK, UNKNOWN_SIGNER, SIGNER_REVOKED, SIGNER_EXPIRED, RELEASE_NOT_APPROVED,
               ENDPOINT_INACTIVE, ENDPOINT_MISMATCH, AGENT_MISMATCH, OPERATOR_MISMATCH,
               BAD_SIGNATURE, PROOF_EXPIRED, PROOF_CLOCK_SKEW }

  struct Release  { ReleaseStatus status; uint64 approvedAt; uint64 statusChangedAt; }
  struct Endpoint { uint256 agentId; address payTo; address operator; EndpointStatus status; uint64 updatedAt; }
  struct Signer   { uint256 agentId; bytes32 releaseId; bytes32 originHash; address operator;
                    uint64 registeredAt; uint64 expiresAt; SignerStatus status; bytes32 attestationHash; }
  struct ExecutionProof { uint256 agentId; bytes32 releaseId; bytes32 requestId; bytes32 requestHash;
                    bytes32 responseHash; bytes32 inputsHash; bytes32 paymentId; uint64 issuedAt; uint64 expiresAt; }

  function linkSelfAgent(uint256 agentId, uint256 selfAgentId) external;                  // owner
  function approveRelease(uint256 agentId, bytes calldata pcr0, bytes calldata pcr1, bytes calldata pcr2, string calldata sourceRef) external returns (bytes32 releaseId); // owner
  function setReleaseStatus(uint256 agentId, bytes32 releaseId, ReleaseStatus to) external; // owner
  function addEndpoint(uint256 agentId, string calldata origin, address payTo, address operator) external returns (bytes32 originHash); // owner
  function retireEndpoint(bytes32 originHash) external;                                      // owner
  function revokeSigner(address signer) external;                                            // owner
  function registerSigner(uint256 agentId, bytes32 originHash, bytes calldata attestation, bytes calldata attestationSigHints) external returns (address signer); // endpoint operator
  function renewSigner(address signer, bytes calldata attestation, bytes calldata attestationSigHints) external; // endpoint operator

  function releases(uint256 agentId, bytes32 releaseId) external view returns (Release memory);
  function endpoints(bytes32 originHash) external view returns (Endpoint memory);
  function signers(address signer) external view returns (Signer memory);
  function selfLinks(uint256 agentId) external view returns (uint256);
  function checkSigner(address signer, bytes32 originHash) external view returns (Check code, Signer memory s, Endpoint memory e);
  function verifyProof(ExecutionProof calldata p, bytes calldata signature, bytes32 originHash) external view returns (Check code);
  function proofDigest(ExecutionProof calldata p) external view returns (bytes32);
  function livenessDigest(uint256 agentId, bytes32 releaseId, bytes32 originHash, bytes32 challenge, uint64 issuedAt) external view returns (bytes32);

  function identityRegistry() external view returns (address);
  function selfRegistry() external view returns (address);
  function nitroValidator() external view returns (address);
  function allowLocalOrigins() external view returns (bool);  // true only for anvil/test deployments
  function SIGNER_TTL() external pure returns (uint64);        // 604800
  function MAX_ATTESTATION_AGE() external pure returns (uint64); // 1800
  function MAX_FUTURE_SKEW() external pure returns (uint64);    // 60
  function MAX_PROOF_SKEW() external pure returns (uint64);     // 120
}
```

Constructor: `(address identityRegistry, address nitroValidator, address selfRegistry, bool allowLocalOrigins)`. `selfRegistry` may be zero (linking disabled). There's no `requireSelf` in r2 (ADR-014).

### 3.2 Storage layout

```solidity
mapping(uint256 => mapping(bytes32 => Release)) private _releases;
mapping(bytes32 => Endpoint) private _endpoints;
mapping(address => Signer) private _signers;
mapping(uint256 => uint256) private _selfLinks;
```

### 3.3 Events

```solidity
event SelfAgentLinked(uint256 indexed agentId, uint256 indexed selfAgentId, address owner);
event ReleaseApproved(uint256 indexed agentId, bytes32 indexed releaseId, bytes pcr0, bytes pcr1, bytes pcr2, string sourceRef);
event ReleaseStatusChanged(uint256 indexed agentId, bytes32 indexed releaseId, ReleaseStatus from, ReleaseStatus to);
event EndpointAdded(bytes32 indexed originHash, uint256 indexed agentId, string origin, address payTo, address operator);
event EndpointRetired(bytes32 indexed originHash, uint256 indexed agentId);
event SignerRegistered(address indexed signer, uint256 indexed agentId, bytes32 indexed releaseId, bytes32 originHash, address operator, uint64 expiresAt, bytes32 attestationHash, uint64 attestationTimestamp);
event SignerRevoked(address indexed signer, uint256 indexed agentId);
event SignerRenewed(address indexed signer, uint256 indexed agentId, uint64 expiresAt, bytes32 attestationHash, uint64 attestationTimestamp);
```

### 3.4 Function rules

"Owner" always means `IIdentityRegistry(identityRegistry).ownerOf(agentId)` read at call time. A revert inside `ownerOf` (burned token) is caught and mapped to `NotOwner`.

**`linkSelfAgent(agentId, selfAgentId)`**
- caller is the owner (`NotOwner`)
- `selfRegistry != 0` (`SelfDisabled`)
- Read with try/catch, mapping any revert to `SelfLinkInvalid`:
  - `ISelfAgentRegistry(selfRegistry).ownerOf(selfAgentId) == msg.sender`
  - `hasHumanProof(selfAgentId)`
  - `isProofFresh(selfAgentId)`
- Stores and emits. Informational only: no function depends on it in r2. The SDK re-evaluates the link at read time and shows "Self-verified owner" only if all three still hold and the Self owner equals the current agent owner. Supported Self mode: `linked` (human wallet owns the Self NFT). Other modes fail the ownerOf check by design.

**`approveRelease(agentId, pcr0, pcr1, pcr2, sourceRef)`**
- owner only
- each PCR is 48 bytes and not all zero (`InvalidPcr`)
- `sourceRef` is 1–256 bytes (`InvalidSourceRef`); it's an unverified claim (C2)
- `releaseId = keccak256(pcr0‖pcr1‖pcr2)`; status None → Approved, else `ReleaseExists`
- emits

**`setReleaseStatus(agentId, releaseId, to)`**
- owner only
- allowed transitions: Approved→Deprecated, Approved→Revoked, Deprecated→Approved, Deprecated→Revoked
- anything else is `InvalidTransition`; Revoked is terminal

**`addEndpoint(agentId, origin, payTo, operator)`**
- owner only
- prefix `https://` (or `http://localhost` iff `allowLocalOrigins`) and length 9–267 (`InvalidOrigin`)
- non-zero payTo and operator (`ZeroAddress`)
- `originHash = keccak256(bytes(origin))`; status None or Retired, else `OriginTaken`
- overwrites a retired record (including agentId); emits

**`retireEndpoint(originHash)`**: caller owns `endpoint.agentId` (`NotOwner`); status Active (`EndpointNotActive`) → Retired.

**`revokeSigner(signer)`**: caller owns `signer.agentId` (`NotOwner`); status Active (`SignerNotActive`) → Revoked (terminal).

**`registerSigner(agentId, originHash, attestation, hints)`**, in this order:

1. `e = _endpoints[originHash]`:
   - `e.status == Active` (`EndpointInactive`)
   - `e.agentId == agentId` (`EndpointMismatch`)
   - `msg.sender == e.operator` (`NotOperator`)
2. `(tbs, sig) = nitroValidator.decodeAttestationTbs(attestation)`; `ptrs = nitroValidator.validateAttestationWithHints(tbs, sig, hints)`; any revert propagates.
   - **Every `ptrs` field is an offset into `tbs`, never into `attestation`.** Read fields only with `tbs.slice(ptr)` / `tbs.keccak(ptr)` from the validator's `CborDecode` library (`using CborDecode for bytes`), after checking `!ptr.isNull()` (`LibCborElement`).
   - Never read anything from `attestation` directly.
3. `ts = ptrs.timestamp / 1000` (floor):
   - `ts <= block.timestamp + MAX_FUTURE_SKEW` (`AttestationFromFuture`)
   - `age = ts > block.timestamp ? 0 : block.timestamp - ts`; `age <= MAX_ATTESTATION_AGE` (`AttestationStale`)
4. `ptrs.pcrs[0..2]` are non-null and each 48 bytes; if any is all zero: `DebugPcrs`.
5. `releaseId = keccak256(pcr0‖pcr1‖pcr2)`; `_releases[agentId][releaseId].status == Approved` (`ReleaseNotApproved`).
6. `user_data` is non-null, exactly 160 bytes, and equals `abi.encode(BINDING_TYPEHASH, block.chainid, address(this), agentId, originHash)`, else `BindingMismatch(uint8 field)` (0 length, 1 typehash, 2 chainId, 3 registry, 4 agentId, 5 originHash).
7. `public_key` is non-null, 65 bytes, first byte 0x04 (`InvalidPublicKey`); `signer = address(uint160(uint256(keccak256(pk[1:65]))))`.
8. `_signers[signer].status == None` (`SignerExists`).
9. Store `Signer{agentId, releaseId, originHash, e.operator, now, now + SIGNER_TTL, Active, keccak256(tbs)}`; emit `SignerRegistered(…, ts)`.

**`renewSigner(signer, attestation, hints)`**, in this order:
1. `s = _signers[signer]`; `s.status == Active` and `now < s.expiresAt` (`SignerNotActive`). An expired signer can't be renewed; register a new one.
2. `e = _endpoints[s.originHash]`: Active (`EndpointInactive`), `e.agentId == s.agentId` (`EndpointMismatch`), `msg.sender == e.operator` and `e.operator == s.operator` (`NotOperator`).
3. Steps 2–7 of `registerSigner` with `agentId = s.agentId`, `originHash = s.originHash`. The derived signer must equal `signer` (`SignerMismatch`), and the derived `releaseId` must equal `s.releaseId` (`ReleaseMismatch`).
4. Set `s.expiresAt = now + SIGNER_TTL`, `s.attestationHash = keccak256(tbs)`; emit `SignerRenewed`.

Renewal re-proves, with an AWS-signed timestamp ≤ 30 min old, that the same key is still inside a genuine enclave of the same approved build. It needs no restart and no downtime.

**`checkSigner(signer, originHash)`**, first failure wins:
1. UNKNOWN_SIGNER
2. SIGNER_REVOKED
3. SIGNER_EXPIRED (`now >= expiresAt`)
4. ENDPOINT_MISMATCH (`s.originHash != originHash`)
5. ENDPOINT_INACTIVE
6. AGENT_MISMATCH (`e.agentId != s.agentId`)
7. **OPERATOR_MISMATCH (`e.operator != s.operator`)**: rotating the operator evicts old signers
8. RELEASE_NOT_APPROVED
9. OK

**`verifyProof(p, sig, originHash)`**:
1. Recover from `proofDigest(p)`; malformed or high-s → BAD_SIGNATURE.
2. `checkSigner`.
3. Then, in order:
   - `p.agentId != s.agentId` → AGENT_MISMATCH
   - `p.releaseId != s.releaseId` → RELEASE_NOT_APPROVED
   - `now > p.expiresAt` → PROOF_EXPIRED
   - `|p.issuedAt − now| > MAX_PROOF_SKEW` → PROOF_CLOCK_SKEW. This last check is valid only for fresh proofs; on-chain consumers of old proofs should use `checkSigner` + their own policy.

Request, response, inputs and payment binding are the caller's comparisons.

**Gas ceiling:** every external function stays below 16,000,000 gas.

### 3.5 Deployment

- `DeployValidatorStack.s.sol` deploys production `P384Verifier` → `CertManager(p384, admin, admin)` → `NitroValidator(certManager, p384)`.
- **Never `CertManagerDemo`.** The kill test's demo stack (T01) uses separate addresses recorded only in `docs/KILL_TEST.md` and is never referenced by `deployments.ts`.
- `DeployRegistry.s.sol` deploys `EnclaveRegistry(identity, nitroValidator, self, false)`.
- T10/T30 (`scripts/check-deploy.mjs`) assert:
  - the runtime code of **all four** contracts (P384Verifier, CertManager, NitroValidator, EnclaveRegistry) equals the compiled production artifact's `deployedBytecode` **with the deployed values spliced into every `immutableReferences` offset** (CertManager and NitroValidator have immutables, so a raw hash comparison can never match). A mock validator or CertManagerDemo fails this
  - `certManager.p384Verifier() == P384Verifier`, `nitroValidator.certManager() == certManager`, `registry.nitroValidator() == nitroValidator`
  - `owner()` equals admin

| Network | identity | self |
|---|---|---|
| Sepolia | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x043DaCac8b0771DD5b444bCC88f2f8BBDBEdd379` |
| Mainnet | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0xaC3DF9ABf80d0F5c020C06B04Cced27763355944` |

---

## 4. Enclave app (Rust)

### 4.1 Boot

1. vsock listener on the fixed in-enclave port **5000** (same EIF on both networks; nothing is passed at start). Enclaves are told apart by CID: `nitro-cli run-enclave --enclave-cid 16` mainnet, `17` Sepolia, `18` the test-modified build (on demand only).
2. **One-shot** `configure`:
   ```json
   {"type":"configure","chainId":"<dec>","registry":"0x…","agentId":"<dec>","origin":"https://…","rpcAllowedChains":["<dec>"]}
   ```
   A second `configure` returns `bad_frame`. The enclave normalises the origin and computes `originHash`. The config is untrusted but bound into the attestation.
3. Key from NSM `GetRandom` (retry if out of range); memory only (INV-15).
4. Attestation `{user_data: binding, public_key: 65-byte key}`. NSM unavailable → exit 3.
5. Serve.

### 4.2 Messages (4-byte big-endian length + JCS JSON, ≤ 65,536 bytes)

| Request | Response |
|---|---|
| `{"type":"attest"}` | `{"attestation":"<base64>","signer":"0x…"}`, a fresh attestation for the same key and binding (any time) |
| `{"type":"liveness","challenge":"0x…"}` | `{"liveness":{…strings…},"signature":"0x…"}` |
| `{"type":"evaluate","requestId","method","path","body":"<base64>","paymentId","inputs":{…}}` | `{"response":"<base64>","proof":{…strings…},"signature":"0x…"}` or `{"error":"bad_frame|bad_request|bad_inputs|not_configured"}` |

### 4.3 Workload: payment check, rules v1

**Request body**, ≤ 2,048 bytes, strict schema:
```json
{"chainId":"<dec>","payTo":"0x<40 lowercase hex>","asset":"0x<40 lowercase hex>","amount":"<^(0|[1-9][0-9]{0,77})$>"}
```
Unknown keys, uppercase hex, or `chainId ≠ configured chainId` → `bad_request`.

**Inputs** (from seller-host, read at one block):
```json
{"block":{"number":"<dec>","hash":"0x<64>","timestamp":"<dec>"},"payTo":{"address":"0x<40>","code":"0x…","nonce":"<dec>","balanceWei":"<dec>"},"source":"buy:<capability-id>|forno"}
```
The enclave checks `inputs.payTo.address == request.payTo` and the field grammar, else `bad_inputs`.

**Rules (all evaluated, outcomes in rule order):**

| Rule | Condition | Outcome | Reason code |
|---|---|---|---|
| R1 | `asset` not in the pinned asset table for `chainId` (§2.6) | deny | `unknown_asset` |
| R2 | `payTo` in `enclave/rules/denylist-v1.json` (lowercase addresses; in the image) | deny | `deny_listed` |
| R3 | `code != "0x"` | review | `pay_to_is_contract` |
| R4 | `code == "0x"` and `nonce == "0"` | review | `pay_to_never_sent` |
| R5 | `amount > 1000000000` | review | `large_amount` |

Verdict: deny if any deny, else review if any review, else allow.

**Response body** = JCS of:
```json
{"verdict":"…","reasons":[…],"rulesVersion":"1","inputs":{…the inputs object…}}
```
So `responseHash` covers the inputs, and `inputsHash` (in the proof) equals `keccak256(JCS(response.inputs))`.

**Determinism:** same `(request body, inputs)` give byte-identical responses (INV-16).

### 4.4 Proof

`issuedAt` = enclave clock (seconds). `expiresAt = issuedAt + 600`. `paymentId` from the message; `0x00…00` is refused when `paymentId` is absent (all paid calls carry one).

### 4.5 Build

Dockerfile with the base image pinned by digest; `cargo build --release --locked`; `SOURCE_DATE_EPOCH` = commit time; kaniko `--reproducible` → `nitro-cli build-enclave` → `build/<name>.eif` + `build/measurements.json`. `attessa enclave build` refuses a dirty tree.

**Decision date for S3 (reproducibility): Oct 26.** If it fails, buyer copy and claims stay at "owner says it's built from …" (which they are by default after C2).

---

## 5. Seller-host (Node, parent)

- **Two networks on one host (FR-13).** Everything below exists once per network, as systemd template units keyed by network (`attessa-seller@mainnet`, `attessa-seller@sepolia`, `attessa-gw@…`, `attessa-vsock@…`):

  | | mainnet | Sepolia |
  |---|---|---|
  | enclave CID (vsock port 5000) | 16 | 17 |
  | host socat TCP port | 5005 | 5007 |
  | seller-host HTTP | 127.0.0.1:7070 | 127.0.0.1:7071 |
  | gateway HTTP | 127.0.0.1:8080 | 127.0.0.1:8081 |
  | Caddy site | `<origin-mainnet>` | `<origin-sepolia>` (a second subdomain) |
  | SQLite | `/var/lib/attessa/mainnet.db` | `/var/lib/attessa/sepolia.db` |
  | agent / endpoint / signer | its own, on its own registry | its own |

  The test-modified enclave (CID 18, host port 5006) runs only during T17/T35 and is stopped after.
- **socat:** `attessa-vsock@<network>.service`: `socat TCP-LISTEN:<5005|5007|5006>,bind=127.0.0.1,fork,reuseaddr VSOCK-CONNECT:<16|17|18>:5000`. CIDs are pinned at start, so a restart can't point socat at the wrong enclave.
- **Enclave allocation:** allocator 3 vCPU / 3072 MiB on c6g.xlarge (4 vCPU, 8 GiB), leaving 1 vCPU and ~5 GiB for the parent. Each enclave `--cpu-count 1 --memory 1024`. Three enclaves side by side is confirmed by S2 (T12); if the EIF needs more than 1024 MiB or three don't fit, the test enclave runs only after stopping the Sepolia one.
- **HTTP on `127.0.0.1:7070` (mainnet) / `7071` (Sepolia):**

  | Route | Behaviour |
  |---|---|
  | `POST /internal/evaluate` | validate body schema (§4.3) → fetch inputs → enclave `evaluate` |
  | `POST /internal/liveness` | enclave `liveness` |
  | `POST /internal/attest` | enclave `attest` |

- **Input fetch:**
  1. Block N = latest − 1; read `{number, hash, timestamp}`.
  2. Read `eth_getCode`, `eth_getTransactionCount`, `eth_getBalance` for payTo at N.
  3. Primary: the buy Celo RPC capability (S7), paid from the agent wallet, as **one JSON-RPC batch per evaluate** (the four reads in one paid request) if the capability accepts batches; otherwise the four paid calls run in parallel. Cost is counted per evaluate. Fallback: Forno, with `source:"forno"`.
  4. 5 s timeout, then fallback once, then `inputs_unavailable`.
- **Agent wallet key:** env `AGENT_PRIVATE_KEY`, file 0600, used only for buy payments (mainnet) and to sign the `setAgentWallet` EIP-712 message once (T31). It isn't the agent owner after T31's transfer.
- **Input-read budget guard:** seller-host keeps a daily counter of buy spend; if it exceeds the gateway's settled revenue for the day + 1 USDC, it switches to Forno (`source:"forno"`) and `health.sh` alerts.

---

## 6. Gateway (Node, Fastify, behind Caddy)

### 6.1 Routes

| Route | Limit | Behaviour |
|---|---|---|
| `GET /.well-known/attested-exec.json` | 120/min/IP | `{"v":"1","chainId","registry","agentId","origin","resources":[{"path":"/v1/evaluate","method":"POST"}]}` (strings) |
| `POST /v1/liveness` | 30/min/IP | `{challenge}` → seller-host → passthrough |
| `POST /v1/evaluate` | 120/min/IP unpaid; in-flight cap 16; paid: per payer, at most 5 calls per hour that end without settling (`exec_failed`, `proof_rejected`, `too_late`, `settle_failed`), else 429 `rate_limited` before execution | §6.2 |
| `GET /v1/results/:requestId` | 60/min/IP | requires `X-Attest-Payer-Sig` (recovered == row payer). Serves rows in `settled`, `delivered`, `delivery_failed` whose `response` is not NULL: 200 + stored response + headers. 202 for `settling`/`settle_pending`. 404 `result_not_found` otherwise (including after the 24 h retention nulls `response`) |
| `GET /privacy`, `/terms`, `/healthz`, `/.well-known/security.txt` | 120/min/IP | static; `/healthz` returns only `{"ok":true}` |

### 6.2 `POST /v1/evaluate`

0. If `paused`: 503 `gateway_paused` (both unpaid and paid), with no verify and no execution.
1. Validate the body against §4.3 (cheap, before any payment): invalid → 400 `bad_request`. Not charged, nothing signed yet if unpaid.
2. **No `PAYMENT-SIGNATURE`** → 402 with `PAYMENT-REQUIRED`, containing this x402 v2 object:
   ```json
   {"x402Version":2,"error":"PAYMENT-SIGNATURE header is required","resource":{"url":"<origin>/v1/evaluate","description":"Payment check. You are charged only if the response's proof verifies.","mimeType":"application/json"},"accepts":[{"scheme":"exact","network":"eip155:<chainId>","amount":"<atomic>","asset":"<pinned>","payTo":"<registered payTo>","maxTimeoutSeconds":120,"extra":{"name":"<domain name>","version":"<domain version>","assetTransferMethod":"eip3009","paymentFlow":"authorization","attestedExec":{"v":"1","chainId":"<dec>","registry":"0x…","agentId":"<dec>","liveness":<object|null>}}],"extensions":{}}
   ```
   One entry per configured asset; `liveness` is set when `X-Attest-Challenge` was sent.
3. **With `PAYMENT-SIGNATURE`:**
   - Decode the x402 v2 `PaymentPayload` (`{x402Version:2, resource?, accepted, payload:{signature, authorization}, extensions?}`). `accepted` must be byte-for-byte JCS-equal to exactly one offered `accepts[]` entry. Reject a different version, network, scheme, asset, `assetTransferMethod`, or `paymentFlow` with 402 `payment_invalid{requirements_mismatch}`.
   - The selected entry must match `authorization.to == payTo` and `authorization.value == amount`, and its network must be the pinned CAIP-2 network, else 402 `payment_invalid{requirements_mismatch}`.
   - `validBefore − gatewayNow ≥ 40` s, else 402 `authorization_window_too_short`.
   - `requestId` = header or derived (§2.2), computed only now that the asset is known.
4. **Idempotency.** Take an in-process lock on both `requestId` and `(asset, payer, nonce)`, then look up existing rows:

   | Existing row | Same request + same payment | Different pairing |
   |---|---|---|
   | none | proceed to step 5 | n/a |
   | `settled` / `delivered` / `delivery_failed` | 200 stored result | 409 `payment_reused` / `request_id_conflict` |
   | `settling` / `settle_pending` | 202 `settle_pending` + `PAYMENT-RESPONSE` if a tx is known | 409 |
   | `payment_verified` / `executing` | 409 `in_progress`, `Retry-After: 2` | 409 |
   | `exec_failed` / `proof_rejected` / `too_late` / `settle_failed` | repeat the same error response (idempotent) | 409 |

5. Facilitator `POST /verify` with `{x402Version:2,paymentPayload,paymentRequirements:accepted}`. `isValid=false` → 402 `payment_invalid{reason}`. **No row is written for unverified payments.**
   - **Per-payer unsettled limit** (now that the payer is verified): if this payer has ≥ `unsettledLimitPerHour` (default 5) rows in the last hour ending in `exec_failed`, `proof_rejected`, `too_late` or `settle_failed`, answer 429 `rate_limited` with `Retry-After`, write no row, execute nothing.
6. Insert row `payment_verified` (payer from the verify response).
7. Signer pre-check: `currentSigner` from seller-host `/internal/attest`, refreshed every 60 s. `checkSigner(currentSigner, originHash) != OK` → `exec_failed`, 503 `enclave_unavailable`.
8. Row `executing`. Seller-host `/internal/evaluate`, 20 s timeout:
   - timeout → `exec_failed`, 504 `execution_timeout`
   - `bad_request` → `exec_failed`, 400 `bad_request`
   - `bad_inputs` / `inputs_unavailable` / unreachable → `exec_failed`, 503 `enclave_unavailable`
9. **Proof check** (all must pass, else `proof_rejected`, 502 `proof_rejected{check}`, never settle):
   - **recover** `r = ecrecover(proofDigest(proof), signature)`; reject high-s and v ∉ {27, 28}; require `r == header.signer`; use `r` (never the header field) for every later check
   - `checkSigner(r, originHash) == OK`
   - `proof.agentId/releaseId` equal the signer's
   - `requestId` equal
   - `requestHash` recomputed from the buyer's exact bytes
   - `responseHash` recomputed
   - `paymentId == nonce`
   - `inputsHash == keccak256(JCS(response.inputs))`
   - `|issuedAt − now| ≤ 120`
   - `expiresAt > now`
   - **inputs block check:** `eth_getBlockByNumber(inputs.block.number)` hash and timestamp equal `inputs.block`, and `now − inputs.block.timestamp ≤ 300` (`stale_inputs`)
   - **inputs value check:** `eth_getCode`, `eth_getTransactionCount`, `eth_getBalance` for `inputs.payTo.address` at `inputs.block.number` equal `inputs.payTo.code/nonce/balanceWei` (`inputs_mismatch`). The RPC must serve state at least 300 blocks back (S8)
10. If `validBefore − now < 10` → `too_late`, 502 `authorization_expiring`.
11. **One transaction:** store `response`, `proof_header`, `payment_payload`, `requirements`, state `settling`. Then facilitator `POST /settle` with `{x402Version:2,paymentPayload,paymentRequirements:accepted}`, 15 s timeout. The outcome is keyed on **HTTP status first**. A non-final RPC read must never prove an authorization unused:

    | Result (any send by the request handler, including a re-send after 429) | State | HTTP to buyer |
    |---|---|---|
    | 2xx and `success:true` | fetch the receipt for `transaction` (poll ≤ 5 s); both `AuthorizationUsed(payer, nonce)` and `Transfer(payer → payTo, amount)` from the asset → `settled`; otherwise `settle_pending` | continue to 12, or 202 |
| 400 or 412 (for example `insufficient_funds`, `invalid_payment_expired`, `recipient_mismatch`) | `settle_pending`; record the reason, but do not read `authorizationState` to terminalize. The reconciler decides from chain evidence or expiry | 202 `settle_pending` + `Retry-After: 3` |
    | 2xx with `success:false` | `settle_pending` (unexpected; the reconciler decides) | 202 |
    | 5xx, timeout, network error | `settle_pending` | **202** `settle_pending` + `Retry-After: 3` (+ `PAYMENT-RESPONSE` only if a tx hash is known); the SDK polls `/v1/results` |
    | 429 | retry with `Retry-After` (≤ 5 s) while `validBefore − now ≥ 10`, else `settle_pending` | 202 if it ends pending |
    | 401 or 402 | `settle_pending`, set `paused=true`, log `facilitator_auth_or_credit` | 202 |

    The fake facilitator in T19 reproduces these status codes and real settle reasons. A used nonce at `/settle` lands in `settle_pending`; the reconciler resolves it (`nonce_used_elsewhere` or `settled`).

12. `settled` → 200 with exact bytes + `X-Attested-Proof` + `PAYMENT-RESPONSE` + `X-Request-Id`. On write success → `delivered`. On socket error → `delivery_failed`.

### 6.3 Reconciler (every 5 s and at startup)

**At startup:** rows in `payment_verified` / `executing` → `exec_failed` (never settle them).

**`settling` / `settle_pending`:**
1. Find `AuthorizationUsed(payer, nonce)` logs from the row's **asset contract** since the row's `created_at` block.
2. If found: fetch the receipt. Require, in that same tx, a `Transfer(payer → payTo, amount)` from the same asset.
   - Found → `settled` (record the tx).
   - Not found → `settle_failed{nonce_used_elsewhere}`: the buyer used the nonce elsewhere; result withheld; not charged by us.
3. If an `AuthorizationCanceled(payer, nonce)` log exists → `settle_failed{cancelled}`.
4. Otherwise: read the latest block header H. If `H.timestamp > validBefore + 5`, `eth_call authorizationState(payer, nonce)` **at block H**. If false → `settle_failed{expired}`. If true → the log query is behind; repeat next tick.
5. While `H.timestamp ≤ validBefore + 5` and `paused` is false: retry `/settle` once per tick from the stored `payment_payload` and `requirements`, **only for `settle_pending` rows, or `settling` rows whose `updated_at` is more than 20 s old** (the handler's own send, 15 s timeout + backoff, is over or the process crashed). The handler marks in-process which rows it is sending, and the reconciler skips those (safe: a used nonce reverts on chain; at most one settles). **A retry's answer never moves a row to a terminal state.** Only chain evidence (steps 1–4) does: a retry can fail precisely because the first attempt landed and the log index lags.

**`payment_payload` retention:** set to NULL when the row reaches a terminal state. Never logged.

**`settled` with no live response** for > 30 s → `delivery_failed`.

**Every row reaches a terminal state** (`delivered`, `delivery_failed`, `exec_failed`, `proof_rejected`, `too_late`, `settle_failed`) by `validBefore + 60` s (INV-11).

### 6.4 Storage (SQLite, WAL)

```sql
CREATE TABLE calls (
  request_id        TEXT PRIMARY KEY,
  payer             TEXT NOT NULL,
  asset             TEXT NOT NULL,
  pay_to            TEXT NOT NULL,
  amount            TEXT NOT NULL,
  auth_nonce        TEXT NOT NULL,
  valid_before      INTEGER NOT NULL,
  request_hash      TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('payment_verified','executing','exec_failed','proof_rejected','too_late','settling','settle_pending','settled','settle_failed','delivered','delivery_failed')),
  reject_reason     TEXT,
  response          BLOB,
  proof_header      TEXT,
  payment_payload   TEXT,      -- base64 PAYMENT-SIGNATURE; NULL once terminal
  requirements      TEXT,      -- JSON of the matched accepts entry
  settle_tx         TEXT,
  created_block     INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  result_expires_at INTEGER,
  UNIQUE (asset, payer, auth_nonce)
);
CREATE INDEX calls_payer_created ON calls(payer, created_at);       -- /v1/results auth, per-payer unsettled limit, deletion requests
CREATE INDEX calls_open ON calls(state) WHERE state IN ('payment_verified','executing','settling','settle_pending','settled'); -- reconciler/startup
CREATE TABLE gateway_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); -- 'paused'
```

**Retention:** `response` → NULL at `result_expires_at` (24 h after delivery or settle). Rows kept until 2026-12-31, then deleted. IPs never persisted.

**Export:** `attessa gateway export --since <date> --format csv|jsonl` gives request_id, payer, pay_to, asset, amount, settle_tx, state, proof_verified, created_at.

### 6.5 TLS and processes

- Caddy :443 (auto Let's Encrypt) → Fastify `127.0.0.1:8080`.
- Headers: HSTS, nosniff; no compression on `/v1/*`.
- systemd users: `attessa-gw`, `attessa-seller`, `attessa-op`.

### 6.6 Config

`gateway.config.json`: network, registry, agentId, origin, payTo, prices per asset (default 20000), sellerHostUrl, facilitatorUrl, timeouts. Env: `FACILITATOR_API_KEY`, optional `RPC_URL`. **No private key.**

**CLI on the host:** `attessa gateway pause | resume | status | export [--network mainnet|sepolia]`. `resume` first calls the facilitator `/supported` with the API key and refuses if it gets 401/402.

---

## 7. SDK (TypeScript)

```ts
export type Network = 'celo' | 'celo-sepolia' | 'local';
export type AssetKey = 'usdc' | 'usat';
export interface Limits { maxAmountPerCall: bigint; dailyCap: bigint; }    // atomic units, per asset
export interface AttestConfig { network: Network; rpcUrl?: string; account: LocalAccount; limits: Record<AssetKey, Limits>; asset: AssetKey; dataDir: string; waitForExpiry?: boolean /* default true */; }
export type Outcome =
  | 'verified'            // settled + proof + inputs block checks pass
  | 'refused'             // the gateway refused or failed before settling; NOT yet confirmed uncharged
  | 'not_charged'         // chain-confirmed: authorization unused (or cancelled) after validBefore
  | 'paid_but_rejected'   // settled (chain-confirmed) but a check failed
  | 'settled_after_refusal' // the gateway refused, yet the authorization was settled
  | 'unattested'          // --via buy, no proof offered
  | 'stopped'             // nothing signed
  | 'uncertain';          // signed, outcome unknown yet (reconcile)
export interface CallResult { outcome: Outcome; code?: ErrorCode; check?: ProofCheck; requestId: Hex; response?: Uint8Array; proof?: ExecutionProof; signer?: Address; settlementTx?: Hash; amount?: bigint; asset?: Address; payTo?: Address; ownerClaimedSource?: string; selfVerifiedOwner?: boolean; }
export type ProofCheck = 'missing_proof' | 'bad_signature' | 'request_mismatch' | 'response_hash_mismatch' | 'payment_mismatch' | 'inputs_hash_mismatch' | 'inputs_mismatch' | 'stale_inputs' | 'clock_skew' | 'signer_not_active' | 'release_not_approved' | 'endpoint_mismatch' | 'agent_mismatch' | 'operator_mismatch' | 'proof_expired';
export function createAttestClient(cfg: AttestConfig): {
  resolveEndpoint(url: string): Promise<ResolvedEndpoint>;   // registry + .well-known cross-check + Self link evaluation
  checkLiveness(url: string): Promise<LivenessResult>;
  payAndVerify(url: string, req: { body: Uint8Array | string; requestId?: Hex; maxAmount?: bigint; asset?: AssetKey; newRequest?: boolean }): Promise<CallResult>;
  verifyPaidResponse(entry: PendingEntry, response: Uint8Array, proofHeader: string): Promise<{ ok: true; proof: ExecutionProof; signer: Address } | { ok: false; check: ProofCheck }>;
  getResult(requestId: Hex): Promise<CallResult>;            // uses the pending ledger entry; never re-pays
  confirmNotCharged(requestId: Hex): Promise<CallResult>;    // waits until chain time > validBefore + 5
  cancelAuthorization(requestId: Hex): Promise<Hash>;
  listPending(): Promise<PendingEntry[]>;
  reconcilePending(): Promise<CallResult[]>;
  status(target: string | bigint): Promise<StatusReport>;
};
```

### Pending ledger entry (`<dataDir>/pending.jsonl`; written at V8 before sending)

```json
{"v":"1","requestId","origin","originHash","method","pathAndQuery","requestHash","asset","amount","payTo","payer","nonce","signedAtChain","validAfter","validBefore","agentId","expectedSigner":"0x…|null","state":"reserved|signed|refused|uncertain|settle_pending|<terminal outcome>","createdAt"}
```

The entry is written at **V6** in state `reserved` (amount and asset known; nonce and window empty), under the same file lock as the cap check, so the reservation and the entry are one record. V7 failure deletes it (releases). V8 fills `nonce`, `signedAtChain`, `validAfter`, `validBefore` and sets `signed` before anything is sent. **On every V6** (under the lock), any `reserved` entry older than 10 minutes with no nonce was never signed and is deleted. V0 treats a `reserved` entry for the same input as "in progress in another process": wait up to 30 s for it to become `signed`, never call `getResult` without a nonce. Today's spend = sum of `amount` over entries in `reserved|signed|refused|uncertain|settle_pending` plus every settled outcome, per asset.

`getResult`, `reconcilePending` and `verifyPaidResponse` always verify against this entry: requestHash, nonce = paymentId, payTo, amount, asset, originHash.

**V10 time anchors (paid results).** A paid result is judged at the moment it was paid for, not when it was fetched. With `A = entry.signedAtChain` and `S` = timestamp of the settlement block from V11:
- `A − 120 ≤ issuedAt ≤ S + 120` (`clock_skew`). `S ≤ validBefore` always holds for a settled EIP-3009 authorization
- `expiresAt == issuedAt + 600` (format check only; expiry against the current time is not applied to paid results)
- `A − 300 ≤ inputs.block.timestamp ≤ S` (`stale_inputs`)
- signer and release status: `checkSigner(r, originHash)` via `eth_call` **at the settlement block** (`signer_not_active` / `release_not_approved` / …). First wait until the RPC head is ≥ that block. If the RPC can't serve state that old (Sepolia Forno keeps ~10,000 blocks), rebuild the status at S from events ≤ S (`SignerRegistered`, `SignerRenewed`, `SignerRevoked`, `ReleaseApproved`, `ReleaseStatusChanged`, `EndpointAdded`, `EndpointRetired`; `eth_getLogs` in 1,000-block chunks). **An RPC error is never a ProofCheck:** if neither works, the call stays `uncertain` with code `rpc_unavailable` and the CLI says "Can't finish checking: your RPC doesn't have that block's data. Retry with --rpc <archive RPC>."
- inputs values re-read at `inputs.block.number`. If the RPC can't serve that historical state, record `inputsChecked:false` in evidence and print "inputs not re-checked (your RPC doesn't keep state that old)"; this is not a failure

So a result fetched 200 s or 2 h after settlement still verifies (INV-13 test).

### `payAndVerify`

| Step | Action | On failure |
|---|---|---|
| V0 | Ledger: if an entry for `(originHash, requestHash)` exists and isn't terminal, and not `newRequest` → resume via `getResult` / `reconcilePending` | n/a |
| V1 | `resolveEndpoint`: `endpoints(originHash)` Active; GET `/.well-known/attested-exec.json` and require `agentId` (and registry, chainId) equal | `endpoint_not_registered` / `endpoint_retired` / `origin_agent_mismatch` / `rpc_unavailable` → `stopped` |
| V2 | Unpaid POST with `X-Request-Id`, `X-Attest-Challenge`, body → 402 | `quote_unavailable` / `quote_malformed` / `gateway_paused` → `stopped` |
| V3 | Pick the entry for the configured asset; `asset`, `extra.name/version` and network must equal the §2.6 pins | `quote_malformed` / `network_mismatch` |
| V4 | `payTo == endpoint.payTo` | `payto_mismatch` (R) |
| V5 | selected x402 v2 `amount ≤ min(maxAmount, limits[asset].maxAmountPerCall)` | `over_max_amount` (R) |
| V6 | Under the file lock: today's (settled + reserved) for this asset + amount ≤ `dailyCap` → **reserve** amount | `over_daily_cap` (R) |
| V7 | Liveness: signer recovered; `checkSigner == OK`; challenge, originHash equal; `|issuedAt − chainNow| ≤ 120` | `liveness_failed{…}` → release reservation, `stopped` |
| V8 | Read the latest block timestamp `chainNow`. Sign EIP-3009: `validAfter = chainNow − 60`, `validBefore = chainNow + 120`, nonce = 32 random bytes. Write the ledger entry (state `signed`) | n/a |
| V9 | Paid POST. 200 → V11 then V10. 202 → poll `/v1/results` every 3 s until 200 or `validBefore + 60` → else `uncertain`. A 4xx/5xx **with a well-formed §10 body whose `requestId` matches** → `refused` (+ code). Any other non-2xx (a proxy 502, an HTML page, a missing body), timeout or drop → `uncertain` | as stated |
| V11 | Settlement confirmed on chain: poll the receipt at `settlementTx` for up to 10 s (the buyer's RPC may lag the facilitator's); it contains `AuthorizationUsed(payer, nonce)` **and** `Transfer(payer → payTo, amount)`, both from the pinned asset; its block timestamp is `S` | if not, `uncertain` → reconcile |
| V10 | `verifyPaidResponse`: every §6.2 step-9 check done independently (recovery, hashes, paymentId, inputsHash, inputs block and values), with the **time anchors** below instead of the current time | `paid_but_rejected{check}` |
| V12 | Evidence row; move the reservation to settled spend; ledger entry terminal | n/a |

**`refused` / `uncertain` → final:** by default (`waitForExpiry`) the SDK waits until a block with timestamp > validBefore + 5. If `authorizationState == false` there → `not_charged`, reservation released. If it's true, find the tx (AuthorizationUsed + Transfer to payTo from the asset); if found, **first call `getResult`**: a result that passes V10 → `verified`; a result that fails → `paid_but_rejected`; no result and the call was `refused` → `settled_after_refusal`; no result and the call was `uncertain` → `paid_but_rejected{missing_proof}`. Spend counted in all settled cases. Cancel (`cancelAuthorization`) makes `not_charged` immediate on confirmation.

### Evidence row (append-only)

```json
{"v":"1","ts","requestId","origin","agentId","outcome","code","check","amount","asset","payTo","settlementTx","signer","releaseId","ownerClaimedSource","selfVerifiedOwner","requestHash","responseHash","inputsHash","inputsBlock","inputsChecked","via":"gateway|buy"}
```

### Key storage

OS keychain (`keytar`); fallback env `ATTESSA_PRIVATE_KEY` or `--keystore`. Never printed.

---

## 8. CLI (`attessa`)

Product name **Attessa**. npm packages `@attessa/core`, `@attessa/sdk`, `@attessa/cli`, `@attessa/gateway`, `@attessa/seller-host`. The CLI binary is `attessa`, with `attest` installed as an alias. Protocol identifiers keep their neutral names and do not change with the product: EIP-712 domain `AttestedExecution`, `/.well-known/attested-exec.json`, `AttestedExecution.SignerBinding.v1`, headers `X-Attest-*` / `X-Attested-Proof`.

Copy from FLOWS §6/§8. Global flags: `--network sepolia|mainnet|local`, `--rpc`, `--json`, `--yes`, `--dry-run`.

**Buyer:**

| Command | Notes |
|---|---|
| `attessa init` | J0 |
| `attessa call <url> --body <file\|json> [--max-amount] [--asset usdc\|usat] [--new] [--no-wait]` | J1/J2; waits to confirm not-charged unless `--no-wait` |
| `attessa cancel <requestId>` | n/a |
| `attessa status [<origin>\|--agent <id>] [--pending]` | n/a |
| `attessa evidence export` | n/a |
| `attessa release verify <releaseId> --source <git url@commit>` | optional G6; rebuilds and compares PCRs, records "reproduced by you" in the local data dir |

**Owner:**

| Command | Notes |
|---|---|
| `attessa agent register --name --description --uri <agentURI>` | writes `docs/agent.json` (`services`, `x402Support:true`, `supportedTrust:["reputation","tee-attestation"]`) |
| `attessa agent transfer --to <cold owner>` | from the agent wallet (current owner); first step |
| `attessa agent wallet-sig --agent <id> --owner <cold owner> [--deadline ≤300]` | run on EC2 **after** the transfer, with the agent wallet: prints the EIP-712 `AgentWalletSet(agentId, newWallet, owner, deadline)` signature (no tx). The reference contract binds the current owner and rejects a deadline more than 5 minutes ahead |
| `attessa agent set-wallet --sig <sig> --deadline <same>` | from the cold owner, within those 5 minutes: submits `setAgentWallet(agentId, agentWallet, deadline, sig)` (the contract requires `msg.sender` = owner or approved) |
| `attessa selflink` | n/a |
| `attessa release approve\|deprecate\|revoke` | n/a |
| `attessa endpoint add\|retire` | n/a |
| `attessa revoke signer <addr>` | n/a |

**Operator (EC2):**

| Command | Notes |
|---|---|
| `attessa enclave build` | n/a |
| `attessa enclave start --agent --origin [--port 5005] [--test-build]` | `--cpu-count 1 --memory 1024`, never `--debug-mode` |
| `attessa signer register --agent [--attestation <file> \| --fresh]` | registers a **new** key. `--fresh` fetches a new attestation for the running key from seller-host (no restart), for when the first one went stale before registering; caches only missing certs |
| `attessa signer renew [--network]` | renews the running key: fetches a fresh attestation and calls `renewSigner` (no restart, no downtime); caches only missing certs (a 6-day-old enclave usually needs a new instance CA and leaf: about 5–7 CELO). Run by cron on the host whenever `expiresAt − now < 72 h` (Joshua broadcasts until the builder may) |

**Gateway operator (EC2):** `attessa gateway pause|resume|status|export [--network]`.

**Optional (post-Nov 2):** `attessa call --via buy <url> [--accept-unprotected]` (J5).

---

## 9. Main flow with extensions (gateway view)

- **Name:** pay-if-verified. **Actor:** buyer agent.
- **Minimal guarantee:**
  - No settlement without a verified proof (gateway).
  - The buyer's record never says "not charged" until the chain confirms it.
  - Every outcome is in evidence.
- **Success guarantee:** response + verified proof + chain-confirmed settlement.

**Main scenario:**
1. resolve + cross-check
2. quote with liveness
3. bounds, payTo, reservation
4. sign (chain time)
5. paid request
6. facilitator verify
7. execute
8. proof + inputs-block check
9. persist + settle
10. deliver
11. SDK re-verify + settlement receipt check
12. evidence

**Extensions:**

| Ext | Condition | Code | Ends in |
|---|---|---|---|
| 1a | not registered / retired / `.well-known` agent ≠ registry / RPC down | `endpoint_not_registered` / `endpoint_retired` / `origin_agent_mismatch` / `rpc_unavailable` | stopped |
| 2a | paused | `gateway_paused` | stopped |
| 2b | bad body | `bad_request` | stopped |
| 2c | not 402 / malformed | `quote_unavailable` / `quote_malformed` | stopped |
| 3a–c | payTo / limits / network | `payto_mismatch` / `over_max_amount` / `over_daily_cap` / `network_mismatch` | stopped (R) |
| 3d | liveness fails | `liveness_failed` | stopped |
| 5a | window < 40 s | `authorization_window_too_short` | refused → not_charged |
| 5b | conflicts | `payment_reused` / `request_id_conflict` / `in_progress` | refused, or retry |
| 5c | payer over the unsettled limit | `rate_limited` | refused → not_charged |
| 6a | verify invalid | `payment_invalid{reason}` | refused → not_charged |
| 7a | exec timeout / unavailable / bad request | `execution_timeout` / `enclave_unavailable` / `bad_request` | refused → not_charged |
| 8a | proof or inputs check fails (incl. `inputs_mismatch`) | `proof_rejected{check}` | refused → not_charged (cancel optional) |
| 8b | too close to expiry | `authorization_expiring` | refused → not_charged |
| 9a | settle ambiguous | 202 `settle_pending` | reconcile → verified / not_charged |
| 9b | settle rejects, times out, or is ambiguous | 202 `settle_pending` | reconcile → verified / not_charged |
| 9c | facilitator auth/credit | 202 + paused | reconcile |
| 10a | delivery drop | `delivery_failed` → `/v1/results` | verified |
| 11a | SDK check fails after settle | `paid_but_rejected` | evidence + warning |
| 11b | refused but settled | `settled_after_refusal` | evidence + warning |
| 10b | proxy error with no §10 body after a real settle | `uncertain` | chain shows used → `getResult` → verified |
| any | Ctrl-C after V8 | `uncertain` | reconcile |

---

## 10. Error contract (machine)

| Code | HTTP | Retryable | Suggestion |
|---|---|---|---|
| bad_request | 400 | no (fix input) | `fix_request` |
| payment_invalid{reason} | 402 | per reason | per reason |
| authorization_window_too_short | 402 | yes | `retry_new_request` |
| payment_reused / request_id_conflict | 409 | no | `retry_new_request` |
| in_progress | 409 | yes, `Retry-After` | `retry_same_request` |
| settle_pending | 202 | poll | `poll_results` |
| proof_rejected{check} | 502 | no | `wait_or_cancel` |
| authorization_expiring | 502 | yes | `retry_new_request` |
| settle_failed{reason} | 502 | yes | `retry_new_request` |
| execution_timeout | 504 | yes (5 s) | `retry_new_request` |
| enclave_unavailable | 503 | yes (30 s) | `retry_later` |
| gateway_paused | 503 | yes (5 min) | `retry_later` |
| gateway_busy | 503 | yes (2 s) | `retry_later` |
| rate_limited | 429 | yes, `Retry-After` | `retry_later` |
| result_not_found | 404 | no | `check_pending` |
| proof_rejected{inputs_mismatch} | 502 | no | `wait_or_cancel` |

Body for every non-2xx (and 202): `{"error","detail","message","suggestion","correlationId","requestId"}`. No stack traces.

**Breaking change** (needs `/v2` + 30 days' notice):
- removing or renaming a field, header or code
- changing a hash, EIP-712 type or pinned domain
- narrowing accepted input
- changing a status code for an existing condition
- tightening a rate limit below the published values

---

## 11. Gates, claims and acceptance

| Gate | Ships | Claims | Acceptance |
|---|---|---|---|
| G1 kill test (running), **target Oct 21** | demo-stack nitro-validator on Celo Sepolia with the fixture | C1.1 each tx < 16,777,216 gas; C1.2 validator works on Celo | T01 |
| G2 registry, **target Oct 24** | EnclaveRegistry + tests + Sepolia deploy (production CertManager) | C2.1 §3.4 enforced, fields read from `tbs` only; C2.2 INV-1…8 under fuzz; C2.3 registerSigner < 16M gas | T02–T11 |
| G3+4 enclave + e2e (one review), **target Oct 30** | enclave, seller-host, gateway, SDK, CLI on Sepolia USDC | C3.1 key never leaves the enclave; C3.2 binding byte-exact; C3.3 a modified build is refused; C4.1 INV-9; C4.2 every row terminal (INV-11); C4.3 "not charged" only chain-confirmed; C4.4 tamper → refused → not_charged; C4.5 revoke → refused within 60 s (on a fork); C4.6 a late-fetched paid result still verifies; C4.7 fabricated inputs are refused | T12–T25 |
| G5 mainnet, **target Nov 2**; G5 closes on USDC, the USA₮ call (T32b) may land by Nov 6 | stack, registry, identity, USDC + USA₮ calls, buy-paid inputs, settlement log | C5.1 addresses verified (production CertManager hash); C5.2 USA₮ settles; C5.3 buy calls from the agent wallet recorded | T26–T33 |
| G6 submission, **target Nov 8** (deadline Nov 9 09:00 GMT) | README, docs, demo, claims | C6.1 every public claim has evidence | T34–T35 |

---

## 12. Claims table

| Claim | Evidence required |
|---|---|
| "Pays only if the answer's proof checks out, and confirms on chain when you weren't charged" | G3+4 e2e tamper output + chain reads |
| "The key came from a genuine AWS Nitro enclave running the build its owner approved" | `SignerRegistered` tx + attestationHash + PCRs |
| "That build is reproducible from <commit>" | **Only after S3 passes** and a second party reproduces it. Until then the copy is "owner says it's built from <commit>" |
| "Nothing on Celo did this before" | `docs/PRIOR_ART.md` with method, addresses, block ranges; else don't say it |
| Gas and cost numbers | measured tx hashes |
| "Used by N independent wallets" | payer list meeting the hackathon definition, with each one's first-activity tx before the window |
| Partner names or logos | written permission |
| "Self-verified owner" | only when the SDK's live check passes (§3.4 `linkSelfAgent`) |

**Never say:** trustless, provably correct, verifiable AI, verified sellers, refund, "runs the seller's published code" (without S3 + reproduction).

---

## 13. Schedule and cut list (r3)

| Date | Gate target | Blocked on (Joshua) |
|---|---|---|
| Oct 21 | G1 kill test done; AWS enclave approval applied for; domain bought; Loops enrolled | AWS, domain, Loops |
| Oct 24 | G2 registry on Sepolia | Sepolia broadcasts (or the builder, if OPEN-QUESTIONS allows) |
| Oct 26 | S3 decision | n/a |
| Oct 30 | G3+4 on Sepolia; T37 Sepolia seller stays live from here | Sepolia broadcasts |
| Nov 2 | G5 mainnet (USDC), outreach starts | mainnet broadcasts, funded wallets |
| Nov 6 | USA₮ verified call | USA₮ in the buyer wallet |
| every ≤ 4 days from first registration | `attessa signer renew` per network (cron alert at < 72 h left) | broadcasts |
| Nov 8 | G6 docs + demo; check both signers cover Nov 14 (T36) | broadcasts |
| Nov 9 09:00 GMT | two submissions | n/a |

**Cut list, in this order, the moment a gate misses its date by more than one day:**
1. T29 `--via buy` (already optional)
2. `attessa release verify`
3. T14's second build (copy stays "owner says it's built from …")
4. Mutation patches beyond the three core ones (operator check, zero PCR, read-from-attestation)
5. T16b (keep T07's padded-header test)
6. The Sepolia seller during judging (FR-13): tutorial and `pnpm docs:tutorial-test` (T34) switch to mainnet with `--max-amount 0.05`, NFR-5 is measured on mainnet

Never cut: INV-9/10/11 tests, the reconciler, chain-confirmed "not charged", the proof recovery check, USDC on mainnet.
