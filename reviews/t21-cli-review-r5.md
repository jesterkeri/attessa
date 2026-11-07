# T21 CLI round 5 review

Reviewed frozen commit `d7297ac` against `a49ffa1`.

## Result

No critical, major, or minor finding.

The input gate now rejects credentials in a parsed URL and, for deliberately accepted opaque source/URI text, rejects userinfo-shaped text and every `?` or `#` before either value can reach ABI construction or no-wallet/dry-run calldata output. `--origin` is separately constrained by `normalizeOrigin`; the other registration strings are stored in the local registration document, while only `--uri` is ABI-encoded. The two historical `EndpointAdded` event readers now use `rpcShownSafe(..., short(hash))`, so their prompt, error, success, and JSON consumers receive only `scheme://host[:port]` (or a short hash fallback), never the stored path, userinfo, query, or fragment.

The supplied five-test regression set passed at this commit. Applied as a disposable test-only patch to `a49ffa1` with the requested namespace import, all five assertions failed: opaque query/fragment source/URI inputs were accepted and both revocation paths rendered the raw event origin. This establishes the stated `5 failed` / `5 passed` baseline method.

## Verification and limits (U8)

`pnpm -r typecheck` and `pnpm -r lint` completed successfully. The required recursive test command stopped at core: an isolated verbose core rerun identified five oracle-test failures as `spawnSync cast EPERM`, a sandbox process-permission condition, rather than T21 assertion failures. The full CLI suite likewise exposed the documented 20-second listener-bound timeouts; the focused `npx vitest run test/codex-t21-r4.test.ts` completed with **1 file, 5 passed** in 1.66 s. I did not contact a real service/chain, send a transaction, or read environment, key, keystore, or credential files.

This was a scoped review, not an unscoped repository sweep. U2 checked the universal pre-encoding/output claims and stated test counts; U3/U4 followed both gated argument types through ABI planning and event-derived display consumers; U5 found no remaining untested consumer among the two shared event-reader helpers; U6 supports refusing credential-shaped opaque text before irreversible publication. Findings: INSIDE 0, OUTSIDE 0.

REVIEW DECISION: SHIP
VERDICT: implementation-ready
