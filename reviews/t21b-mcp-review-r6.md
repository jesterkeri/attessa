# T21b MCP secrets review — round 6 (`fb4da64`)

Scope: `git diff bb56af3..fb4da64`, covering the new process-environment handling, result renderer, tests, and their stated secret-design boundary.

U1 note: this cannot be a blind review because the prompt identifies the prior findings and proposed repair. I treated them as hypotheses, traced the current paths independently, then compared the predecessor only to establish regressions.

## Critical findings

None.

## Major findings

None.

## Minor findings

None.

## Round-5 reconciliation

- **M1 fixed.** [server.ts:317](../packages/mcp/src/server.ts#L317) now normalises escaped text to a bounded fixed point and fails closed at either resource bound. [server.ts:347](../packages/mcp/src/server.ts#L347) covers standard and URL-safe base64 across all byte alignments, plus hex (and decoded hex-key bytes). The final scan at [server.ts:406](../packages/mcp/src/server.ts#L406) applies those checks after serialisation. The prior universal/closed language was removed; the code and OPEN-QUESTIONS now expressly describe a best-effort, enumerated boundary.
- **M2 fixed.** [server.ts:174](../packages/mcp/src/server.ts#L174) separates the two consumed paths from secret values. [server.ts:269](../packages/mcp/src/server.ts#L269) derives typed, resolved, realpath, `safe()`, and home-relative forms; [server.ts:291](../packages/mcp/src/server.ts#L291) removes whole path values without treating short paths as unsafe secrets. The result-path tests cover both configuration paths and CLI-originated errors.
- **Minor 1 fixed.** The former permissive alternative outcome has been replaced by one explicit expected outcome per spelling in [mcp.test.ts:655](../packages/mcp/test/mcp.test.ts#L655), and unknown-tool non-echoing is independently asserted at [mcp.test.ts:688](../packages/mcp/test/mcp.test.ts#L688).

## Adversarial checks

- The private key and keystore password are copied before deletion from `process.env` in [env.ts:12](../packages/mcp/src/env.ts#L12), and the MCP command path receives that private copy. Imports precede that call, but the reviewed imported code has no module-load environment read; no child process is launched by this path.
- Mixed percent/JSON escaping is caught by fixed-point readings; a percent-encoded base64 value is decoded before its base64 form is checked. Encoded forms below eight characters, arbitrary encodings, and split values remain excluded exactly as the disclosed design says; this is not presented as a closed guarantee.
- Path matching deliberately avoids partial-word/child-path corruption, while testing all forms which the CLI itself can emit. `ATTESSA_KEYSTORE` and `ATTESSA_DATA_DIR` therefore cannot reappear as ordinary result text or as a CLI error path.
- The new DONE count is source-supported: the focused MCP suite contains 66 tests and passed as stated. No key, credential, `.env`, `.npmrc`, keystore, transaction, or real service was used in this review.

## Protocol coverage and limitations

U2/U3: I enumerated raw, escaped, repeated-escaped, base64, URL-safe-base64, hex, private-key, password, RPC-piece, declared-redaction, keystore-path, and data-path result inputs. The resulting invariant is that every representation the stated matcher covers either stays structurally redacted or produces the fixed withheld result, without changing a numeric/hash protocol value.

U4/U5: I followed values through the stdio entry point, `deps.env`, wallet loading, CLI result/error capture, serialisation, and every MCP tool's common `text()` route. I also inspected the replacement r3 tests rather than treating their changed outcomes as sufficient evidence.

U6/U9: This is a documented best-effort redaction boundary, not a proof that no reversible representation can ever exist. The exclusions are owner-disclosed and accurately match the code; this verdict does not expand the review to arbitrary third-party dependencies or unrelated CLI behavior.

U7: Findings inside changed scope: 0 critical, 0 major, 0 minor. Findings outside changed scope: 0.

U8: `pnpm --filter @attessa/mcp test` passed: 1 file, 66 tests. The prescribed full CLI suite could not complete in this frozen worktree because its nitro-validator submodule is uninitialised (`-0ea0d123...`), so `test/attestation.test.ts` cannot open its required fixture; 86 files / 346 tests passed before that unrelated checkout failure. I did not initialise or alter the frozen submodule. A foreground global typecheck/lint attempt exceeded this terminal's foreground limit before completion, so I do not claim an independent global result; the changed MCP code was compiled by its passing test suite. No external network request was made.

Decision: SHIP
VERDICT: implementation-ready
