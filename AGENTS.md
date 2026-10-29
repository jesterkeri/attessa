# Agent instructions

Hand-written on purpose. Commands, deviations and boundaries only.

Start every status message to Joshua with "Joshua,".

## Commands (use verbatim)
- install: `pnpm install --frozen-lockfile && git submodule update --init --recursive && cargo fetch --locked --manifest-path enclave/Cargo.toml`
- build: `pnpm -r build && (cd contracts && forge build) && cargo build --release --locked --manifest-path enclave/Cargo.toml`
- test: `pnpm -r test && (cd contracts && forge test) && cargo test --locked --manifest-path enclave/Cargo.toml`
- lint: `pnpm -r lint && (cd contracts && forge fmt --check) && cargo fmt --check --manifest-path enclave/Cargo.toml && cargo clippy --locked --manifest-path enclave/Cargo.toml -- -D warnings`
- typecheck: `pnpm -r typecheck`
- contracts test: `cd contracts && forge test -vv`
- invariants: `cd contracts && FOUNDRY_INVARIANT_RUNS=256 FOUNDRY_INVARIANT_DEPTH=50 forge test --match-path 'test/invariant/*'`
- static analysis: `cd contracts && slither . --config-file slither.config.json`

## Project rules
- Read `SPEC.md` for what to build, `FLOWS.md` §6 and §8 for every user-facing string (verbatim), `INVARIANTS.md` for what tests must prove.
- The machine is Windows + WSL2 capped at 12 GB / 16 threads. Run one heavy command at a time. No watch modes. Enclave images (arm64) are built on the EC2 host, never locally.
- Broadcasting transactions is Joshua's job. Prepare `forge script` and run it without `--broadcast`, paste the simulation, and stop.
- Never print, log, commit or paste a private key or the facilitator API key. Keys come from env or keystores only.
- Celo Sepolia (11142220) until Gate 5. No mainnet anything before Gate 5 and Joshua's go.
- The test-only tamper proxy (T23) exists only in the `sepolia-test` gateway config (TEST_ONLY=1, localhost, not in the Caddyfile) and refuses to start on mainnet.

## How work is tracked
- `TASKS.md` is the live list. Work the current task only.
- `DONE.md` is append-only evidence. A task is complete only when its verification command has run and its **real output** is pasted in.
- Anything outside the current task goes in `OPEN-QUESTIONS.md`, not in the diff.
- Start every session by reading `STATUS.md`, `DONE.md`, and the recent commit log.

## Review
- After finishing a gate, write `reviews/gate-N-brief.md` and STOP. Do not review your own diff.
- Codex runs the review. Read the verdict, fix, re-review. Don't argue with findings in chat.
- Record `reviewed:` and the verdict in the DONE.md entry.

## Never
- Never edit `SPEC.md`, `FLOWS.md`, `INVARIANTS.md`, `ARCHITECTURE.md`, `GLOSSARY.md`, `THREAT-MODEL.md`, `KNOWN-LIMITS.md` or anything under `adr/`. If one is wrong, stop and say so in `OPEN-QUESTIONS.md`.
- Never weaken, skip or delete a failing test.
- Never broadcast a transaction, publish a package, or deploy to production.
- Never bypass a hook or a check.

## When you are stuck
If a verification fails three times, stop and report what you tried, what happened, and what you think is actually wrong.
