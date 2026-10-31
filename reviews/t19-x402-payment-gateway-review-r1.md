# T19 adversarial review — r1

Reviewed commit `0575da5` against `8aa7938`, limited to `packages/gateway`. I read the changed implementation and tests before doing the binding-spec comparison; because the review request itself contained the concerns and invariants, U1/U7's independence measurement is indicative rather than blind.

Verification passed:

- `flock -w 1800 /home/hr/.cache/attessa-heavy.lock pnpm install --frozen-lockfile`
- `flock -w 1800 /home/hr/.cache/attessa-heavy.lock pnpm --filter @attessa/core build`
- `flock -w 1800 /home/hr/.cache/attessa-heavy.lock pnpm --filter @attessa/gateway test` — 9 files, 130 tests passed
- `pnpm --filter @attessa/gateway typecheck`

The first locked install reached the queue but failed in the review sandbox with pnpm's shared-store `EROFS`; the same mandated command then passed with the required filesystem approval. The heavy lock did not time out.

## Critical

None.

## Major

None.

## Minor

1. [OUTSIDE] The gateway accepts a correctly signed proof with an arbitrary future expiry instead of the required fixed 600-second proof lifetime. [packages/gateway/src/checks.ts:176](/home/hr/myvscode_linux/attessa/.worktrees/review-t19-r1/packages/gateway/src/checks.ts:176) only checks that `expiresAt` is later than `now`; it never requires `expiresAt == issuedAt + 600`. This breaks SPEC §2.3 (line 109: `expiresAt = issuedAt + 600`) and makes the gateway's step-9 proof validation incomplete (INV-9). Reproduce with the existing fake seller, which applies its `proof` tamper before signing: set `h.seller.tamper = { proof: p => ({ ...p, expiresAt: p.issuedAt + 601n }) }`, then call a normal paid request. The fake signs that altered proof, the gateway returns 200 and calls `/settle`. Add a rejection/no-settle test. The same fixed-lifetime rule is also not enforced by the core proof parser or `EnclaveRegistry.verifyProof`; that wider root is outside this diff (U9), but T19 must not accept it at the payment gate.

2. [OUTSIDE] A successful `/verify` response may omit `payer`, yet the gateway inserts and uses the unverified payload's `authorization.from` as the payer. [packages/gateway/src/gateway.ts:357](/home/hr/myvscode_linux/attessa/.worktrees/review-t19-r1/packages/gateway/src/gateway.ts:357)-[360](/home/hr/myvscode_linux/attessa/.worktrees/review-t19-r1/packages/gateway/src/gateway.ts:360) treats `vb.payer` as optional and assigns `payer = a.from`; SPEC §6.2 step 6 instead requires a `payment_verified` row with the payer from `/verify` (line 464). Reproduce with a facilitator that returns HTTP 200 `{"isValid":true}` for an otherwise valid authorization: the current code executes, writes the row and can settle, rather than rejecting malformed verification output with `payment_invalid{unexpected_verify_error}` and no row. Require a lowercase address `payer` in the valid response, compare it to the authorization's recovered/declared payer as appropriate, and persist that response value. Add the malformed-success response test.

## U2 completeness sweep

I searched the changed gateway source, tests, and the reconciler-fix commit for universal/completeness claims (`all`, `every`, `both`, `only`, `never`, `always`, `none`, `exhaustive`, `cannot`). The meaningful sets were the state lists, settlement logs, retry/send ownership, terminal states, route limits, and exports. I found no additional set-enumeration mismatch. The proof-validation claim above is a missing required member of the validation set.

## U5 / U8 limits

The suite has no test for either a non-600-second, validly signed proof or a 2xx `isValid:true` verify body without `payer`; those are the two findings above. I did not make live RPC/facilitator calls, inspect deployment/Caddy/systemd files outside the stated path, read environment/key files, or run an unscoped repository review. The accepted OPEN-QUESTIONS items were not re-reported.

## U7 classification

Inside prompt-stated concerns: 0. Outside prompt-stated concerns: 2. This count is indicative only, not a blind-review result, because the prompt exposed the concerns before the cold read.

Review outcome: REVISE
VERDICT: changes required
