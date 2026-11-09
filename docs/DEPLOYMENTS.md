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
Joshua's job. Sepolia uses `forge script` as written below; Celo mainnet does not (see "Celo mainnet
(T30)": tagged `cast send --create` data). On Sepolia the key comes from a Foundry keystore
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

### Celo mainnet (T30): tagged creations, no `forge script`

Every creation transaction on Celo mainnet carries the Loops ERC-8021 attribution suffix, and
`forge script` cannot append bytes to a creation transaction, so mainnet does not use it. Each of the
four creations is a `cast send --create` of the exact data `scripts/tagged-deploy.mjs` writes:
reference-build creation bytecode, then the ABI-encoded constructor arguments (SPEC §3.5), then the
suffix `[code][length][0x00][0x80218021 x 8]` for the code in env `LOOPS_ATTRIBUTION_TAG`
(`attributionSuffix` from `packages/core`). Sepolia keeps `forge script` above. The code comes from the
owner's Loops enrolment, only from env; it is never hard-coded and never shown in an error message. It is
public once a creation is mined (the suffix is on chain), and the success output prints the suffix, which
contains it.

The suffix cannot change what is deployed. The creation code reads its arguments from a fixed offset
and returns a fixed runtime code, so bytes after the arguments are never executed. Forge tests prove it
for all four contracts (`contracts/test/deploy/TaggedCreation.t.sol`: same runtime code hash, same
storage, same owner, revoker and wiring, for a 13-character and a 32-character code), and
`node scripts/tagged-deploy.e2e.mjs` proves it end to end on a local chain (below).

Only from a commit with a Codex SHIP that is merged to staging with green CI, checked out clean (the
script refuses a dirty tree). The script signs nothing, reads no key and sends nothing: it checks,
writes the data file, prints a fresh gas estimate and the command. Joshua runs that command; the key
comes only from his Foundry keystore (`--account`). Run each step's printed command, then its
post-check, before preparing the next step.

```sh
# 0. Inputs (public values only). The tag appears in the printed suffix. The admin is the cold EOA, never the deployer.
export LOOPS_ATTRIBUTION_TAG=celo_xxxxxxxxxxxx
export ATTESSA_ADMIN=0x...            # cold admin address
export DEPLOYER=0x...                 # the keystore account's address
node scripts/check-deploy.mjs --pre-deploy        # PASS, or stop

# 1. P384Verifier
node scripts/tagged-deploy.mjs p384 --deployer $DEPLOYER --account <keystore-name>
#    run the printed `cast send ... --create ...` yourself, then the post-check:
node scripts/tagged-deploy.mjs check p384 <address> --deployer $DEPLOYER --tx <hash>
export ATTESSA_P384_VERIFIER=<address>

# 2. CertManager(p384, admin, admin)
node scripts/tagged-deploy.mjs certmanager --deployer $DEPLOYER --account <keystore-name>
node scripts/tagged-deploy.mjs check certmanager <address> --deployer $DEPLOYER --tx <hash>
export ATTESSA_CERT_MANAGER=<address>

# 3. NitroValidator(certManager, p384)
node scripts/tagged-deploy.mjs nitro --deployer $DEPLOYER --account <keystore-name>
node scripts/tagged-deploy.mjs check nitro <address> --deployer $DEPLOYER --tx <hash>
export ATTESSA_NITRO_VALIDATOR=<address>

# 4. EnclaveRegistry(identity, nitroValidator, self, false); identity and Self are pinned for chain 42220
node scripts/tagged-deploy.mjs registry --deployer $DEPLOYER --account <keystore-name>
node scripts/tagged-deploy.mjs check registry <address> --deployer $DEPLOYER --tx <hash>

# 5. Record the five addresses above and in packages/core/src/deployments.ts (celo), commit, then
node scripts/check-deploy.mjs celo   # must print OK for every check and exit 0
```

`forge script` on 42220 only simulates: `DeployBase.sol` accepts the chain so the scripts can be dry-run
there, but under `forge script --broadcast` or `--resume` (`vm.isContext`) `_requireSupportedChain` and
`_startBroadcast` revert, because a script send would be an untagged mainnet creation
(`contracts/test/deploy/MainnetSendGuard.t.sol`). The test stands in for the broadcast context through an
overridable `_inBroadcastContext()`: a test cannot enter `ScriptBroadcast` without sending, so that the
real cheatcode answers true under `--broadcast` is not tested here, only that the guard reverts when it does.

