# Audit hygiene — Codex review r5

## Scope and result

**No findings.**

The literal requested range, `git diff $(git merge-base origin/staging HEAD)..HEAD`, is empty because reviewed commit `146f2f8` is now an ancestor of `origin/staging` (merged by PR #26). To avoid treating that race as evidence, I reviewed the hygiene changes in `146f2f8` against its parents, their current consumers, the live GitHub ruleset, and the completed Actions jobs for that exact commit.

The prior findings are closed:

- **r1 M1:** A named output missing or empty now exits 2; no-argument mode requires at least one conventional nonempty output; grep read errors exit 2. The required `ts` job builds and then scans the explicit `packages/site/dist` target.
- **r1 minor:** `README.md` and `docs/PAID-CALL.md` now distinguish an on-chain USDC transfer from the team's off-chain CLI/request record.
- **r2 M1:** The scanner uses byte mode (`grep -a`), and its NUL-prefixed binary credential regression fails as required.
- **r2 minor:** The harness job accurately calls itself `credential scanner self-test`, rather than pretending it scans a built site.
- **r3 M1 / r4 major:** The active ruleset `26156029` requires `credential scanner self-test` alongside `ts`, `contracts`, `slither`, `enclave`, and `guardrails`. The completed harness run for `146f2f8` emitted that exact job name and succeeded. The required-context migration is therefore complete.
- **r4 minor:** `github_pat_` is covered by both the scanner expression and a planted-token regression; the old non-blocking-scanner record is explicitly marked superseded.

## Verification

Passed locally:

```
./scripts/check-secrets.test.sh
./scripts/check-workflows.sh
./scripts/check-secrets.sh packages/site/dist
```

The scanner self-test covered clean, planted, binary/NUL, missing, empty, multiple-target, conventional-output, option-like-name, fine-grained-GitHub-token, symlinked-secret, and dangling-symlink cases. The workflow check reported `workflows clean`; the built-site scan reported `no credential-shaped strings in client output`.

Read-only GitHub checks showed the required contexts listed above and a successful `credential scanner self-test` job for the reviewed SHA. Read-only Celo receipt checks confirmed all eleven hashes in `docs/PAID-CALL.md` succeeded and each emitted the documented `0x2710` USDC `Transfer` from the agent wallet to the documented recipient. `README.md:121-125`, `docs/PAID-CALL.md:1-58`, `OPEN-QUESTIONS.md:6`, and `STATUS.md:6` consistently say there is no mainnet registry or live seller/API, that Gate 2 remains open, and that the hand-run calls are not user or seller use.

## Review-protocol record

**U1.** The detailed prompt was visible before inspection, so this is an adversarial single-prompt review, not a blind cold read.

**U2.** I enumerated scanner invocations, scanner input/error states, workflow job names, active required-status contexts, and all eleven documented transaction hashes.

**U3/U4.** Derived invariants were: a green scan must have a readable generated artifact; a self-test must be labelled as a self-test; and each required GitHub context must be emitted by the reviewed revision. The built-site `ts` scan, harness self-test, live ruleset, and completed Actions jobs satisfy them.

**U5.** The previous untested cases now have regression coverage, including fine-grained GitHub PATs. I found no changed scanner or workflow behavior without relevant test coverage.

**U6.** The control is now correctly split: the `ts` job tests the produced browser output, while a separately required self-test proves known bad inputs are rejected. Neither is relied on as a substitute for the other.

**U7.** Findings: **0 INSIDE, 0 OUTSIDE**. These counts are indicative only, not a rigorous measurement, because this was not a blind review.

**U8.** I did not run the full repository suite, alter the GitHub ruleset, or inspect deployment, seller, gateway, or enclave implementation. Celo receipts establish successful transfers and amounts, not the off-chain CLI invocation, RPC response, or service identity; the documentation correctly labels those as the team's record. No environment, npm configuration, keystore, key, transaction broadcast, or production mutation was accessed.

**U9.** This review covers the hygiene diff, its CI enforcement and public status/evidence language. It does not approve the open gates, deployment, or operation of a paid service.

REVIEW DECISION: SHIP
VERDICT: implementation-ready
