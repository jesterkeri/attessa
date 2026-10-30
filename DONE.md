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

## T03 - 2026-10-30
commit: 705d515 (built fd63419 by builder B2, Opus; fixed 705d515)
verified: pnpm --filter @attessa/core test
output:
```

> @attessa/core@0.0.0 test /home/hr/myvscode_linux/attessa/.worktrees/b2-core/packages/core
> vitest run --passWithNoTests


 RUN  v3.2.7 /home/hr/myvscode_linux/attessa/.worktrees/b2-core/packages/core

 ✓ test/regression-t03.test.ts (4 tests) 7ms
 ✓ test/core.test.ts (21 tests) 52ms
 ✓ test/vectors.test.ts (7 tests) 111ms

 Test Files  3 passed (3)
      Tests  32 passed (32)
   Start at  08:47:06
   Duration  630ms (transform 157ms, setup 0ms, collect 766ms, tests 171ms, environment 1ms, prepare 228ms)

exit 0
```
adversary: r1 on fd63419 DEFECT x2 (CheckBidi skipped by Node URL for bidi hosts; UTF-8 BOM accepted before X-Attested-Proof JCS); 120/120 vector values recomputed independently with cast. r2 on 705d515 NO DEFECT FOUND; 124/124 recomputed; 2,130-input TS vs Rust url differential fuzz, no originHash disagreement.
reviewed: pending (Codex)
notes: whatwg-url 14.2.0 (tr46 5.1.1) replaces Node URL for host parsing; requestHash uppercases ASCII only; new vectors for bidi, BOM, non-ASCII method, UTF-16 key order, RFC 8785 Appendix B numbers. Open: Unicode version not pinned, -0 vector, local IP literals, empty labels (OPEN-QUESTIONS).
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

## T02 Codex r1 fixes - 2026-10-30
commit: this entry
review: .worktrees/review-t02-r1/reviews/t02-review-r1.md (VERDICT: changes required, M2 m1)
fixed:
- M2 Foundry pin: contracts/FOUNDRY_VERSION = v1.8.1 (forge 1.8.1, commit 982849d); the proposed ci.yml installs that version.
- m1 scripts/check-install-scripts.sh passes on a failed install only for ERR_PNPM_UNSUPPORTED_ENGINE; any other failure exits 1.
- M1 CI: .github/workflows/ci.yml with the PIPELINE jobs ts, contracts, slither, enclave is proposed in .worktrees/prompts/ci.yml (the guard-edit hook keeps workflow files for Joshua to apply), plus harness-r2.patch removing the duplicate build job from harness.yml.
verified: bash scripts/check-install-scripts.sh (normal) and the same with npm offline and an empty cache
output:
```
$ bash scripts/check-install-scripts.sh
install refused by the engines pin (exit 1): ok
exit=0
$ npm_config_offline=true npm_config_cache=$(mktemp -d) bash scripts/check-install-scripts.sh
FAIL: install failed for another reason (exit 1); no evidence either way:
npm error code ENOTCACHED
exit=1
```
reviewed: pending (Codex r2, after ci.yml is applied)

## T02 Codex r1 fixes: full offline-probe output - 2026-10-30
The entry above abridged the offline run. Verbatim rerun:
```
FAIL: install failed for another reason (exit 1); no evidence either way:
npm error code ENOTCACHED
npm error request to https://registry.npmjs.org/pnpm failed: cache mode is 'only-if-cached' but no cached response is available.
npm error A complete log of this run can be found in: /tmp/tmp.3AKQ57Yn6q/_logs/2026-10-30T09_03_24_882Z-debug-0.log
exit=1
```
reviewed: pending (Codex r2)

