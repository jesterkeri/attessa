# T10 deploy record, SDK pin, and INV-19 review — round 2

Reviewed frozen commit `cd723b0` against the full T10 follow-up (`e6777fa..cd723b0`), SPEC §2.6, §3.5, §7, INV-19, T10/T01, and docs/DEPLOYMENTS.md.

## Findings

### Critical

None.

### Major

None.

### Minor

None.

## Round-1 finding

- **m1 — fixed.** `packages/sdk/src/types.ts:24-35` now exactly describes the implementation at `packages/sdk/src/client.ts:136-150`: `registry` is a fallback only for a known `deployments.ts` chain whose registry is null; a pinned chain, including `network: 'local'` on a fork retaining that chain ID, ignores it; and a chain ID with no deployment entry is refused as `network_mismatch` regardless of the option. `packages/sdk/test/adversary-t10-sdk-doc.test.ts:43-60` covers the null mainnet fallback, local mainnet fork fallback, bare 31337 refusal, and named-Sepolia chain-mismatch refusal.

## INV-19 assessment

The `alive()` change in `packages/sdk/test/helpers/lock-stress-child.ts:39-46` is sound and does not permit a real concurrent critical section to be reported as safe.

- `/proc/<pid>/stat` field 3 is `rest[0]` after the final `") "` delimiter, and field 9 (flags) is `rest[6]`; the parser therefore tests the intended state and `PF_EXITING` bit `0x4`.
- Linux sets `PF_EXITING` before `exit_files()`, which releases the killed process's fcntl locks. That early flag is safe here because the marker is examined only *inside* `ledger.withLock`'s callback. A successor cannot reach that callback until its SQLite `BEGIN IMMEDIATE` has acquired the file lock, necessarily after the deceased holder's `exit_files()` release. The exiting process cannot execute further user code, so deleting its leftover marker at that point cannot conceal overlap.
- A SIGSTOP holder remains alive (state `T`, no `PF_EXITING`), retains the SQLite lock, and is still checked again after SIGCONT. A kill while stopped reaches the same safe released-lock/exiting path. `ledger.test.ts:72-94` additionally requires no violation log, successful slots, every returned write present, and at least one in-critical-section kill and stop.

The stress helper does not alter `packages/sdk/src/ledger.ts`; the actual cross-process mutex remains a SQLite `BEGIN IMMEDIATE` transaction. The recorded adversary evidence further confirms deliberately broken no-lock, early-release, and stale-takeover variants still produce violations. Thus the correction removes a process-lifecycle false positive rather than masking an INV-19 failure.

## Record and merge assessment

The deployment record, CLI/SDK harness pins, CI submodule checkout, and pin-first runtime fix remain consistent with round 1. `bash /home/hr/myvscode_linux/attessa/.worktrees/prompts/bin/pr-ready.sh` passed: review records and workflow guards are clean, the pack check passes, and `DONE.md` is confirmed to contain staging as a prefix. The DONE reordering moved complete entries without altering their evidence or verdicts; the merge itself has no file changes.

## Verification

- `pnpm -r typecheck`: passed in all five workspace packages.
- `bash /home/hr/myvscode_linux/attessa/.worktrees/prompts/bin/pr-ready.sh`: passed all reported checks.
- The new SDK documentation adversary file passed locally (4 tests).
- Recorded outside-sandbox evidence at `964dc4a` reports the complete workspace suite passing, including SDK 16 files / 144 tests, plus the INV-19 stress run passing 30/30 under load.

## U1–U9 record

- **U1:** This was a single-message review; prompt-independent cold-read measurement was not available, so U7 is indicative only.
- **U2:** Enumerated every `registry` resolution branch (named network, local mapped chain, null registry, and no deployment entry), both changed `alive()` predicates, the stopped/resumed path, and the changed record entries.
- **U3/U4:** Derived requirements are that local forks inherit the reported chain's immutable pin; unknown chains cannot borrow a pin or override; and a lock-test oracle may discard a dead marker only after the actual mutex is free. The implementation meets all three.
- **U5:** The doc wording has direct adversary coverage. The lock change is exercised by the existing kill/stop stress test and its deliberate broken-lock adversary variants.
- **U6:** Treating a kernel-exiting task as able to run the critical section would make the test incorrect; the safe boundary is the SQLite acquisition followed by the marker check, which this design preserves.
- **U7:** Findings: INSIDE 0, OUTSIDE 0. This is a weak signal under U1's single-prompt limitation.
- **U8:** The complete SDK run could not complete in this sandbox: its child-process lock adversaries r5/r6 fail before their holders enter, as expected under the sandbox's child-process restrictions, and the INV-19 stress itself needs real child processes. I therefore relied on the recorded outside-sandbox run for those tests. No network action, environment file, credential, keystore, or key file was read.
- **U9:** I swept the entire follow-up diff and direct ledger/pin/record consumers, including the staging merge and record order. I did not perform a separate unscoped audit of unchanged T15/T19/T20 feature implementations.

Decision: SHIP
VERDICT: implementation-ready
