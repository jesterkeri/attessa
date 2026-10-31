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
| Admin | `TODO(Joshua): cold admin EOA, CertManager owner and revoker (not the deployer)` |
| P384Verifier | `TODO(Joshua): from the DeployValidatorStack broadcast` |
| CertManager | `TODO(Joshua): from the DeployValidatorStack broadcast` |
| NitroValidator | `TODO(Joshua): from the DeployValidatorStack broadcast` |
| EnclaveRegistry | `TODO(Joshua): from the DeployRegistry broadcast` |

Not ours, pinned in SPEC §3.5 and passed to the registry constructor:

| Name | Address |
|---|---|
| IdentityRegistry (ERC-8004) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| SelfRegistry | `0x043DaCac8b0771DD5b444bCC88f2f8BBDBEdd379` |

Deploy transactions: TODO(Joshua): tx hashes and block numbers.

## celo

Chain 42220. Not deployed: T30, after Gate 5 and Joshua's go.

## How to deploy

Celo Sepolia only. Broadcasting is Joshua's job. The key comes from a Foundry keystore
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

If check-deploy fails after a broadcast, do not announce or use the addresses. The registry is
immutable (ADR-002): fix the cause and deploy again.