## T19 - 2026-10-30
commit: 3bb4af3 plus merge 5198af1 (built 2d55778, 67e0122 by a builder, Opus; fixed b76a43d)
verified: pnpm --filter @attessa/gateway test (plus pnpm --filter @attessa/gateway typecheck), on the merge
output (file lines and totals verbatim; the per-test lines are in the run log and omitted here):
```
$ pnpm --filter @attessa/gateway test
 ✓ test/smoke.test.ts (1 test) 694ms
 ✓ test/admin.test.ts (4 tests) 3938ms
 ✓ test/reconciler-resend.test.ts (3 tests) 4621ms
 ✓ test/adversary-t19-r2.test.ts (9 tests) 9409ms
 ✓ test/adversary-t19.test.ts (2 tests) 10198ms
 ✓ test/idempotency.test.ts (17 tests) 13068ms
 ✓ test/quote.test.ts (32 tests) 15087ms
 ✓ test/settlement.test.ts (25 tests) 15712ms
 ✓ test/evaluate.test.ts (37 tests) 17677ms
 Test Files  9 passed (9)
      Tests  130 passed (130)
exit=0
$ pnpm --filter @attessa/gateway typecheck
> tsc -p ../core && tsc -p . --noEmit
exit=0
```
adversary: r1 on 67e0122 DEFECT (INV-11: a serial reconciler re-send to a hung facilitator delayed other rows' expiry; fixed b76a43d, test kept as test/adversary-t19.test.ts). r2 on b76a43d NO DEFECT FOUND (late re-send answers vs terminal states, in-flight leak, concurrent ticks, corrupt payload, stop() mid-pass, background 402); its 9 tests kept as test/adversary-t19-r2.test.ts.
reviewed: pending (Codex)
notes: three SPEC questions from the fix round are in OPEN-QUESTIONS (unfunded authorizations vs the unpaid rate limit; nonce used before created_block; §6.2 step order vs the idempotency table).

## T15 - 2026-10-30
commit: fd24b45 (built fbe9bcf, 89b2e5d by a builder, Opus; fixed acbf654, fbafffe; merge fd24b45 brings in the T19 branch)
verified: pnpm --filter @attessa/seller-host test && pnpm --filter @attessa/cli test -- -t "seller" (plus pnpm -r typecheck), on the merge
output (file lines and totals verbatim):
```
$ pnpm --filter @attessa/seller-host test && pnpm --filter @attessa/cli test -- -t "seller"
 ✓ test/framing.test.ts (4 tests) 5ms
 ✓ test/units.test.ts (8 tests) 9ms
 ✓ test/server.test.ts (23 tests) 222ms
 ✓ test/enclave.test.ts (6 tests) 253ms
 ✓ test/adversary-t15-r2.test.ts (8 tests) 647ms
 ✓ test/inputs.test.ts (11 tests) 502ms
 ✓ test/adversary-t15.test.ts (8 tests) 468ms
 Test Files  7 passed (7)
      Tests  68 passed (68)
seller-host exit=0
 ✓ test/attestation.test.ts (4 tests) 447ms
 ✓ test/enclave.test.ts (8 tests) 1207ms
 ✓ test/adversary-t15.test.ts (7 tests) 1605ms
 ✓ test/adversary-t15-r2.test.ts (8 tests) 1789ms
 ✓ test/owner.test.ts (15 tests) 2085ms
 ✓ test/signer.test.ts (17 tests) 5784ms
 Test Files  6 passed (6)
      Tests  59 passed (59)
cli exit=0
$ pnpm -r typecheck
packages/gateway typecheck: Done
packages/cli typecheck$ tsc -p ../core && tsc -p ../seller-host && tsc -p . --noEmit
packages/cli typecheck: Done
exit=0
```
adversary: r1 on 89b2e5d DEFECT x2 (`--network local` ignored the pinned deployments, SPEC §2.6; the spend guard dated revenue by updated_at so a row counted on two days, SPEC §5); fixed acbf654, fbafffe; tests kept as packages/{cli,seller-host}/test/adversary-t15.test.ts. r2 on fbafffe NO DEFECT FOUND (all 11 §6.4 states, day boundary, WAL reads, time zones, pin vs override on every network); its 16 tests kept as adversary-t15-r2.test.ts.
reviewed: pending (Codex)
notes: no buy source yet (needs S7); the guard is not wired into main.ts; `enclave start --port` can point at another network's enclave (SPEC §8 lists --port as free) and `enclave build` does not refuse gitignored files in the build context: both left as design questions; one existing fixture column renamed updated_at -> created_at to match the §6.4 schema.

## T15 Codex r1 fixes and adversary rounds 3-5 - 2026-10-30
commit: cb83abf (fix builder, Opus; branch feat/t15-seller-host, rerun by lead)
review: Codex r1 (.worktrees/archive/reviews/t15-seller-host-and-cli-review-r1.md): REVISE, M1 renew sent certificate-cache txs before checks registration makes; M2 seller-host could boot against another network's enclave and trusted bad_frame; m1 framed replies not checked as JCS. Fixed in 2056eff.
verified: pnpm --filter @attessa/seller-host test; pnpm --filter @attessa/cli test; pnpm -r typecheck; pnpm -r lint
output:
```
$ pnpm --filter @attessa/seller-host test
 ✓ test/framing.test.ts (4 tests) 4ms
 ✓ test/units.test.ts (8 tests) 9ms
 ✓ test/review-t15-r1.test.ts (13 tests) 70ms
 ✓ test/server.test.ts (23 tests) 223ms
 ✓ test/enclave.test.ts (6 tests) 257ms
 ✓ test/inputs.test.ts (11 tests) 1090ms
 ✓ test/adversary-t15.test.ts (8 tests) 1177ms
 ✓ test/adversary-t15-r2.test.ts (8 tests) 5245ms
 Test Files  8 passed (8)
      Tests  81 passed (81)
exit=0
$ pnpm --filter @attessa/cli test
 ✓ test/adversary-t15-r3.test.ts (1 test) 260ms
 ✓ test/attestation.test.ts (4 tests) 547ms
 ✓ test/adversary-t15-r4.test.ts (1 test) 705ms
 ✓ test/review-t15-r1.test.ts (3 tests) 1437ms
 ✓ test/enclave.test.ts (8 tests) 1539ms
 ✓ test/review-t15-r3.test.ts (8 tests) 1570ms
 ✓ test/review-t15-r4.test.ts (4 tests) 1667ms
 ✓ test/adversary-t15.test.ts (7 tests) 1983ms
 ✓ test/adversary-t15-r2.test.ts (8 tests) 2232ms
 ✓ test/owner.test.ts (15 tests) 2454ms
 ✓ test/signer.test.ts (17 tests) 6202ms
 Test Files  11 passed (11)
      Tests  76 passed (76)
exit=0
$ pnpm -r typecheck
exit=0
$ pnpm -r lint
exit=0
```
adversary: r3 (enclave start --port could configure the other network's enclave) and r4 (a late AttestationStale on renew used registration wording and advice) found defects, fixed in 949259f and cb83abf with their tests committed. r5 on cb83abf: NO DEFECT FOUND (renew reverts incl. a signer expiring during caching, port seam unreachable from bin.ts, boot binding check, JCS replies, port pins).
reviewed: pending (Codex r2)
notes: suspicions from r5, unproven and not fixed: after certificate txs land, the generic revert lines still end "Nothing was sent."; invalid_pcr and invalid_public_key renew lines carry restart or no advice (both unreachable with a genuine AWS document). `--port` now accepts only the network's fixed port (logged in OPEN-QUESTIONS).
