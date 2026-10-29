# INVARIANTS (r5)

Properties that must never be violated. Each names how it's checked. A test that would still pass with the property removed doesn't count (mutation check, `scripts/mutate.sh`, see PIPELINE.md).

## Contract (EnclaveRegistry)

| ID | Property | Checked by |
|---|---|---|
| INV-1 | A signer is Active only if `registerSigner` succeeded with an attestation that NitroValidator validated, **every field was read from `tbs` via the returned `Ptrs`** (never from `attestation`), and the signer equals `address(keccak256(public_key[1:]))` | unit with a mock whose `tbs ≠ attestation` (T04); mutation "read from attestation" killed (T05); real fixture + padded-unprotected-header test (T07); real-attestation positive test (T16b); invariant fuzz (no other path creates a signer) |
| INV-2 | `signer.releaseId == keccak256(pcr0‖pcr1‖pcr2)` of its attestation, and that release was Approved for `signer.agentId` in the block it was registered | unit + fuzz (mock validator with random PCRs) |
| INV-3 | No signer was registered from an attestation with an all-zero PCR0/1/2, or with `ts` outside `[block.timestamp − 1800, block.timestamp + 60]`; the age computation never reverts for `ts` in `(now, now + 60]` | unit at the boundaries (1799/1800/1801 s, +59/+60/+61 s) + fuzz |
| INV-4 | Every registered signer's `user_data` equalled `abi.encode(BINDING_TYPEHASH, chainid, registry, agentId, originHash)` exactly (160 bytes) | unit per field (6 cases) + fuzz on random user_data |
| INV-5 | Only `ownerOf(agentId)` changes that agent's releases, endpoints, Self link or signer revocations; only `endpoint.operator` registers signers for that endpoint | invariant fuzz with ≥ 3 actors (owner, operator, stranger) + unit per function |
| INV-6 | An originHash maps to at most one endpoint record; while Active, its agentId, payTo and operator don't change | invariant fuzz (ghost map of first agent per active origin) |
| INV-7 | Revoked releases never become Approved or Deprecated; Revoked signers never become Active | invariant fuzz |
| INV-24 | `renewSigner` changes only `expiresAt` and `attestationHash` of an Active, unexpired signer, and only with a fresh, valid attestation whose `public_key` derives that signer and whose PCRs give the same releaseId, submitted by the endpoint's current operator | unit per error + invariant fuzz (agentId, releaseId, originHash, operator never change after registration) |
| INV-8 | `checkSigner(s, o) == OK` ⇔ signer Active ∧ `now < expiresAt` ∧ `s.originHash == o` ∧ endpoint(o) Active ∧ `endpoint.agentId == s.agentId` ∧ **`endpoint.operator == s.operator`** ∧ release(s.agentId, s.releaseId) Approved | invariant fuzz comparing to a reference model in the handler |

## Gateway

| ID | Property | Checked by |
|---|---|---|
| INV-9 | The facilitator `/settle` is called only for a call whose proof passed every SPEC §6.2 step-9 check (signer **recovered** from the signature, inputs block and values re-read), with `paymentId == authorization nonce`, and the response and proof header were persisted before the call. A payment is settled by us at most once per `(asset, payer, nonce)` | integration tests with a fake facilitator counting calls (T19 case list) |
| INV-10 | A response body is released only together with its proof, and only from a row in `settled`/`delivered`/`delivery_failed` (directly, or via `/v1/results` with a valid payer signature) | integration test: every non-200 path asserts no enclave body bytes in the response |
| INV-11 | Every row reaches a terminal state (`delivered`, `delivery_failed`, `exec_failed`, `proof_rejected`, `too_late`, `settle_failed`) by `validBefore + 60 s`, including rows left in `payment_verified`/`executing` by a crash. A row becomes `settled` only on a tx containing both `AuthorizationUsed(payer, nonce)` and `Transfer(payer → payTo, amount)` from the quoted asset; `settle_failed{expired}` only from a read at a block with timestamp > validBefore + 5 | reconciler test with a fake chain: used, used-elsewhere (value 0 to self), cancelled, never-used, lagging RPC, a retry that returns 400 while the first tx lands late (a retry's answer never terminalizes a row), a handler 400 with stale `authorizationState == false` followed by the matching receipt (the row stays pending, then settles), and a 2xx whose receipt lacks the Transfer; startup sweep test |
| INV-21 | No `calls` row exists for a payment that failed facilitator `/verify` | integration test: invalid payment → zero rows |

## SDK / CLI

| ID | Property | Checked by |
|---|---|---|
| INV-12 | No EIP-3009 authorization is ever signed when `payTo ≠ registry payTo`, `asset`/domain ≠ the §2.6 pin, `amount > limit`, (settled + reserved) + amount > `dailyCap`, or liveness failed | unit tests with a signing spy asserting zero calls on each refusal path |
| INV-13 | `outcome == 'verified'` only if every V10 check passed and V11 found both logs; any failure returns the specific `ProofCheck`. Paid results are judged at their time anchors, so an honest result fetched late still verifies | unit tests per check with vectors from `vectors/` (incl. another key's valid signature, header signer ≠ recovered, fabricated inputs); late fetch at +200 s and +2 h → `verified` |
| INV-14 | A requestId is never paid twice: a re-run with the same input resumes from the pending ledger unless `--new` | unit test on the pending ledger + e2e re-run |
| INV-19 | Every signed authorization's amount is counted against `dailyCap` from V6 until either chain-confirmed unused after validBefore (released) or settled (moved to spend); concurrent processes share one lock | unit test with two processes racing; `paid_but_rejected` and `settled_after_refusal` count as spend |
| INV-23 | The SDK never ends a call `settled_after_refusal` or `paid_but_rejected{missing_proof}` without first trying `getResult`; a non-2xx without a well-formed §10 body is `uncertain`, not `refused` | unit test: proxy 502 after a real settle → `verified` |
| INV-20 | The SDK never reports `not_charged` without reading `authorizationState(payer, nonce) == false` at a block whose timestamp > validBefore + 5 (or a confirmed `AuthorizationCanceled`) | unit test with a fake chain: lagging head, settle landing at validBefore − 1 |

## Enclave

| ID | Property | Checked by |
|---|---|---|
| INV-15 | The private key exists only in enclave process memory: no write to disk, no network, no log line, no message field contains it | code review checklist + a test that serializes every response type and greps for the key bytes; build has no filesystem writes |
| INV-16 | Same (request body, inputs) give byte-identical response bytes across runs and builds | property test over 1,000 random inputs run twice; cross-build check in S3 |
| INV-17 | The enclave signs a proof only over a responseHash it computed from bytes it produced in the same evaluation, and `inputsHash == keccak256(JCS(response.inputs))` | unit test: the evaluate path is the only caller of the signer |
| INV-22 | `configure` is accepted once per boot | unit test: second configure → `bad_frame`, binding unchanged |

## Cross-language

| ID | Property | Checked by |
|---|---|---|
| INV-18 | originHash, requestHash, responseHash, inputsHash, derived requestId, user_data, header grammars and both EIP-712 digests are identical in Solidity, TypeScript and Rust | `vectors/*.json` run by `forge test`, `pnpm test`, `cargo test` |
