# PIPELINE (r5)

Joshua, this is system design phase 13.5: CI, environments, secrets, supply chain and branch policy. The harness workflow (`.github/workflows/harness.yml`) stays as installed. Project jobs are added in `.github/workflows/ci.yml`.

## Stages

| When | Job | Budget | Required? |
|---|---|---|---|
| PR | `ts`: `pnpm install --frozen-lockfile`, `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test` | ≤ 4 min | required |
| PR | `contracts`: `forge fmt --check`, `forge build`, `forge test` (unit + invariant at 64 runs) | ≤ 4 min | required |
| PR | `slither`: `slither contracts --config-file contracts/slither.config.json --fail-high` | ≤ 3 min | required |
| PR | `enclave`: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test --locked` | ≤ 5 min | required |
| PR | `vectors`: the three language suites over `vectors/` (INV-18) | covered by the above | required |
| PR | harness jobs: workflows lint, secrets, pack integrity, reviews | ≤ 1 min | required |
| Nightly | invariants at 256 runs / depth 50; `forge coverage` (branch ≥ 90% on EnclaveRegistry); `pnpm audit --prod`; `cargo audit`; mutation checks listed in INVARIANTS (scripted) | ≤ 30 min | advisory (opens an issue on failure) |
| Manual (Joshua) | Sepolia/mainnet deploy: `forge script … --broadcast` from Joshua's machine with a keystore | n/a | human only |
| Manual (on EC2) | `attessa enclave build` / `start` / `signer register` | n/a | human or operator session |

**Anything slower than budget moves to nightly. Nothing is deleted to make it fit.**

## Environments

| Env | What | Notes |
|---|---|---|
| local | anvil (`--network local`) + fake facilitator + fake seller-host | unit/integration tests; no real enclave |
| Celo Sepolia | real registry + real enclave on EC2 + Celo Sepolia x402 v2 facilitator + test USDC | staging; testnet is staging |
| Celo mainnet | real everything, x402 v2 USDC + USA₮ | from G5 |

There's no persistent staging server and no preview deploys (no web UI).

## Secrets inventory

| Secret | Lives in | Blast radius | Rotation |
|---|---|---|---|
| Deployer key | Joshua's encrypted Foundry keystore (`cast wallet import`), never in CI | none after deploy | new keystore per network |
| Admin key (CertManager owner/revoker) | hardware wallet or cold keystore | DoS on new registrations | `transferOwnership` |
| Agent owner key (ERC-8004 NFT) | hardware wallet recommended; at minimum a keystore separate from operator/agent | approve malicious releases, retire endpoints | transfer NFT |
| Operator key | EC2 `/etc/attessa/operator.key` 0600, user `attessa-op` | register signers for its endpoint | owner re-adds the endpoint with a new operator |
| Agent wallet key (buy payments) | EC2 `/etc/attessa/agent.key` 0600, user `attessa-seller` | its USDC balance (keep ≤ 5 USDC) | new wallet |
| `FACILITATOR_API_KEY` | EC2 env file 0600, user `attessa-gw` | spend facilitator credits | regenerate at x402.celo.org |
| Buyer keys | each user's OS keychain | their daily cap | `attessa init` |

- **CI holds no secrets at all.** CI never deploys.
- **Pre-commit:** `gitleaks protect --staged` via a local hook; the harness `check-secrets.sh` runs in CI.

## Supply chain

- Lockfiles committed: `pnpm-lock.yaml`, `Cargo.lock`, `contracts/foundry.lock` (or the submodule SHA).
- Installs frozen everywhere.
- `pnpm` with `ignore-scripts=true`, plus an explicit `onlyBuiltDependencies` allowlist: `better-sqlite3`, `keytar`, `esbuild` if used. Nothing else runs install scripts.
- Dependency updates: Renovate weekly grouped PRs with `minimumReleaseAge: 7 days`.
- GitHub Actions pinned to full commit SHAs (`check-workflows.sh` enforces). `permissions: contents: read` at the workflow top; jobs elevate only if needed (none do).
- No `pull_request_target`. No step interpolates `${{ github.event.* }}` text into shell; use env vars, quoted.
- Toolchains pinned:

  | Tool | Pin |
  |---|---|
  | Node | `.nvmrc` = 22 |
  | pnpm | `packageManager` field in `package.json` |
  | Rust | `rust-toolchain.toml` (exact version) |
  | Foundry | `foundryup -i <exact nightly/stable tag>`, recorded in `contracts/FOUNDRY_VERSION` |
  | solc | exact version in `foundry.toml`, optimizer settings fixed |
  | nitro-cli | 1.5.2 on the EC2 host |

- Enclave base image pinned by digest.

## Agents in the pipeline

- No CI job runs a coding agent.
- Codex reviews run locally on Joshua's machine against a checked-out branch. They write `reviews/gate-N-review.md` and commit it on a branch, and have no push rights to main.

## Branch policy

- `main` protected: required status checks (every "required" row above plus the harness jobs), one approving review that isn't the PR author, no force push, no direct push.
- **Make these checks required in the GitHub ruleset. Until that's done, CI is documentation, not a control.**
- Agent-authored PRs can't self-approve.

## Rollback and point of no return

| Layer | Rollback | Point of no return |
|---|---|---|
| Gateway / seller-host / CLI | redeploy the previous tag on EC2 (`git checkout <tag> && pnpm -r build && systemctl restart …`), measured in T24 | n/a |
| Enclave | start the previous EIF (needs its release still Approved) + re-register | n/a |
| Registry | none (immutable) | **Mainnet deploy of the registry address.** Fix forward = new registry + SDK deployments bump + owners re-approve + operators re-register |
| Settlements | none | **Every settlement tx is final.** That's why INV-9 is the top invariant |
