# Deployments

Our own contracts per network (SPEC §3.5). `node scripts/check-deploy.mjs <network>` reads the
tables below, so keep the `| Name | `address` |` layout. A `TODO` value means "not deployed yet"
and check-deploy refuses it. `packages/core/src/deployments.ts` must carry the same addresses
(`enclaveRegistry` and `validatorStack`); check-deploy compares the two.

The validator stack is our own instance of base/nitro-validator at the pinned commit `0ea0d12`
(ADR-001): production `P384Verifier`, `CertManager` and `NitroValidator`, never `CertManagerDemo`.
The kill test's demo stack is recorded only in `docs/KILL_TEST.md`.

## celo-sepolia

Chain 11142220.

| Name | Address |
|---|---|
| Admin | `0xD32AF5B881eC424435ECa3262065537dCcb64E65` |
| P384Verifier | `0xd26C0d863B71CBBBa07E6EeeDaB545d0F7c1a84E` |
| CertManager | `0x29F2a69B5685d0db11FA10aa7C9079B3F14CF7fd` |
| NitroValidator | `0x72B06e740D5F2C262b3193De69c7065A0C7424db` |
| EnclaveRegistry | `0x42Bf5Cb440c3C321CB42b0F4c81c3c7435cB92fF` |

Not ours, pinned in SPEC §3.5 and passed to the registry constructor:

| Name | Address |
|---|---|
| IdentityRegistry (ERC-8004) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| SelfRegistry | `0x043DaCac8b0771DD5b444bCC88f2f8BBDBEdd379` |

Deploy transactions (2026-11-02, deployer `0xF31207eE5831fb2a7bFB6f844a4fb16776193964`, from commit
`d3c48a1`, broadcast by Joshua):

- P384Verifier: tx `0xa430544810c313083eb12869cb1888c0462c8b4b949da7cbbb8e100b22e56dfe`, block 40354686, gas used 1734631
- CertManager: tx `0x9c9066b381af2e683c92abda97de3e3056297af4009aec97d85ee2d513f25372`, block 40354691, gas used 5366034
- NitroValidator: tx `0xcbdf40ca42972f948935485f90563e44fb85c93a05b454d2c2099aa133b3bdeb`, block 40354696, gas used 3621490
- EnclaveRegistry: tx `0x8a7f3fd883cde523c3719c02d9e14592cd056a002591c6542c54a7f4bf53d537`, block 40355491, gas used 3444473

## celo

Chain 42220. Not deployed: T30. Joshua broadcasts, only from a commit with a Codex SHIP that is merged
to staging with green CI. Fill this table in only after that broadcast.

| Name | Address |
|---|---|
| Admin | `TODO` |
| P384Verifier | `TODO` |
| CertManager | `TODO` |
| NitroValidator | `TODO` |
| EnclaveRegistry | `TODO` |

Not ours, pinned in SPEC §3.5 and passed to the registry constructor (the deploy script picks them
by chain id; they equal `packages/core/src/deployments.ts` and the PINS in `check-deploy.mjs`):

| Name | Address |
|---|---|
| IdentityRegistry (ERC-8004) | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| SelfRegistry | `0xaC3DF9ABf80d0F5c020C06B04Cced27763355944` |

## How to deploy

The scripts run on exactly two chains: Celo Sepolia (11142220) and Celo mainnet (42220); any other
chain id reverts. The chain id picks the identity and Self registries (no env var can change them),
and both chains deploy the production CertManager, never `CertManagerDemo`. Broadcasting is
Joshua's job. The key comes from a Foundry keystore
(`--account`) or from env `PRIVATE_KEY` (the scripts read it with `vm.envOr`); never put it on
the command line. Run from `contracts/` on a clean checkout of the commit being deployed.

