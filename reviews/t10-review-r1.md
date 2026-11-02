# T10 adversarial review r1

Reviewed `8aa7938..c92aa6e`. U7 is indicative only: this was a single-prompt
review, not the staged blind measurement required by U1.

## Critical

None.

## Major

1. **[INSIDE] `check-deploy` treats the two security-critical registry
addresses as self-authenticating configuration, rather than the immutable
SPEC §3.5 pins.** At `scripts/check-deploy.mjs:255-264`, the expected runtime
is constructed from `core.identityRegistry` and `core.selfRegistry`. Lines
257-258 only require those mutable values to equal the Markdown rows; neither
is compared to the Sepolia constants in SPEC §3.5 (or to the deploy-script
constants in `contracts/script/DeployBase.sol:29-30`). Consequently an edited
`deployments.ts` and `DEPLOYMENTS.md`, plus a registry deployed with the same
two attacker-selected immutable values, passes every runtime and getter check.
The existing S adversary test changes only Markdown while the on-chain
registry remains pinned, so it cannot exercise this case.

   This violates SPEC §3.5's fixed Sepolia identity and Self registry table and
the task's requirement that the checker prove the registry's immutable wiring.
Keep the cross-file consistency checks, but add a network-keyed expected-pin
map in the checker and an adversary case where both configuration sources and
the deployed registry use a wrong pair.

   Reproduction: set both `DEPLOYMENTS['celo-sepolia'].identityRegistry` /
`selfRegistry` and their Markdown rows to non-zero addresses, deploy
`EnclaveRegistry` with those same constructor arguments, and point the other
three rows at a genuine stack. The comparisons at lines 257-264 and the
runtime splice at lines 269-275 all use the substituted values, so this
condition has no failing check.

2. **[INSIDE] `DeployRegistry` can broadcast an immutable registry backed by
a non-production validator.** `contracts/script/DeployRegistry.s.sol:14-20`
checks only that `ATTESSA_NITRO_VALIDATOR` has code and that its
`certManager()` answer has code. Any contract implementing that one selector
(including a malicious look-alike) passes; it need not be the just-deployed
pinned NitroValidator, need not point to the pinned P384 verifier, and need
not have production runtime code.  The registry is then broadcast at lines
22-24 with this value permanently embedded.  `check-deploy` will diagnose the
mistake only after the irreversible deployment, which does not satisfy the
deploy script's SPEC §3.5 guarantee.

   Reproduction: deploy a contract whose `certManager()` returns a live
CertManager address, export its address as `ATTESSA_NITRO_VALIDATOR`, and run
the registry script on Sepolia. The checks at lines 15-18 pass and
`_deployRegistry` receives the impostor. Add pre-broadcast runtime-bytecode
checks against the locally compiled production artifacts (including both
NitroValidator immutables), or make the registry script deploy the validator
stack and registry atomically from the returned stack address. Add a script
test for this refusal.

## Minor

None.

## Verification

- `git submodule update --init --recursive`: passed after the sandbox was
  granted the required Git-metadata write.
- `flock -w 1800 /home/hr/.cache/attessa-heavy.lock pnpm install
  --frozen-lockfile`: passed after pnpm's user-level project metadata was
  allowed outside the workspace.
- `cd contracts && flock -w 1800 /home/hr/.cache/attessa-heavy.lock forge
  build`: passed (compiler warnings only).
- The prescribed local Anvil adversary suite passed when rerun outside the
  sandbox; the sandbox itself prevents loopback binding.
- `node scripts/check-deploy.mjs celo-sepolia`: correctly refused the TODO
  admin row with exit 2.

## U8 — not checked

No deployment was broadcast and no keys or environment files were read. I did
not verify live Sepolia runtime code because the repository intentionally has
no addresses yet. The accepted open limitation about custom initcode that
pre-writes storage was not re-reported. I did not create the suggested
impostor-validator transaction; the failure follows from the two selector/code
checks and their direct use in the constructor.

U7 finding count: INSIDE 2, OUTSIDE 0 (indicative, not blind-review evidence).

REVISE: pin identity/Self in the verifier and refuse non-production validators before registry broadcast.
VERDICT: changes required