What is pinned. Before `prepare` prints anything, and before `check` judges anything, the reference build
(compiled fresh from HEAD's committed blobs) must match, for all four contracts, (a) the keccak256 of its
whole creation bytecode (`CREATION_PINNED` in `scripts/tagged-deploy.mjs`) and (b) the keccak256 of the
runtime embedded in it with every immutable word zeroed (`PINNED`). For P384Verifier, CertManager and
NitroValidator (b) equals the constants in `DeployBase.sol` (a test keeps the two equal). For
EnclaveRegistry nothing in `DeployBase.sol` exists, so both its runtime pin and its creation pin live only
in `tagged-deploy.mjs`, recorded from the reference build at the reviewed commit: they must be
re-recorded in the same commit whenever `contracts/src/EnclaveRegistry.sol` or the nitro-validator
submodule changes, and until then any such change makes `prepare` refuse. The pins cover the constructor
code, the runtime, the metadata trailer (so every source path and hash, remappings, compiler version and
settings), but they are derived from this same build: they are a second record of what was reviewed, not
an independent compiler. The reference build also requires the solc 0.8.26 binary to match a recorded
sha256 (linux x86_64 only; any other platform refuses), writes `evm_version = "cancun"` into its generated
`foundry.toml`, and refuses an artifact whose metadata says another solc, evm_version or optimizer.
Not pinned: the forge binary itself (only its output is), and the git objects behind HEAD beyond what the
clean-tree check and the committed submodule id give.

Refusals, each before any data is written: tag unset or invalid; RPC chain id not 42220; admin zero or
equal to the deployer; git tree not clean; a prior-step address with no code or with runtime code that
differs from the reference build (immutables spliced, plus the whole-code pins); a reference build that
is not the pinned build (above); an output directory that is a symlink, not owned by you, or writable by
others (the default is `<tmp>/attessa-tagged-deploy-<uid>`, created mode 0700) or that is inside the
repository; for
the registry, the checks `_requireProductionStack` makes plus code at the pinned identity and Self
registries; an estimate x 1.3 above Celo's 16,777,216 gas cap.

Post-check per step (`check`): code at the address equals the reference runtime code with the deployed
values spliced in; the constructor-set state reads back (CertManager owner and revoker are the admin
and its P384Verifier; NitroValidator's CertManager and P384Verifier; EnclaveRegistry's validator,
identity, Self and `allowLocalOrigins() == false`); and with `--tx` the transaction is a creation from
the deployer whose input equals reference creation bytecode ++ constructor arguments ++ suffix, rebuilt
by `check` from the repository and the environment (it needs no data file and reads none), and whose
address is the CREATE address of sender and nonce (the script prints that address before you send).

`scripts/check-deploy.mjs celo` compares runtime code and getters only (`eth_getCode`, `eth_call`), never
creation input, so tagged deployments pass it unchanged.

Gas. Forno dry run for step 1 (2026-11-08, throwaway deployer, nothing sent): tagged P384Verifier
estimate 1,750,120 gas, limit 2,275,156 (x 1.3). Later steps cannot be estimated against mainnet until
the earlier contracts exist; on a local chain the tagged estimates were CertManager 5,366,590,
NitroValidator 3,622,046 and EnclaveRegistry 3,445,017, all well under the cap.

Local proof, repeatable: `node scripts/tagged-deploy.e2e.mjs` on a clean committed tree (needs anvil,
forge, cast, git and network for one `git clone` of celo-org/attribution-tags at a pinned commit). It
starts anvil on 127.0.0.1 with chain id 42220 and anvil's dev accounts (no key is read), runs the real
`tagged-deploy.mjs` for all four steps, sends each data file, and for each contract checks: the Celo
`verifyTx` (and `ox/erc8021`) finds the tag on the mined creation (`to` empty); runtime code equals the
reference artifact and an untagged control deployment; storage slots 0..31 and every getter equal the
control; the address is the printed CREATE address; `check` passes; then `check-deploy.mjs celo` passes
against the local stack. It does not cover `cast send --create` itself, forno, or the real identity and
Self registries (stub code is set at those addresses). It tears anvil and its temp files down on exit.

Whether Loops credits a tag on a contract creation, and what explorers do with trailing creation bytes,
are not verified: see OPEN-QUESTIONS.md.

If check-deploy fails after a broadcast, do not announce or use the addresses. The registry is
immutable (ADR-002): fix the cause and deploy again.
