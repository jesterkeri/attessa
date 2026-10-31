# T03 adversarial review r1

Reviewed `7de40fe..e2aeb15`.  U7 is indicative only: the prompt and its
concerns were available in the same turn, so this was not a blind measurement
under U1.

## Critical

None.

## Major

1. **[OUTSIDE] The frozen T03 branch fails the mandatory repository lint
command.** Every package manifest in this worktree lacks a `lint` script (for
example `packages/core/package.json:8-12`); this branch does not contain the
T02 follow-up that added them.  Consequently the exact AGENTS.md command
`pnpm -r lint` cannot run, violating a prerequisite that every later task must
preserve.  The root cause predates this prompt's commit range, but the review
protocol U9 requires reporting it because this is the tree that would be
accepted/integrated.

   Reproduction (run in this frozen worktree):
   `pnpm -r lint` exits 1 with
   `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT None of the selected packages has a
   "lint" script`.

2. **[INSIDE] The cross-language vectors have no independent oracle for the
values that protect INV-18.** `packages/core/scripts/vectors.ts:1-3` explicitly
computes every expected hash, binding, digest, and header from the same
`@attessa/core` functions under test.  `packages/core/test/vectors.test.ts:46-50`
then only compares the committed JSON to a fresh run of that generator, and
lines 56-135 recompute every output using the same functions again.  Apart
from selected origin/JCS strings, no independently derived expected digest is
asserted.  A defect in e.g. the request concatenation, ABI layout, or typed
data fields can therefore be regenerated into all five committed vector files
and pass TypeScript; Solidity and Rust would be taught the same wrong value.
That breaks the role assigned to vectors by INV-18 and the task prompt: a
wrong expected vector is treated as a protocol bug, not a TypeScript
implementation detail.

   Reproduction: alter `requestHash` to omit either `0x00` separator, run
   `pnpm --filter @attessa/core gen:vectors`, then run
   `pnpm --filter @attessa/core test`.  The regenerated vectors and the same
   implementation agree, so the suite has no fixed, independently calculated
   expected request digest to reject the protocol change.  Retain the
   regeneration check, but add fixed values derived independently (for
   example from literal byte strings/ABI words and independently reviewed
   EIP-712 hashes) for every vector family.

## Minor

None.

## U8 — not checked

I read all changed core source, generator, tests, committed vectors, and the
binding SPEC/ADR/invariant material.  I attempted the required
`pnpm install --frozen-lockfile`, but it could not acquire the mandated heavy
command lock; no `node_modules` directory was created.  The requested core
test therefore could not run (`vitest: not found`).  I did run the lightweight
lint reproduction above.  Solidity and Rust vector consumers do not yet exist
in this T03 tree, so cross-language execution was not possible.  I did not
read environment or key files and made no network writes.

U7 finding count: INSIDE 1, OUTSIDE 1 (indicative, not a blind-review metric).

REVISE: restore the command invariant and make vector expectations independent.
VERDICT: changes required
