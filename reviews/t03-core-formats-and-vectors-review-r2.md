# T03 core formats and vectors — adversarial re-review r2

Reviewed `7de40fe..c6f5fdb`, with particular attention to the post-r1 range
`e2aeb15..c6f5fdb`.  U7 is indicative only: the task concerns and binding
material were present in the review prompt, so this was not a blind U1
measurement.

## Critical

None.

## Major

None.

## Minor

None.

## Round-1 findings

- **M1 — fixed.** `pnpm -r lint` now completes successfully: each workspace
  package exposes its lint command, including `packages/core/package.json:8-14`.
- **M2 — fixed.** `scripts/check-vectors-oracle.py:1-651` imports neither
  `@attessa/core` nor `viem`.  It reconstructs all committed vector-family
  values from raw inputs, invokes `cast` only for Foundry's ABI/Keccak and
  EIP-191 primitives, implements JCS, ECDSA recovery, header parsing, and
  UTS-46 itself, and verifies the pinned Unicode-16 data-file SHA-256 values.
  The independent run completed `checks: 461 fails: 0`; the mutation run
  completed `survivors: 0 of 24`.

## Focused review notes

The UTS-46 implementation follows the required non-transitional path for the
reviewed vectors: it maps from the pinned IDNA table, NFC-normalizes using the
vendored Unicode data, performs ContextJ and Bidi validation, and checks the
WHATWG-special-scheme origin cases before accepting an origin.  The core
correction in `packages/core/src/origin.ts:34-44` applies ContextJ separately
for every ZWNJ and limits that correction to special schemes at lines 60-61.

`tr46/lib/regexes.js` is an internal module, but this use is sound for the
frozen dependency set: core directly pins `tr46` to `5.1.1`
(`packages/core/package.json:15-19`), the lockfile resolves the same version
for `whatwg-url@14.2.0`, and the imported expressions are precisely the
Unicode-16 data expressions used by that installed release.  Any future tr46
upgrade must revalidate this internal import and the ContextJ differential
tests; no version drift exists in this tree.

## U8 — not checked / execution limits

I read the changed core source, vector generator and fixtures, oracle,
mutation harness, adversary probes, lockfile dependency resolution, and the
binding SPEC/ADR/invariant material.  I did not read environment or key files
and made no network writes.  The Rust origin implementation does not exist in
this task tree, so the Rust third of INV-18 for origins cannot be checked here.
Solidity and Rust vector consumers likewise are not yet available for an
end-to-end cross-language execution.

The exact locked core test command was attempted once.  It ran 62/67 tests,
then five assertions that spawn `cast` failed with `spawnSync cast EPERM`;
the individual core, vector, and oracle assertions otherwise passed.  A
direct locked oracle run succeeded (`461` checks, `0` failures), as did the
direct locked mutation run (`0 of 24` survivors), so this is recorded as an
execution-environment limitation rather than a code finding.  `pnpm -r lint`
completed successfully.

## U7 / U9

U7 finding count: INSIDE 0, OUTSIDE 0 (indicative, not a blind-review metric).
The review was limited to the requested T03 units; no unscoped repository sweep
was performed, and no out-of-scope root finding arose from the inspected diff.

VERDICT: implementation-ready
