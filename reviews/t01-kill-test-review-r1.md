# T01 kill-test review r1

Reviewed `origin/staging...1771990` at the frozen `1771990` worktree on
2026-11-02. No critical, major, or minor finding was identified.

## Findings

None. C0 / M0 / m0.

The changed record is internally consistent and the material claims reproduced as
follows.

- The exact `TASKS.md:16` verification loop, with
  `SEP=https://forno.celo-sepolia.celo-testnet.org`, produced exactly nine lines.
  Every receipt has status `true`; gasUsed is 1,734,631; 5,382,414; 3,621,490;
  5,993,778; 6,246,708; 6,026,223; 6,051,782; 12,967,002; and 12,967,002.
  The maximum is below 16,777,216.
- Read-only transaction and receipt checks put the nine transactions at consecutive
  nonces 4 through 12 from `0xf312…3964`, in blocks 40,363,205 through
  40,363,248. The first three are creations whose receipt addresses are exactly
  `docs/KILL_TEST.md:15-16`; the next four call that CertManagerDemo; the last two
  call that NitroValidator. On-chain getters confirm the P384/CertManager/Nitro
  wiring stated by the demo stack.
- A fresh `forge build` of `contracts/lib/nitro-validator` at its checked-out
  `0ea0d12` (output and cache directed to `/tmp` under the required heavy lock)
  matched all three creation inputs byte-for-byte: P384Verifier; CertManagerDemo
  plus `(P384Verifier, 31,536,000)` constructor arguments; and NitroValidator
  plus `(CertManagerDemo, P384Verifier)` constructor arguments.
- Locally generating the pinned `0ea0d12` submodule's
  `tools/hinted_attestation_calls.js fixture` plan and comparing it byte-for-byte
  to the six on-chain call inputs gave six successful equality tests. This proves
  the three CA-cache calls, leaf-cache call, and both validation calls use the
  bundled repaired real fixture and the script's generated hints. The two validate
  calldatas are identical. `BaseSepoliaDemo.s.sol:64-71` indeed caches all four
  certificates before either validation, so the explanation at
  `docs/KILL_TEST.md:32-33` is correct: neither final validation is cold with
  respect to the certificate cache.
- The arithmetic is correct: gas sums to 60,991,030; receipt gas price is
  50,000,000,001 wei, yielding 3.049551500061 CELO (3.0496 CELO rounded);
  12,967,002 / 16,777,216 is 77.289355%; and `0xf4da48` is the documented
  16,046,664 padded gas limit. Chain ID is 11142220.
- `SPEC.md:306-314` requires the demo stack to remain separate and never enter
  `deployments.ts`. A repository sweep of the three demo addresses and
  `CertManagerDemo` found only the T01 record/task and the future T10 production
  guard; no production deployment reference exists. This meets the current,
  pre-T10 separation requirement.

## Protocol record

- **U1:** This was not a blind cold review: the task prompt already included its
  requested checks. I first inspected the entire four-file diff and derived the
  provenance, ordering, exact-calldata, arithmetic, and deployment-separation
  checks before executing the prompt's checklist. Per the protocol, the resulting
  classification is indicative, not rigorous.
- **U2:** Checked all completeness claims in the change: 3 deploys + 4 cache calls
  + 2 validations = 9; both validations; all four certificates; every receipt;
  and the exclusive demo-address claim. All matched the enumerated chain/source
  sets.
- **U3/U4:** The required invariants are successful real-fixture validation,
  cached prerequisite certificates, a single ordered sender-run, an under-cap
  transaction, truthful cost/limit reporting, and no path from this demo
  CertManagerDemo to production configuration. The changed values have no other
  consumers beyond this record, task tick, DONE evidence, and the reference-check
  script; no unnamed violated invariant was found.
- **U5:** The changed shell checker covers only referenced local paths and was
  executed successfully. The substantive chain assertions have no executable
  regression test in this diff, but the review independently made the live,
  read-only checks above.
- **U6:** The premise is appropriately bounded: this is evidence that the upstream
  demo path fits Celo Sepolia's per-transaction limit, not evidence that the
  expired-certificate demo manager is suitable for production. The document and
  SPEC §3.5 state that distinction unambiguously.
- **U7:** findings inside prompt concerns: 0; outside prompt concerns: 0. These
  counts are indicative only for the U1 reason above.
- **U8:** No material review claim was taken on trust. The heavy lock was initially
  occupied but later cleared; the fresh temporary build and all requested
  read-only chain checks then completed. I did not inspect unrelated subsystems,
  send a transaction, or read a key or `.env` file.
- **U9:** The audit swept the full stated diff and the directly relevant pinned
  upstream script/source plus SPEC §3.5, ADR-001, and KNOWN-LIMITS. It was not an
  unscoped review of unrelated project subsystems.

Decision: SHIP
VERDICT: implementation-ready
