# Attessa

You pay a service for an answer, it comes back wrong, and you can't tell whether the code the seller stands behind actually ran, or something else did. On buy (usebuy.ai, Celo's marketplace of pay-per-call APIs for agents) the money has already moved before the answer arrives.

Site: https://attessa.xyz

Attessa is a trust layer for x402 sellers on Celo. A seller runs approved code inside an AWS Nitro Enclave. Every paid response carries a signed proof from that code. The gateway settles the payment only after its own check of that proof passes, and the buyer's SDK checks it again independently.

## What Attessa proves, and what it does not

It tells a buyer whether the seller's approved rules ran for this request. It does not make the rules right. A bad answer from an approved build is a rules problem you can read in the source, not an operator you cannot see. It does not prove the model or rules are correct, that the inputs are true, or that the seller is available (an operator can still withhold or delay a response).

How it works:

1. The enclave generates a signing key at boot and never exports it. AWS Nitro produces an attestation document that binds that key to the exact code measurements (PCR0 to PCR2) of the running build.
2. The `EnclaveRegistry` contract checks the attestation on chain, each time a signer is registered or renewed, through a Nitro validator. The seller is an ERC-8004 agent identity, and only the owner of that identity can approve a build (a "release") or add an endpoint. A registered signer is tied to one agent, one approved release and one endpoint origin.
3. Each paid response carries an EIP-712 proof signed by that signer, covering the request, the response and the chain inputs the workload used.
4. The gateway verifies the proof (and re-reads the chain inputs) before it settles the x402 payment. If any check fails, it does not settle.
5. The buyer SDK does not trust the gateway. It resolves the endpoint from the registry itself, refuses to sign if `payTo` does not match, and re-verifies the proof.
6. "Not charged" is only reported once chain state confirms the payment authorization expired unused or was cancelled. Before that, a refusal is the gateway's word: the CLI shows it at once and warns if the chain later shows the authorization was used.

The owner's `sourceRef` (the git commit a build claims to come from) is the owner's claim, not something checked here. Buyer-facing copy says "owner says it's built from ...". Design detail is in [SPEC.md](SPEC.md) and [ARCHITECTURE.md](ARCHITECTURE.md), and the decisions behind it are in [adr/](adr/).

## Repo map

| Path | What it is |
|---|---|
| `contracts/` | Foundry project: `EnclaveRegistry` and its tests (unit, invariant, vectors, fork), deploy scripts, Slither config. `lib/nitro-validator` is a git submodule (base/nitro-validator) |
| `enclave/` | Rust enclave app: key, attestation, liveness and evaluate, with the payment-check rules |
| `packages/core` | Shared formats: origin normalisation, hashes, proof and attestation binding, deployments |
| `packages/sdk` | Buyer SDK: resolve, quote, pay, verify, pending ledger |
| `packages/cli` | The `attessa` command (alias `attest`) for buyers, owners and operators |
| `packages/mcp` | MCP server exposing the buyer tools (`resolve_endpoint`, `check_liveness`, `quote`, `pay_and_verify`, `verify_proof`, `get_result`, `list_pending`, `cancel_authorization`, `status`) |
| `packages/gateway` | x402 v2 payment gateway (Fastify, SQLite): verify, run, verify proof, then settle |
| `packages/seller-host` | Host-side bridge between the gateway and the enclave |
| `packages/site` | Source of the attessa.xyz static site |
| `vectors/` | Shared test vectors checked in TypeScript, Solidity and Rust |
| `adr/` | Architecture decision records |
| `docs/` | Deployment record, kill test, Slither triage, design notes |
| `reviews/` | Codex review files kept for the record |
| `scripts/` | Repo checks (CI guards, deploy check, install-script allow-list, and others) |

