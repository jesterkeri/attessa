# T30 mainnet deployment review r2

Reviewed the T30-owned range `804f4aa..7edcc25` and the two later merge
commits at frozen `HEAD` `7de210c`. This review made no source changes and
did not sign, send, broadcast, deploy, or read a key.

## Result

No release-blocking finding remains from r1. The new mainnet route builds
each creation transaction as pinned init code, ABI constructor arguments, and
the ERC-8021 Schema-0 suffix; it writes that data and prints a `cast send
--create` command but contains no send or key-reading path. The command puts
all parent `cast send` options before `--create`, as Foundry's parser requires.

The r1 issue is fixed: `docs/DEPLOYMENTS.md:129-181` now mandates that tagged
route for all four Celo-mainnet creations, while `contracts/script/DeployBase.sol:148-183`
allows the Forge scripts to simulate on 42220 but refuses their broadcast or
resume contexts. This prevents the documented untagged Forge route from being
used on mainnet.

## Findings

None.

## Review notes

- `scripts/tagged-deploy.mjs:369-416` validates the mainnet chain ID, clean
  tree, cold-admin/deployer separation, previously deployed dependencies, the
  reference-build pins, and an estimate-derived gas cap before writing the
  0600 data file. It signs and sends nothing. It gives the generated command a
  keystore account and no private-key flag.
- `scripts/tagged-deploy.mjs:420-473` independently rebuilds and compares the
  complete mined creation input when `--tx` is supplied: reference init code,
  all constructor arguments, and suffix. It also checks a successful CREATE,
  sender, computed CREATE address, runtime code and wiring. It does not trust
  the prepared file.
- The four init-code suffix proofs cover runtime code, storage and relevant
  getters against untagged controls (`contracts/test/deploy/TaggedCreation.t.sol`).
  The local end-to-end check additionally used both the Celo attribution-tags
  verifier and `ox/erc8021` on each mined tagged creation.
- The explicit concern that a same-runtime CertManager could carry a different
  trusted root is not reproducible for this contract. The AWS Nitro root is
  compiled as constants and stored by the constructor (`CertManager.sol:40-47,
  102-121`); it is not a constructor parameter nor a mutable root setting.
  `check-deploy.mjs celo` performs the final whole-stack runtime, immutable,
  wiring, owner, revoker and `allowLocalOrigins == false` checks before the
  deployment record can be accepted.
- `scripts/*.test.mjs` are deployment-route evidence, not CI configuration;
  they exercise the directly relevant JavaScript path and were run explicitly
  below.

## Protocol checks (U1-U9)

- **U1:** This was a prompt-scoped adversarial review, so coverage is not
  represented as a repository-wide finding rate.
- **U2:** Traced the T30 diff, r1 finding and fix, tagged route, reference
  builder, command construction, post-check, Forge broadcast guard, Solidity
  suffix equivalence tests, E2E harness, deployment documentation and the
  later merge commits for dependencies of this route.
- **U3/U4:** The main invariants hold: exactly Celo mainnet is accepted by the
  tagged route; every documented mainnet creation has a suffix; the four
  constructor argument sets use pinned registries and `false` local origins;
  a Forge mainnet broadcast/resume is refused; and the final checker confirms
  the production runtime, immutables and cold-admin roles.
- **U5:** Tests cover malformed/missing tag refusals, dirty-tree and bad-chain
  refusals, pinned creation/runtime bytecode, unsafe output directories, gas
  cap, altered or absent creation data, the `cast` command parser, all four
  tagged-vs-untagged equivalence cases, and the local full route. The real
  mainnet broadcast remains intentionally untested and was not attempted.
- **U6:** A four-transaction deployment is necessarily non-atomic: a failed
  later step may leave prior components deployed. The documented sequence
  post-checks every step and the final checker refuses an incomplete or
  miswired recorded stack. This is an operational residue, not a path to an
  untagged registry creation.
- **U7:** Findings: **0 INSIDE, 0 OUTSIDE**.
- **U8:** Scope was T30 and direct dependencies only. No env file, keystore,
  secret or private key was read. All simulations were local; no transaction
  was broadcast or deployed. The initial sandboxed JavaScript test invocation
  could not spawn its internal `git` process (`EPERM`); the same read/build-only
  tests were then run under the approved restricted escalation and passed.
- **U9:** I challenged the r1 attribution assumption, the parser order,
  creation-input verification, reference-build pinning, suffix semantics and
  the mutable-state/root distinction rather than accepting the claims in the
  documentation. No general audit of unrelated application paths was done.

## Verification (U8 evidence)

The following commands ran in the frozen worktree. They only build/test
locally; the E2E command uses a temporary local Anvil chain with dev accounts.

```text
$ node --test scripts/tagged-deploy.test.mjs scripts/tagged-deploy.attack.test.mjs scripts/tagged-deploy.attack2.test.mjs
# tests 39
# pass 39
# fail 0

$ cd contracts && forge fmt --check && forge test
Compiler run successful with warnings.
All executed Forge suites passed; the only reported skips were the three
network-gated RealFixture tests. No test failure was reported.

$ node scripts/check-deploy.mjs --pre-deploy
REF   reference build from HEAD 7de210cae53d and nitro-validator 0ea0d12366b4fa44f9e07e4755f2ad36561cb674
PASS: contracts/out equals the reference build for P384Verifier, CertManager, NitroValidator, EnclaveRegistry, DeployValidatorStack, DeployRegistry

$ node scripts/tagged-deploy.e2e.mjs
E2E OK: all four tagged creations passed every check
```

The E2E output confirms all four mined local creations had `to = null`, their
full on-chain input equalled the emitted data, both independent ERC-8021
readers found the tag, their runtime/storage/getters matched untagged controls,
and `check-deploy.mjs celo` passed all 27 checks against that local stack.

REVIEW DECISION: SHIP
VERDICT: implementation-ready
