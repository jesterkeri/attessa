# task.md: live work tracker

TASKS.md is the list of what to build. DONE.md is the evidence. This file is who is doing what right now, on which branch, and where it is in the review chain. Updated at every step.

## Flow for every task
1. Own branch `feat/tNN-<full-description>` (e.g. `feat/t19-x402-payment-gateway`) off `staging` (builder subagents: own worktree too).
2. Build, run the TASKS.md verify command, paste the real output in DONE.md.
3. Adversary subagent (Opus) attacks the diff against SPEC. Fix what it proves, and repeat until a round finds nothing on the exact commit Codex will review (fix rounds too).
4. Refactor subagent (Sonnet) at the end of each gate, before the gate brief.
5. Codex prompt for Joshua. Iterate to SHIP.
6. PR into `staging`, CI green. `main` only on Joshua's go, after pushing `rollback/<date>-before-<change>` at the old main.

## Now

| Task | What | Who | Branch | State |
|---|---|---|---|---|
| T01 | kill test, demo stack on Sepolia | Claude | `main` (submodule only) | simulation passed 9/9; waiting on Joshua to broadcast |
| T02 | scaffold (pnpm, Foundry, Rust, CI) | Claude | `feat/t02-scaffold` f56513d | adversary r4 found 2 (install probe, workflow scanner): fixed, CI green; adversary r5 running |
| T03 | core formats + vectors | builder (Opus) | `feat/t03-core` 242249d | adversary r4 (ZWNJ) fixed 187b78e; r5 found opaque-host reason; fix builder running |
| T04, T05 | EnclaveRegistry + invariants + mutations | builder (Opus), done | `feat/t05-enclave-registry-invariants` 5111483 | **Codex r1 SHIP** |
| T06, T07 | vectors in Solidity, real-fixture fork tests | builder (Opus) | `feat/t07-nitro-real-fixture` 39db437 | adversary r3 clean; **Codex r2 prompt with Joshua** (codex-t06-solidity-vector-tests-r2.md) |
| T08 | Self spike | Claude, done | `feat/t08-self-registry-spike` 11f43e1 | done |
| T09 | coverage 100% branches, slither 15 triaged | Claude | `feat/t09-coverage-and-slither` 3bf543a | Codex r1 SHIP; merge scaffold (symlink guard) then adversary r4 |
| T10 | deploy scripts, check-deploy | builder (Opus) | `feat/t10-registry-deploy-scripts` 9973bbc | adversary r5-r7 same class (committed tree subverts the in-script guard); Joshua chose a pre-deploy check; fix builder running |
| T13 | enclave app (Rust) | builder (Opus), done | `feat/t13-attestation-enclave` c70a344 | **Codex r1 SHIP** |
| T15 | seller-host + CLI enclave/release/endpoint/signer | builder (Opus) | `feat/t15-seller-host` fc952a1 | Codex r1 REVISE (2 major, 1 minor) fixed 2056eff; adversary r3 found port vs CID; fix builder running |
| T19 | x402 gateway | builder (Opus) | `feat/t19-x402-payment-gateway` 841536b | Codex r1 REVISE (2 minor + serial reconciler major) fixed; adversary r3 running |
| T19a | RPC history depth spike | Claude, done | `feat/t19a-rpc-history-depth-spike` 6fd2d76 | 400 and 7200 blocks ok on both RPCs |
| T20 | buyer SDK | builder (Opus) | `feat/t20-buyer-sdk` 9b4290c | lock now SQLite with a write probe; Joshua retired 4 fake-kill tests; adversary r7 running |

## Builders started 2026-10-29 from `feat/t02-scaffold` (worktrees in `.worktrees/`: the harness hook blocks writes under `.claude/`)
- B1 contracts: T04 EnclaveRegistry + unit tests, then T05 invariants + mutations
- B2 core: T03 formats, hashes, EIP-712, vectors (T06 follows in contracts once vectors exist)
- B3 enclave: T13 Rust app (no AWS needed for the tests)
- Claude: T07, T08, T09, T10, integration, reviews

Gateway (T19), SDK (T20) and CLI (T21) start after T03 lands; they import core.

## Waiting on Joshua
- Codex: T02 r1, T03 r1, T04/T05 r1, T13 r1, T06/T07 r1, T09 r1 (prompts in `.worktrees/prompts/codex-*-r1.md`)
- T01 broadcast (funded Sepolia wallet, key in `.env` as PRIVATE_KEY)
- restart Claude Code with `claude --continue` so the harness hooks load
- domain, AWS enclave access, Sepolia broadcast permission

## Problems found
- CI `guardrails` fails on the untouched pack: superseded design reviews r1 to r3 end in "changes required", and two BLOCKING open questions fail the pack check. Logged in OPEN-QUESTIONS.
- The two validate calls estimate ~14.6M gas; forge's default 30% pad would send an 18.96M gas limit, over the 16,777,216 cap. Broadcast with `--gas-estimate-multiplier 110`.

## Rules check (scout, 2026-10-29)
The full rule list is in AGENTS.md, BRIEF_CARD.md and ~/.claude/CLAUDE.md. Conflicts and how they're resolved:
- Review cadence: the pack reviews per gate; Joshua (2026-10-29) wants adversary + a Codex prompt after **every task**. Joshua's rule wins; gate briefs still get written.
- Review order: adversary (Opus) first, then Codex, per Joshua.
- Fixtures: "no fabricated fixtures" vs the G1 fixture attestation. Not a conflict: base's fixture is a real AWS attestation.
- `cast send` is treated as a broadcast and never run, even though no hook blocks it.
- Renewal threshold (72 h / 6 days / 48 h) and attribution spot-check (one tx vs every tx): logged in OPEN-QUESTIONS for the design side.

## Adversary suspicions on T02 (unproven, for later tasks)
- Once a package imports another (sdk -> core), `pnpm -r typecheck` on a clean clone fails until core is built (`types` points at dist). Fix when T19/T20 first import core: project references or build core first.
- `include: ["src"]` leaves tests outside src/ untypechecked: keep tests in src/.
- `forge build` leaves `contracts/foundry.lock` untracked on fresh clones.
