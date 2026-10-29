# GLOSSARY (r5)

One term, one meaning, in code, docs, tests, copy and conversation. User copy uses the plain term; code uses the true term.

| True term (code) | Plain term (copy) | Meaning |
|---|---|---|
| agent / `agentId` | the seller's identity | An ERC-8004 identity (ERC-721 token) on the reference Identity Registry. Owner = `ownerOf(agentId)` |
| owner | owner | The wallet that holds the agent NFT. Approves releases, adds endpoints, revokes |
| operator | operator | The wallet allowed to register signers for an endpoint. Runs the EC2 host |
| release / `releaseId` | the seller's approved build | An approved build, identified by keccak256(PCR0‖PCR1‖PCR2). `sourceRef` is the owner's unverified claim about the commit; copy says "owner says it's built from …" (L20) |
| endpoint / `originHash` | the service address | `{origin, payTo, operator}` bound to one agent. Origin normalised per SPEC §2.1 |
| `payTo` | the address registered for this service | Where buyers' payments go; must match the 402 or the SDK refuses |
| signer | the sealed machine's key | An enclave-generated secp256k1 key whose attestation the registry verified |
| renew | renew | `renewSigner`: the same running key re-proves itself with a fresh attestation; extends `expiresAt` by 7 days; no restart |
| register | register | `registerSigner`: a new key (after a restart) goes on chain |
| Nitro enclave | sealed machine | An AWS-isolated VM whose code is measured (PCRs) and whose operator can't log in or change it |
| attestation | AWS's signed report | The NSM-signed COSE document: PCRs, public_key, user_data, timestamp, cert chain |
| binding | n/a | The 160-byte `user_data`: (typehash, chainId, registry, agentId, originHash) |
| proof / `ExecutionProof` | the check / "checks out" | The EIP-712 signature by a signer over a response. Never called a receipt |
| liveness | "up and answering right now" | An EIP-712 signature over a buyer's fresh challenge |
| verified | checks out | A proof passed every check against the registry |
| rejected / refused | refused | A proof was offered and failed a named check. A refusal, not an error |
| unattested | no proof offered | The service offered no proof |
| Mode A | via buy, unprotected | buy settles before calling the service; we can only check afterwards |
| Mode B | protected | Our gateway settles only after the proof checks out |
| settle | pay | The on-chain EIP-3009 transfer via the facilitator |
| payment permission | payment permission | The buyer's signed EIP-3009 authorization (free to sign) |
| x402 v2 payment | payment request | A `PAYMENT-REQUIRED` quote, a matching `PAYMENT-SIGNATURE` payload whose `accepted` item equals the quote, and a `PAYMENT-RESPONSE` settlement record |
| cancel | void | `cancelAuthorization` on the token: the permission can't be used afterwards |
| refused | refused | The gateway declined before settling. Not yet confirmed uncharged |
| not charged | not charged | Chain-confirmed: `authorizationState == false` at a block past validBefore + 5, or a confirmed cancel. Never asserted earlier |
| settle pending | still settling | The facilitator's answer was ambiguous; the reconciler decides from chain logs. HTTP 202 |
| settled after refusal | refused but charged | The gateway refused, yet the authorization settled: a gateway fault, recorded as evidence |
| reservation | held against your daily limit | Amount counted against `dailyCap` from signing until settled or confirmed not charged |
| paid but rejected | charged but didn't check out | Settled, yet the SDK's independent check failed: a gateway fault |
| inputs / `inputsHash` | the chain data it read | Chain reads at a stated block that the workload used; hash committed in the proof |
| evidence | record | The buyer's append-only JSONL of every call |
| settlement log | settlement log | The gateway's export of settled calls (payer, payTo, asset, amount, tx, requestId, verdict) |
| attested execution provenance | n/a (the property) | An approved build produced this response for this request. Not correctness, not input truth, not availability |
