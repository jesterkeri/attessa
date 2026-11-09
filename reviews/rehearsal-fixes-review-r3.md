# Rehearsal fixes — round 3 adversarial review

Reviewed `24adc883fb19e9ce3de91f332516ed65726cdc58..ab7395e`. This was a single-prompt review, not a blind U1 measurement; the U7 classification is therefore indicative only.

## Findings

No release-blocking finding found.

Round-2 M1 is closed. On a capped `eth_getLogs` response the reader now either obtains a configured creation transaction whose sender/nonce derives the registry address, whose returned block equals the recorded block, and whose address has code at head, or fails. It no longer infers a late boundary from a historical `eth_getCode: 0x`; the range scan starts inclusively at the proved creation block. Round-2 M2 is closed: the fallback cache is keyed by `Rpc` object identity, not its URL, and the two-connections/same-URL regression test covers the prior cross-chain omission.

The new item validation rejects non-list replies, malformed rows, wrong address/topic/range rows, and undecodable event payloads. Both changed consumers translate those failures to the FLOWS §8 `rpc_unavailable` path: all registry event reads in `registry.ts`, and the implicit-origin read in `signer.ts`. Explicit `--origin` still avoids the display-only event lookup. The deployment fixture test makes a non-null registry without a matching non-null creation record fail, including a future mainnet registry entry; it also compares the pinned Sepolia creation transaction/block with `docs/DEPLOYMENTS.md`.

The fake-chain adjustment adds the `blockNumber` that a real `eth_getLogs` row supplies; it does not relax a prior assertion. The two rehearsal fixtures exercise the normal capped scan and the recent-state-only Forno case separately. `docs/REHEARSAL.md` accurately says the log fix is a historic record, not an executable runbook, and names the same capped-range problem and test file as the implementation.

## Verification

Ran the required command successfully:

```text
pnpm --filter @attessa/cli lint && pnpm --filter @attessa/cli typecheck && pnpm --filter @attessa/cli test
```

Lint and typecheck completed with no diagnostics. Vitest completed successfully; the captured terminal output was truncated before its aggregate footer, so I cannot independently state the final file/test count. `git diff --check` also passed. No transaction was sent and no secret-bearing file was read.

## U1–U9 record

- **U1:** I inspected the revision, changed source, consumers, deployment metadata, and earlier r1/r2 reports before consulting the detailed prompt checks. Exposure to the full prompt in the same turn means this is not a blind review.
- **U2:** I traced the complete fallback: whole-range request, range classifier, head, configured-creation proof or no-record search, per-window requests, cache, all three registry event kinds, and the signer origin lookup.
- **U3:** Independently derived invariants were: a capped-history fallback must begin no later than the contract's actual creation and include that block; every detectable malformed/mismatched RPC answer must fail rather than become history; and an authoritative deployed registry must carry a verifiable creation boundary. The change meets them for the supported direct-creation deployments.
- **U4:** The new creation record flows from core deployment pins through `connect` into each reader; reader failures flow into the registry and signer FLOWS error paths rather than status, prompt, or send decisions.
- **U5:** New tests cover the prior omissions (false historical code, same-URL cache reuse, bad list items, bad decode, recorded-creation contradictions, and absent mainnet-style metadata). I found no weakened pre-existing behavioral test.
- **U6:** The design no longer relies on historical state being available from Forno: it uses the transaction-by-hash response Forno retains. If that proof is absent or inconsistent, it refuses the history rather than guessing.
- **U7:** 0 findings: 0 INSIDE, 0 OUTSIDE. Indicative only, because this was a single-prompt round.
- **U8:** I did not make live RPC calls, exercise a deployed Attessa registry, run a mainnet flow, or audit unrelated CLI/RPC consumers. A JSON-RPC provider can always omit otherwise valid logs; the reader can only fail closed for inconsistencies it can observe.
- **U9:** Scope was the rehearsal log reader, its direct consumers, metadata, documentation record, and tests. This is not approval of deployment, the deferred mainnet runbook, seller operation, or open gates.

REVIEW DECISION: SHIP
VERDICT: implementation-ready