The deploy scripts' own checks run inside the build they guard, so a committed remapping,
foundry.toml or source can switch them off (T10 adversary r5 to r8). `check-deploy.mjs --pre-deploy`
first refuses, before any forge command, a committed `.env` anywhere in the repo (forge loads it
into its own environment and solc's, unseen by `forge config`; T10 adversary r9) and any
`contracts/foundry.toml` line other than a blank, a comment, `[profile.default]` or a key it knows,
with solc exactly `"0.8.26"` (forge runs a solc named by path, even for `forge config`). It
rebuilds the scripts and the production contracts from the committed blobs under fixed settings.
It then requires forge's effective config in `contracts/` (foundry.toml, remappings.txt, an
uncommitted `.env`, `~/.foundry/foundry.toml`) to equal those settings, refuses any `FOUNDRY_*`
or `DAPP_*` variable, runs `forge clean` and `forge build`, and requires `contracts/out` to match
byte for byte. Run it
right before every `forge script` below, simulation and broadcast alike, in the same shell: it must
print `PASS` and exit 0. On `FAIL`, stop. Run each `forge script` exactly as written (the only
extra flag allowed is the Gas note's `--gas-estimate-multiplier`), with no `FOUNDRY_*` or `DAPP_*`
variable set.

```sh
cd contracts

# 0. Inputs. The admin is the cold EOA that owns the CertManager and holds its revoker role (L3).
#    The script refuses an admin equal to the deployer.
export ATTESSA_ADMIN=0x...           # admin address (public)
export DEPLOYER=0x...                # the deploying account's address (public)
export RPC=https://forno.celo-sepolia.celo-testnet.org

# 1. Validator stack: P384Verifier -> CertManager(p384, admin, admin) -> NitroValidator.
#    Simulate first (no flag), read the three addresses and gas, then add --broadcast.
node ../scripts/check-deploy.mjs --pre-deploy   # PASS, or stop
forge script script/DeployValidatorStack.s.sol:DeployValidatorStack --rpc-url $RPC --sender $DEPLOYER
node ../scripts/check-deploy.mjs --pre-deploy   # PASS, or stop
forge script script/DeployValidatorStack.s.sol:DeployValidatorStack --rpc-url $RPC \
  --account <keystore-name> --sender $DEPLOYER --slow --broadcast
#    or, with the key in env PRIVATE_KEY (and no --account):
#    forge script script/DeployValidatorStack.s.sol:DeployValidatorStack --rpc-url $RPC --slow --broadcast

# 2. Registry: EnclaveRegistry(identity, nitroValidator, self, false). Use the NitroValidator
#    address printed by step 1.
export ATTESSA_NITRO_VALIDATOR=0x...
node ../scripts/check-deploy.mjs --pre-deploy   # PASS, or stop
forge script script/DeployRegistry.s.sol:DeployRegistry --rpc-url $RPC --sender $DEPLOYER
node ../scripts/check-deploy.mjs --pre-deploy   # PASS, or stop
forge script script/DeployRegistry.s.sol:DeployRegistry --rpc-url $RPC \
  --account <keystore-name> --sender $DEPLOYER --slow --broadcast

# 3. Record. Replace the TODO rows above with the five addresses, fill `enclaveRegistry` and
#    `validatorStack` for celo-sepolia in packages/core/src/deployments.ts, commit, then from the
#    repo root at the commit you deployed from (check-deploy compiles its own reference bytecode
#    from HEAD's committed contracts and the pinned nitro-validator, so local edits can't skew it):
cd ..
node scripts/check-deploy.mjs celo-sepolia   # must print OK for every check and exit 0
```

Gas. Celo caps a transaction at 16,777,216 gas. Forge pads each estimate by 30% by default, so a
large estimate can be padded past the cap and the transaction rejected. If any per-transaction
estimate in the simulation, multiplied by 1.3, comes near that cap, add
`--gas-estimate-multiplier 110` to the broadcast command. The T10 simulation (forge 1.8.1, already
including the 30% pad) estimated P384Verifier 2,255,020, CertManager 6,975,844, NitroValidator
4,707,937 and EnclaveRegistry 4,477,799 gas, all well under the cap, so the default is fine today.

### Celo mainnet (T30)

Same scripts, same checks, chain 42220. Prepare and simulate only; `--broadcast` is Joshua's step,
from a commit with a Codex SHIP, merged to staging, with green CI. The admin is the cold EOA, never
the deployer. The registry cannot be simulated until the validator stack exists on mainnet, because
`ATTESSA_NITRO_VALIDATOR` must have code.

```sh
cd contracts
export ATTESSA_ADMIN=0x...           # cold admin address (public)
export DEPLOYER=0x...                # the deploying account's address (public)
export RPC=https://forno.celo.org

# 1. Validator stack. Simulate, read the gas, stop.
node ../scripts/check-deploy.mjs --pre-deploy   # PASS, or stop
forge script script/DeployValidatorStack.s.sol:DeployValidatorStack --rpc-url $RPC --sender $DEPLOYER
#    Joshua's step only, after re-running the pre-deploy check:
#    forge script script/DeployValidatorStack.s.sol:DeployValidatorStack --rpc-url $RPC \
#      --account <keystore-name> --sender $DEPLOYER --slow --broadcast

# 2. Registry, with the NitroValidator printed by step 1.
export ATTESSA_NITRO_VALIDATOR=0x...
node ../scripts/check-deploy.mjs --pre-deploy   # PASS, or stop
forge script script/DeployRegistry.s.sol:DeployRegistry --rpc-url $RPC --sender $DEPLOYER
#    Joshua's step only:
#    forge script script/DeployRegistry.s.sol:DeployRegistry --rpc-url $RPC \
#      --account <keystore-name> --sender $DEPLOYER --slow --broadcast

# 3. Record the five addresses above and in packages/core/src/deployments.ts (celo), commit, then
cd ..
node scripts/check-deploy.mjs celo   # must print OK for every check and exit 0
```

The mainnet simulation of the validator stack (2026-11-08, forge script against forno, no broadcast)
estimated P384Verifier 2,255,020, CertManager 6,975,844 and NitroValidator 4,707,937 gas, each under
the 16,777,216 cap even with forge's 30% pad (6,975,844 x 1.3 = 9,068,597).

If check-deploy fails after a broadcast, do not announce or use the addresses. The registry is
immutable (ADR-002): fix the cause and deploy again.
