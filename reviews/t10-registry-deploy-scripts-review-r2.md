# T10 registry deploy scripts review, round 2

## Findings

No critical, major, or minor findings.

## Round-1 findings

- **M1 fixed.** `scripts/check-deploy.mjs:35-49` now holds network-keyed SPEC pins for chain ID, IdentityRegistry, and SelfRegistry.  The post-deploy code splice and getter checks at `:407-447` use these fixed pins, while the editable TypeScript and Markdown rows are separately checked against them.  Changing both editable sources can no longer make a wrong registry constructor pair pass.
- **M2 fixed.** `contracts/script/DeployRegistry.s.sol:15-20` calls `_requireProductionStack` before broadcasting.  `contracts/script/DeployBase.sol:83-111` verifies full pinned P384/CertManager/NitroValidator runtime code, declared immutable slots, metadata tail, and internal wiring.  The deploy test rejects a look-alike validator, foreign P384, demo CertManager, and altered immutables before the registry constructor is reached.

## Review evidence

- The pre-deploy design is sound for the exact commands in `docs/DEPLOYMENTS.md`: it rejects committed `.env` files and unrecognized/altered Foundry TOML before Forge starts; compares effective Forge config to a fixed reference; recompiles committed blobs in a fresh tree; cleans/rebuilds the local tree; and byte-compares both creation and runtime code of production contracts and scripts.  Its reference build disables Git replacement objects and Foundry/DAPP environment overrides, and reads blobs rather than archive output.
- The post-deploy checker independently rebuilds the committed reference, verifies the SPEC pins, whole runtimes with immutable words spliced, getter wiring, CertManager owner/revoker, and `allowLocalOrigins == false`.
- `flock -w 1800 /home/hr/.cache/attessa-heavy.lock bash -c 'cd contracts && forge test --match-path "test/deploy/*"'` passed: 7/7 tests.
- `node scripts/check-deploy.mjs celo-sepolia` correctly refused the current TODO Admin row with exit 2; no RPC write or transaction occurred.

## Protocol notes

- U7: 0 INSIDE, 0 OUTSIDE findings. This is indicative only because this was a single-prompt review, not a blind cold-read measurement.
- U8: the sandbox blocks child-process creation.  `--pre-deploy` therefore stopped at `spawnSync git EPERM`, before any Forge command; the Node test loop failed because its local-Anvil child could not start.  These are environment limits, not implementation test failures.  The Solidity suite above ran normally.  No deployment, broadcast, `cast send`, environment file, keystore, or key file was used/read.

Decision: SHIP
VERDICT: implementation-ready
