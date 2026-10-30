# Done

Append-only. Never edit an entry. One entry per completed task.

Template:

## T00 - YYYY-MM-DD
commit: <sha>
verified: <the exact command that was run>
output:
```
<the real output, pasted, not summarised>
```
reviewed: reviews/gate-N-review.md | verdict: implementation-ready | C0 M1 m3
notes: <anything discovered that changed the design>

The `reviewed:` line is required. Code built by Claude Code is reviewed by Codex,
never by the model that wrote it. If a task genuinely needed no independent review,
write `reviewed: n/a (<why>)` so the decision is visible rather than missing.

---

## T02 - 2026-10-29
commit: bcf393d
verified: pnpm install --frozen-lockfile && pnpm -r typecheck && (cd contracts && forge build) && cargo build --locked --manifest-path enclave/Cargo.toml && git -C contracts/lib/nitro-validator rev-parse --short HEAD
output:
```
Scope: all 6 workspace projects
Lockfile is up to date, resolution step is skipped
Already up to date

╭ Warning ─────────────────────────────────────────────────────────────────────╮
│                                                                              │
│   Ignored build scripts: esbuild@0.28.2.                                     │
│   Run "pnpm approve-builds" to pick which dependencies should be allowed     │
│   to run scripts.                                                            │
│                                                                              │
╰──────────────────────────────────────────────────────────────────────────────╯
Done in 401ms using pnpm v10.32.1
Scope: 5 of 6 workspace projects
packages/cli typecheck$ tsc -p . --noEmit
packages/core typecheck$ tsc -p . --noEmit
packages/gateway typecheck$ tsc -p . --noEmit
packages/sdk typecheck$ tsc -p . --noEmit
packages/sdk typecheck: Done
packages/seller-host typecheck$ tsc -p . --noEmit
packages/cli typecheck: Done
packages/gateway typecheck: Done
packages/core typecheck: Done
packages/seller-host typecheck: Done
Warning: lib/nitro-validator: missing from foundry.lock (found 0ea0d12366b4fa44f9e07e4755f2ad36561cb674)
Nothing to compile
   Compiling attessa-enclave v0.0.0 (/home/hr/myvscode_linux/attessa/enclave)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.81s
0ea0d12
exit 0
```
reviewed: pending (adversary, then Codex; verdict appended as a new entry)
notes: attempt 1 failed (rootDir in the shared tsconfig resolved to the repo root); fixed per package. Rust 1.98.1 pinned; locally it is a hardlink of the installed stable 1.98.1 because the rustup download stalled. esbuild install script is skipped by the pnpm allowlist (only better-sqlite3, keytar may run scripts).

## T02 adversary fix - 2026-10-29
commit: 1eb99f7
findings: (1) AGENTS.md lint failed, no package had a lint script; (2) pnpm 9 ran esbuild postinstall, allowlist only in pnpm-workspace.yaml. Fixed: lint script per package; allowlist moved to package.json pnpm.onlyBuiltDependencies; engines.pnpm >=10.32.1. Probes kept: scripts/check-agents-commands.sh, scripts/check-install-scripts.sh.
verified: ./scripts/check-install-scripts.sh && ./scripts/check-agents-commands.sh && <T02 verify>
output:
```
install refused (exit 1): ok
PASS install
PASS build
PASS test
PASS lint
PASS typecheck
packages/seller-host typecheck: Done
Warning: lib/nitro-validator: missing from foundry.lock (found 0ea0d12366b4fa44f9e07e4755f2ad36561cb674)
Nothing to compile
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.04s
0ea0d12
exit 0
```
reviewed: pending (Codex)
notes: pnpm 10 control (same probe with pnpm@10.32.1) prints PASS. Not fixed (unproven suspicions, logged in task.md): cross-package typecheck needs a build or project references once packages import each other; tests outside src/ are not typechecked; contracts/foundry.lock untracked.

## T08 - 2026-10-30
commit: (this commit)
verified: SELF_ID=85; for f in "ownerOf(uint256)(address)" "hasHumanProof(uint256)(bool)" "isProofFresh(uint256)(bool)"; do cast call 0x043DaCac8b0771DD5b444bCC88f2f8BBDBEdd379 "$f" $SELF_ID --rpc-url $SEP; done
output:
```
0x00E74B33EcF372BE0Ca367389d5a2228D5DF281a
true
true
exit 0
```
reviewed: n/a (read-only spike, no code; reproducible by the verify command)
notes: agent 85 found via the registry's Registered/AgentRegisteredWithHumanProof events (Blockscout API, block 39967457; Forno caps eth_getLogs ranges). Owner 0x00E74B33EcF372BE0Ca367389d5a2228D5DF281a has no code (a human wallet), i.e. linked mode. All three selectors answer at block ~40062906, so linkSelfAgent stays enabled on Sepolia.
