# Website finish review, round 3 — `48fdee6`

Scope: `081a402..48fdee6` (the r2 M1 regression test, the explorer fix, and its DONE evidence). This is not a blind review: the task supplied the r1/r2 reviews and their findings.

## Critical

None.

## Major

None.

## Minor

None.

## Round findings and adversarial checks

- **r2 M1 — fixed.** `packages/site/src/static/assets/explorer.js:102-108` now rejects every pinned-token `AuthorizationUsed` or `Transfer` log unless its `transactionHash` equals the queried hash. It also rejects a supplied log `blockHash` which differs from the already-validated receipt block. The x402 decision at `:127-129` therefore cannot use an authorization spliced from another transaction, and a transfer cannot be unanchored or foreign either. A missing log transaction hash is rejected, rather than treated as unknown.

  Reproduction: changing the real fixture's `AuthorizationUsed.transactionHash` to a different 32-byte hash returned `settled` when the `081a402` explorer blob was evaluated, and returns `badanswer` at `48fdee6`. The five test cases at `packages/site/test/explorer-live-errors.test.mjs:120-142` cover a foreign, absent, and wrong-block authorization plus an absent and wrong-block transfer; the old source has no checks for any of those authorization/block fields, and treats a missing transfer hash as acceptable. They pass here. The real recorded x402 settlement still passes (`explorer-live-recorded.test.mjs`: 12/12), including its same-token AuthorizationUsed/Transfer precondition.

- **r1 M2 — remains fixed.** The disclosed deletion of `cdn-integrity.test.mjs` is a strict improvement for the property it formerly protected. The former test merely required SRI for selected external script/style URLs (and explicitly exempted Google Fonts); the replacement at `packages/site/test/no-third-party-origins.test.mjs:29-98` rejects CDN names across emitted assets and remote resource/CSS references, validates CSP inline-script hashes, validates vendored-font digests, and checks the GitHub Pages artefacts. There are no longer external resources for SRI to protect.

- **r1 m1 — remains fixed.** The previously reviewed legal/font-provenance correction is untouched by this three-file fix diff. No new site claim, third-party request path, or rendered settlement consumer was introduced.

## Claims and evidence

The new DONE entry at `DONE.md:2880-2897` accurately describes the implementation and test cases. The source checks each named event family before it contributes to a settlement. `git diff --check 081a402 48fdee6` is clean. The entry's recorded all-green run is compatible with the test layout: the current source has the stated 75 test modules, and its claimed 268 tests includes the three build-spawning modules.

## Verification and limitations (U8)

Under the prescribed heavy lock, `pnpm -r build`, `pnpm -r typecheck`, and `pnpm -r lint` passed. `pnpm --filter @attessa/site test` ran 72/75 modules successfully; the three failures (`config.test.mjs`, `no-third-party-origins.test.mjs`, and `pages.test.mjs`) are this review sandbox refusing their child Node build with `spawnSync .../node EPERM`, before their assertions run. The direct new-explorer suites passed: 18/18 error-path tests and 12/12 recorded-fixture tests.

`./packages/site/test-count.sh` consequently reports 75 modules, 243 executed tests, and those same three sandbox failures. `./scripts/check-install-scripts.sh` could not be independently rerun because its pnpm fetch failed DNS resolution (`EAI_AGAIN registry.npmjs.org`); no package was installed. These are environment limitations, not observed implementation failures. No network request to a third-party service or transaction was sent during the review.

Decision: SHIP
VERDICT: implementation-ready
