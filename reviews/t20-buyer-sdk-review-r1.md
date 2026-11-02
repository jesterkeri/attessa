# T20 buyer SDK review, round 1

## Major

- **[INSIDE] The required lock/concurrency verification fails in the frozen worktree.** `packages/sdk/src/ledger.ts:82-94` is the sole cross-process critical section on which V6's daily-cap reservation and INV-19 rely.  The prescribed command `flock -w 1800 /home/hr/.cache/attessa-heavy.lock pnpm --filter @attessa/sdk test` fails its real-process lock adversaries: `test/adversary-t20-r6.test.ts` reports `{ overlaps: 0, lostWrites: 6 }` where no returned write may be lost, and `test/adversary-t20-r5.test.ts` cannot enter the read-only-lock holder.  The client/adversary suites also time out at 30 seconds rather than completing.  This leaves the claimed “138 passed” evidence unsubstantiated and, specifically, leaves the daily-cap/single-writer proof required by SPEC §7 V6 and INV-19 broken.  Reproduce with the prescribed command above; do not accept the implementation until the lock adversaries pass in this exact worktree.

## Verification and protocol notes

- `pnpm -r typecheck` passed for all five workspace packages.
- I inspected the full SDK diff, ledger locking/reservation lifecycle, signing path, settlement confirmation, proof verification, and all SDK tests.  No additional source-level exploit was confirmed beyond the failed mandatory verification.
- U7: 1 INSIDE finding, 0 OUTSIDE. This is indicative only because this was a single-prompt review, not a blind cold-read measurement.
- U8: I stopped the SDK test run once the systemic failures were established, rather than wait for every independently timed-out file.  Its initial failures are recorded above; I did not verify the prompt's stated 138-pass result.  No network request, transaction, environment file, keystore, or key file was read.

Decision: REVISE
VERDICT: changes required
