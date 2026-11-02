# Gateway CI timing review — round 1

Reviewed frozen commit `4f42df3` against `origin/staging...4f42df3`, SPEC §6.1–§6.3, INV-11, and the project test-preservation rule.

## Findings

### Critical

None.

### Major

None.

### Minor

None.

## Assessment

The in-flight-cap test preserves every behavioral assertion: exactly 16 successful paid evaluations, exactly one 503, exact `gateway_busy` error, and exactly 16 settlement calls. `packages/gateway/test/evaluate.test.ts:372-384` changes only the harness configuration from its intentionally abbreviated 400 ms settle / 2 s verify limits to a copied production timeout set. The 17th request is still concurrent with the first 16 and still must be rejected by the production cap; a broken cap yields 17 successes (or a test timeout), not a pass. The 250 ms seller delay remains, so the test continues to exercise a genuinely occupied in-flight window.

The reconciler test also preserves its proof of one resend per row. `packages/gateway/test/adversary-t19-r2.test.ts:106-120` waits up to five seconds for the exact pre-release count of four sends, then awaits both ticks and again requires exactly four. Thus two resends per row (or a sequential second pass started after release) fails the final assertion; the wait only removes the prior unsound assumption that all four sends reach the fake facilitator within 50 ms.

The `holdable.release()` ordering change at `adversary-t19-r2.test.ts:31-34` is necessary for the test harness's stated model: it stops future holds before resolving the existing held answers. Without it, a facilitator answer that reaches the wrapper after `held.splice(0)` but before `hold` is cleared is added to a new, never-released queue, making the test hang. Its four call sites retain their intended behavior: the first two prove late answers cannot overwrite terminal chain evidence, the concurrent-ticks case proves the resend count, and the final holdable case does not set `hold`. No production code changes.

`vi.waitFor` cannot mask a duplicate resend in this structure. An early count of four is insufficient by itself, but the post-release `Promise.all([a, b])` and second `expect(f.sends).toBe(4)` catch an extra send started by either tick. A duplicate occurring before the first condition produces a count above four and causes the wait to fail.

The DONE record's numerical claims agree with the source: the target files contain 46 tests, the gateway suite's recorded 154 tests is unchanged, the documented short harness values are 400 ms settle and 2 s verify, and the production values imported by the cap test are 15 s and 10 s. The change contains no removed assertion, skipped test, test filter, or altered gateway behavior.

## Verification

- `pnpm --filter @attessa/gateway typecheck`: passed.
- `git diff --check origin/staging...4f42df3`: passed.
- Recorded evidence in `DONE.md` reports three successful one-core/four-burner target-file runs, two successful two-core full workspace runs, gateway typecheck/lint success, and eight mutation results with no regression in detection.

## U1–U9 record

- **U1:** This was a single-message review; a genuine pre-prompt cold-read measurement was not possible. U7 is indicative only.
- **U2:** Enumerated the cap test's five preserved assertions, all four `holdable` call sites, and both pre- and post-release resend-count checks. No universal timing or coverage claim omitted a changed path.
- **U3/U4:** The independently derived requirements are that timing changes cannot convert a cap violation to success, that no resend can be silently added after a count check, and that an in-flight fake answer can always be released. Each remains enforced.
- **U5:** Both changed behaviors are the direct subjects of the affected tests; there is no untested production behavior in this diff.
- **U6:** Production timeouts are the correct test configuration for asserting production concurrency semantics; shortened harness deadlines had converted scheduler delay into unrelated verify/settle outcomes.
- **U7:** Findings: INSIDE 0, OUTSIDE 0. This is a weak signal under U1's single-prompt limitation.
- **U8:** A one-core/four-burner target run reached Vitest startup but exceeded this sandbox's 30-second command window; cleanup completed and no burner remained. A normal targeted Vitest invocation likewise did not return a final result within that command window. I therefore could not independently reproduce the old/new starvation comparison here and rely on the recorded outside-sandbox stress runs. No network calls, transactions, environment files, credentials, keystores, or keys were accessed.
- **U9:** I swept the complete changed test and DONE-record paths plus their direct gateway configuration and reconciler consumers. I did not conduct an unscoped audit of unchanged gateway functionality.

Decision: SHIP
VERDICT: implementation-ready
