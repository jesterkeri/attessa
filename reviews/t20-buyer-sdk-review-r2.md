# T20 buyer SDK review, round 2

## Findings

No critical, major, or minor findings.

## Round-1 M1 disposition

**M1 does not stand.**  The round-1 failures were caused by this review sandbox denying child-process creation, not by `packages/sdk/src/ledger.ts` degrading its SQLite mutex.

The lock adversaries in `packages/sdk/test/adversary-t20-r5.test.ts` and `packages/sdk/test/adversary-t20-r6.test.ts` create real child Node processes.  A minimal in-sandbox `spawnSync(process.execPath, ...)` probe fails before the child starts with `EPERM`; its captured result was `{ status: 0, stdout: "", stderr: "", error: "spawnSync .../node EPERM" }`.  That explains r5's empty holder output, r6's child reports without corresponding ledger writes, and the client/adversary timeout cascade.  It does not exercise `Ledger.acquire()` in a second process.

The remaining capability probes show no lock filesystem failure: the temporary directory reports `ext2/ext3`; a test file changed to mode `0400`; a stopped child remained observable via `kill -0` and resumed with `SIGCONT`; and the process limit is 47809.  The SQLite two-process mutual-exclusion probe could not run for the same child-process `EPERM`, so it is recorded under U8 rather than inferred as a ledger defect.  In contrast, the supplied outside-sandbox rerun on this identical commit passed all 14 test files and all 138 tests, including r5, r6, and the 6-process SIGKILL/SIGSTOP lock stress test.

`packages/sdk/src/ledger.ts:211-236` does not silently accept a known read-only mutex: it begins an immediate transaction, performs a write on that connection, and closes/refuses when that write is read-only.  On the normal Linux filesystem evidenced by the outside rerun, SQLite's `BEGIN IMMEDIATE` provides the required exclusion.  No evidence shows unavailable/emulated POSIX locking in the sandbox, and the sandbox's blocked child creation cannot establish such a source-level defect.

## Protocol notes

- U7: 0 INSIDE, 0 OUTSIDE findings. This is indicative only because this was a single-prompt review, not a blind cold-read measurement.
- U8: the complete SDK suite cannot be rerun inside this sandbox because its required child-process tests are denied with `EPERM`.  The filesystem/permission/signal probes above did run.  I relied on the supplied verbatim outside-sandbox suite result only for the parts impossible to execute here.
- No network write, transaction, environment file, keystore, or key file was read.

Decision: SHIP
VERDICT: implementation-ready
