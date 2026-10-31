# T15 seller-host and CLI review, round 2

## Findings

No critical, major, or minor findings.

## Round-1 findings

- **M1 fixed.** `packages/cli/src/commands/signer.ts:301-329` now rejects a malformed/non-uncompressed public key, future or stale timestamp, wrong release, and bad binding through `checkAttestation(..., true)` before `certSteps` can prepare cache transactions.  The renew-specific error mapping is preserved for late stale reports.
- **M2 fixed.** `packages/seller-host/src/config.ts:63-70` refuses a production `enclavePort` or listen port other than its fixed network port.  `packages/seller-host/src/enclave.ts:149-184` follows an already-configured `bad_frame` with `attest` and compares its parsed `user_data` to the requested chain, registry, agent, and origin binding before server startup.
- **m1 fixed.** `packages/seller-host/src/enclave.ts:72-94` parses every reply and rejects it unless its received bytes equal its JCS serialization.

## Verification and protocol notes

- `pnpm -r typecheck` passed for all workspace packages.
- The requested combined suite passed its framing/unit/adversary-r2 files and its non-socket adversary checks.  The remaining local-TCP framing tests timed out because the sandbox blocks their loopback peer; the run was stopped after that environment limitation was established.  The recorded prior test evidence was therefore not treated as a fresh complete pass (U8).
- U7: 0 INSIDE, 0 OUTSIDE findings. This is indicative only: the single-prompt review was not a blind cold read.
- I inspected all task-scope production changes and the direct core consumer added by the fixes; no network write, transaction, `.env`, keystore, or key file was read.

Decision: SHIP
VERDICT: implementation-ready