Project documents at the root: [SPEC.md](SPEC.md), [FLOWS.md](FLOWS.md), [INVARIANTS.md](INVARIANTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [GLOSSARY.md](GLOSSARY.md), [THREAT-MODEL.md](THREAT-MODEL.md), [KNOWN-LIMITS.md](KNOWN-LIMITS.md), [TASKS.md](TASKS.md), [DONE.md](DONE.md).

## Build and test

Requirements: Node 22.14 or newer (the SDK uses `node:sqlite`, and `better-sqlite3` crashes on 22.13 and older) with pnpm 10.32.1 or newer, Foundry (version in `contracts/FOUNDRY_VERSION`), Rust (`rust-toolchain.toml`). Slither is needed only for static analysis. The enclave image targets arm64 and is built on the EC2 host, not locally.

```sh
# install
pnpm install --frozen-lockfile && git submodule update --init --recursive && cargo fetch --locked --manifest-path enclave/Cargo.toml

# build
pnpm -r build && (cd contracts && forge build) && cargo build --release --locked --manifest-path enclave/Cargo.toml

# test
pnpm -r test && (cd contracts && forge test) && cargo test --locked --manifest-path enclave/Cargo.toml

# lint
pnpm -r lint && (cd contracts && forge fmt --check) && cargo fmt --check --manifest-path enclave/Cargo.toml && cargo clippy --locked --manifest-path enclave/Cargo.toml -- -D warnings

# typecheck (run the build first: packages read each other's built types)
pnpm -r build && pnpm -r typecheck

# contracts test, verbose
(cd contracts && forge test -vv)

# invariants
(cd contracts && FOUNDRY_INVARIANT_RUNS=256 FOUNDRY_INVARIANT_DEPTH=50 forge test --match-path 'test/invariant/*')

# static analysis
(cd contracts && slither . --config-file slither.config.json)
```

## Usage

None of the packages is published to npm. Install from source:

```sh
git clone https://github.com/jesterkeri/attessa
cd attessa
pnpm install --frozen-lockfile && pnpm -r build
(cd packages/cli && pnpm link --global)   # run `pnpm setup` first if pnpm has no global bin directory
```

Buyer commands (these exist in `packages/cli`):

```sh
attessa init                                   # wallet, spending limits (--max-amount, --daily-cap, --keystore; see the wallet note below)
attessa call https://<service> --body input.json --max-amount 0.05
attessa status --pending                       # pending payments; also: attessa status <origin>, attessa status --agent <id>
attessa cancel <id>                            # void an unsettled payment authorization on chain
attessa evidence export --format csv           # or jsonl
```

Global flags: `--network sepolia|mainnet|local`, `--rpc`, `--json`, `--yes`, `--dry-run` (it stops commands that pay or send; `init` still saves its settings).

Wallet note: a source install has no OS keychain support, because `keytar` is not installed. Give `attessa init` a wallet with `ATTESSA_PRIVATE_KEY` or `--keystore`; with neither it reports that no wallet was created.

Owner and operator commands also exist: `agent register|transfer|wallet-sig|set-wallet`, `selflink`, `release approve|deprecate|revoke`, `endpoint add|retire`, `signer register|renew`, `revoke release|signer`, `enclave build|start`, and `gateway pause|resume|status|export`. `attessa seller --help` prints the seller steps in order.

MCP server (stdio): after the build above, point your MCP client at `node <clone>/packages/mcp/dist/bin.js`. It reads the wallet from `ATTESSA_PRIVATE_KEY`, or `ATTESSA_KEYSTORE` with `ATTESSA_KEYSTORE_PASSWORD`, and takes `ATTESSA_NETWORK`, `ATTESSA_RPC`, `ATTESSA_REGISTRY` and `ATTESSA_DATA_DIR`.

Not available in this code yet: `attessa verify`, `attessa call --via buy`, and `attessa release verify`.

## Status

Built and covered by tests in this repo (see [DONE.md](DONE.md) for the recorded command output and Codex review verdicts):

- `EnclaveRegistry` and the deploy scripts, with unit, invariant, vector and Sepolia-fork tests.
- The shared formats and test vectors in TypeScript, Solidity and Rust.
- The enclave app, seller-host, gateway, buyer SDK, CLI and MCP server. The enclave's tests use a fake Nitro security module; the real-Nitro spike (T12) is not recorded as done.
- The site source.

Deployed: the validator stack and `EnclaveRegistry` on Celo Sepolia (chain 11142220). The addresses and transactions are in [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md).

On Celo mainnet (chain 42220), the agent identity is registered: ERC-8004 agent 10061, owned by the agent wallet `0x08eeF13fD03088aE1dB72ED84a7eed7B255CBfe1`, in the identity registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` ([transaction](https://celoscan.io/tx/0x58e6d1cc47c9d1a15ab5e1492dc3efe74a4cb8c28aba65a25762f43c9841ac0b)). Its metadata is at https://attessa.xyz/.well-known/agent.json.

Not done, per [TASKS.md](TASKS.md):

- The validator stack, `EnclaveRegistry` and a seller are not deployed on Celo mainnet. That deployment is being prepared and `docs/DEPLOYMENTS.md` will carry the addresses when it is done.
- Reproducible enclave builds (spike S3) are not done, so a release's `sourceRef` is not yet checked against its measurements.
- The Sepolia end-to-end run (signer registration, paid calls, tamper and modified-build refusals) and the drills are not recorded as done.
- There is no live seller and there are no users. Eleven paid calls have been made on Celo mainnet, all by hand, 0.11 USDC in total; [`docs/PAID-CALL.md`](docs/PAID-CALL.md) lists them. The first [transaction](https://celoscan.io/tx/0xebec214d75d2df40e8911d32737daba48f059f2882d36408d128331f37f21df0) proves 0.01 USDC moved from the agent wallet to `0x20faAca5F980E29639A0FCC6dcA6988E18ed333B`. Our record of the run says the rest, which a transaction can't show: it was paid with the `buy` CLI to Chainstack's Celo JSON-RPC on buy, for the same four chain reads the seller host will buy ([docs/PAID-CALL.md](docs/PAID-CALL.md)). The seller itself has made no paid call.
- Still open: `attessa verify`, `attessa call --via buy`, the public proof explorer, and the final docs set (the tutorial and how-tos on the site source are not final).

## Known limits

The full list is in [KNOWN-LIMITS.md](KNOWN-LIMITS.md). The ones to know first:

- L1: in the demo, the gateway operator is also the seller, so the gateway step does not protect a buyer from a dishonest seller. The buyer's protection is the short payment window, cancel, `payTo` binding, independent re-verification and chain-confirmed "not charged".
- L2: paying through buy has no payment protection. buy settles before it calls the service, so Attessa can only check after the money has moved.
- L4: attestation shows which code produced a response, not that it was available. An operator can withhold, delay or reorder.
- L5: request bodies are visible to the gateway and the host.
- L10: signer keys are ephemeral, so every enclave restart needs a new registration transaction.
- L17: origin squatting. Anyone can bind an origin on a registry first; buyers stay safe because the SDK cross-checks the origin's `.well-known` agent id, registry and chain, and checks the quote's `payTo` against the registry.
- L19: the ERC-8004 identity registry is upgradeable, so whoever holds its keys can change who owns an agent.
- L20: `sourceRef` is the owner's unverified claim.
- L21: confirming "not charged" takes time, up to about 125 seconds after a refusal, or the buyer can cancel on chain.

## Links

- Site: https://attessa.xyz
- [SPEC.md](SPEC.md), [FLOWS.md](FLOWS.md), [INVARIANTS.md](INVARIANTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [THREAT-MODEL.md](THREAT-MODEL.md), [KNOWN-LIMITS.md](KNOWN-LIMITS.md)
- [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md), [docs/KILL_TEST.md](docs/KILL_TEST.md), [docs/SLITHER_TRIAGE.md](docs/SLITHER_TRIAGE.md)
- [adr/](adr/)
