# T19 review, round 1

## Major

- **[INSIDE] Serial chain reconciliation can miss INV-11's terminal deadline.** `packages/gateway/src/reconciler.ts:88-97` awaits `reconcileSettlement` for every open row in creation order; each invocation then awaits up to two `getLogs` calls and a block/state read (`:100-151`).  Although re-sends are now started in the background, the next timer tick shares `this.running` (`:74-81`) and cannot start another pass until this serial chain sweep finishes.  This breaks SPEC §6.3's “every 5 s” reconciler and INV-11's requirement that every row be terminal by `validBefore + 60 s`; it also delays the subsequent `settled` → `delivery_failed` sweep at `:101-107` past its 30-second bound.

  Reproduction: create four `settle_pending` rows with a near-term `validBefore`, make the fake chain's `getLogs` take 10 seconds (the production RPC transport itself permits a 10-second timeout), and invoke `reconciler.tick()`.  Each row's two serial log queries consume about 20 seconds before the following row can reach the expiry check.  The fourth row is not examined until roughly 60 seconds after the pass began; interval ticks cannot help because they await the same `running` pass.  A `settled` row with `updated_at` older than 30 seconds behind those rows likewise remains `settled` beyond the delivery grace.  No test covers a slow chain read or a batch of open rows; the adversary tests cover only slow facilitator re-sends.

## Verification and protocol notes

- Required setup passed: `flock -w 1800 /home/hr/.cache/attessa-heavy.lock pnpm install --frozen-lockfile`; `flock -w 1800 /home/hr/.cache/attessa-heavy.lock pnpm --filter @attessa/core build`.
- I inspected the whole T19 gateway diff, its route/state-machine consumers, all existing gateway tests, and the T19 task's required case list.  The newly found deadline path has no corresponding test (U5).
- U7: 1 INSIDE finding, 0 OUTSIDE.  This is indicative only: this was a single-prompt review, not a genuinely blind cold-read measurement.
- U8: `pnpm --filter @attessa/gateway test` could not complete in the sandbox because its localhost fake facilitator was blocked, causing 20-second test timeouts.  After stopping that environment-only run, two approved escalated exact reruns and the subsequent typecheck command could not start at all because the execution service returned `CreateProcess ... No such file or directory` before launching a process.  Thus I could not independently verify the gateway test/typecheck claims; their prior DONE.md evidence was taken only as recorded evidence.

Decision: REVISE
VERDICT: changes required
