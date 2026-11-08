# T21a `attessa verify` review — round 3 (`1791ac9`)

Scope: `git diff 2c82641..1791ac9`, excluding the separately reviewed site merge as directed. This was an adversarial source, test, consumer, and regression review of the verifier, its ledger state, the changed site copy/tests, and the new DONE evidence.

U1 note: a truly blind review is impossible from this single task prompt because it identifies the previous finding and the intended fix. I treated that information as a hypothesis to disprove, and independently traced all changed behavior and relevant consumers.

## Critical findings

None.

## Major findings

None.

## Minor findings

None.

## Round-2 finding reconciliation

**M1 — fixed.** The former reserved-call settlement row passed `null` as its link. At the parent it is demonstrably so: `git show 2c82641:packages/cli/src/commands/verify.ts` shows `set(..., null)` for “nothing was signed”. The current code passes `addr(chain.registry)` at [verify.ts:158](../packages/cli/src/commands/verify.ts#L158), which resolves to the proper chain-specific Celoscan registry link for Sepolia and mainnet and to `null` for `--network local` ([verify.ts:114](../packages/cli/src/commands/verify.ts#L114)).

The regression test at [verify.test.ts:330](../packages/cli/test/verify.test.ts#L330) checks text and JSON output, requires the explorer URL, and constructs a real ledger shape: a newly reserved pending entry has `state: "reserved"`, `nonce: null`, and `settlementTx: null`. The same test would fail on the parent version.

## Contract and consumer checks

- I checked all changed `attessa verify` site statements against the parser and verifier. The command is implemented; it accepts `--network` and `--json`; it performs the six described checks; and a bare run is intentionally incomplete if the buyer did not retain a proof header and response. The reference and tutorial state that qualification explicitly, including the two required flags, rather than promising a full bare verification.
- “The demo service is not available yet” remains true. The remaining unavailable-command markings (MCP / optional buy flow) remain present. No changed page still calls `verify` “Coming”.
- The site-test transition is not a weakening: tests which previously protected the then-true “verify is unbuilt” condition now protect the opposite shipped condition and validate displayed commands/flags against the CLI. Removing the tutorial from the generic unbuilt-offering list is justified because it no longer offers an unbuilt command; other unavailable offerings remain covered.
- The changed DONE entry accurately says T21a is still unticked pending the distinct real paid-Sepolia/T22 run. That limitation is disclosed rather than hidden. No secret/credential path was introduced.

## Protocol coverage and limitations

U2/U3: I enumerated the materially different paths: local ledger payment, reserved/no-signature entry, settlement transaction input, Sepolia, mainnet, local, proof/response supplied, and proof/response absent. The resulting invariants are that a public-network row has the correct Celoscan URL, a local row has none, and an incomplete bare verification cannot report a full verified result. The changed code and tests preserve them.

U4/U5: Consumers checked were CLI text output, JSON output, the persisted pending ledger, site reference/tutorial/index/explorer pages, site snapshots, and DONE evidence. I found no changed consumer that assumes the old null reserved link or the old “Coming” claim.

U6/U9: I did not assume a site label itself proves readiness; the actual command and its retained-input requirements were traced. This review is limited to the task diff; unrelated pre-existing verifier and chain code are not re-approved by this verdict.

U7: Findings inside changed scope: 0 critical, 0 major, 0 minor. Findings outside changed scope: 0.

U8: The prescribed build, typecheck, and lint completed successfully. Outside the sandbox (which otherwise prevents the local test gateway from binding), the full CLI suite passed: 88 files / 376 tests; the full site suite passed; `packages/site/test-count.sh` exited 0; and the focused verifier run passed. No real Sepolia call or RPC request was made, by design: T21a remains pending T22 and is not claimed complete. The sandbox’s documented inability to start `cast` was not relevant to this diff.

Decision: SHIP
VERDICT: implementation-ready
