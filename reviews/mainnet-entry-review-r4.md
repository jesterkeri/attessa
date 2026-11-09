# Mainnet entry review r4 — `2875ad3..0c6dc15`

Reviewed the frozen detached worktree at `0c6dc15`; the round-four delta is
`1567e61..0c6dc15`. No transaction was sent and no credential, `.env`,
`.npmrc`, key, or keystore was read.

## Findings

No critical, major, or minor finding.

## Required-check results

- **Round-3 dry-run finding: closed.** `cancel()` now calls
  `client.attributionReady()` before issuing its preview. That method obtains
  its `Net` through the same `net()` function a real cancellation uses, so it
  reads the RPC's reported chain ID and applies the same local-chain pinning or
  labelled-network mismatch check. On verified `42220`, an absent or malformed
  suffix produces the required refusal disclosure; other chains produce no
  attribution warning. The new local/42220/no-tag test fails against the r3
  source because the old dry-run returns before the RPC check and prints no
  line.
- A dry run with an unreachable RPC now returns the existing
  `rpc_unavailable` row, and one with a mismatched/unpinned RPC returns the
  existing `network_mismatch` row. This is a deliberate added chain read, not
  a signing side effect, and it is true: without the read the preview could not
  state whether the real cancellation is subject to the Celo attribution rule.
  A real cancel reaches the same `net()` check before its cancellation
  permission is signed.
- **Round-3 SDK gas-cap finding: closed.** `GasCapError` is explicitly
  preserved by `cancelAuthorization()` after its cancellation permission has
  been signed. The CLI catches precisely that error and reports
  `gas_over_cap`, accurately distinguishing the signed permission from the
  unsent transaction. The new SDK test fails against r3 because that source
  wraps the error in `CancelInterruptedError`; the CLI test then fails because
  r3 reports the false RPC-outage row instead.
- `gas_over_cap` has two reachable CLI origins and both claims are accurate:
  `tx.ts` catches it before a seller/owner/operator transaction signature and
  says “Nothing was signed”; `buyer.ts` catches it only after
  `cancelAuthorization()` signs the EIP-3009 cancellation permission and says
  that permission was signed but nothing was sent. The only two `gasTerms`
  callers are these paths. There is no remaining route by which this error
  becomes `Unexpected error`.
- I re-enumerated transaction sign/broadcast sites. CLI non-x402 writes go
  through `packages/cli/src/tx.ts:send`; SDK cancellation goes through
  `packages/sdk/src/client.ts:sendCancel`. Both choose attribution by the
  verified `chainId`, append it only on `42220`, and refuse absent/malformed
  suffixes before their transaction signature. Typed-data payment/cancel
  permissions are not transactions and remain unmodified.
- The changed test delta adds the two disclosed CLI cases and one SDK cap case;
  it does not weaken an existing assertion. The temporary fake asset is
  inserted only inside the test's `try` and deleted in `finally`.
- `DONE.md`'s r3 account accurately describes the two fixes and its stated
  test totals are plausible from the added cases. I could not independently
  reproduce the complete output in this sandbox; that limitation is recorded
  below rather than treating the claim as verified.

## U1–U9 record

- **U1:** This is a single-prompt review whose questions were visible before
  the cold read. The INSIDE/OUTSIDE count is therefore indicative, not a
  blind-review measurement.
- **U2:** I enumerated the two transaction signature/broadcast sites, the two
  `gasTerms` callers, and every CLI dry-run branch. The universal suffix claim
  holds for the real send sites; cancellation preview now uses the same chain
  resolution decision.
- **U3/U4:** Derived invariant: a preview that claims what a real mainnet send
  would do must resolve the same chain identity; and every gas-cap outcome
  must preserve whether a permission, transaction, or broadcast happened.
  The r4 paths satisfy both.
- **U5:** The added tests cover the two r3 reproductions. I found no changed
  production behavior without a corresponding regression test in this delta.
- **U6:** The added RPC read is appropriate: a dry run is not an assertion
  that no reads occur; it is an assertion that no side effect is signed or
  broadcast. Refusing an unavailable/wrong RPC is more truthful than making a
  mainnet-attribution promise from a user-controlled label.
- **U7:** Findings: **0 INSIDE, 0 OUTSIDE**. This is indicative only, not a
  blind-review result.
- **U8:** I opened every changed production/test file, all transaction send
  sites, all `gasTerms` callers, dry-run branches, the previous review, and
  the relevant DONE entry. I did not execute live RPC calls or inspect
  credentials. The requested complete command could not be reproduced here:
  this sandbox terminates foreground processes at roughly 30 seconds and
  terminates detached background children. A focused attempt invoked the
  package test script but Vitest began its whole SDK suite and hit the known
  process/lock limitation (`adversary-t20-r5` holder never entered); a direct
  one-file Vitest invocation was terminated at the foreground limit before a
  result. Build/typecheck/lint and full core/SDK/CLI results are therefore
  unverified in this review. No unrelated Solidity, enclave, gateway,
  seller-host, or whole-repository security audit was performed.
- **U9:** Beyond the stated fixes I swept all SDK/CLI transaction paths,
  error boundaries, and dry-run decisions. This was not an unscoped
  whole-repository audit.

REVIEW DECISION: SHIP
VERDICT: implementation-ready
