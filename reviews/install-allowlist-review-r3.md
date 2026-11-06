# Install-scripts allowlist review r3 — 9909372

Scope: `git diff 209049c..9909372`, the static guard, its lockfile/manifest consumers, the prior r2 report, and the frozen installed worktree. I did not modify the implementation.

## Findings

None.

## Verification and rationale

- The snapshot rule at `scripts/check-install-scripts.sh:330-338` now checks every `dependencies` and `optionalDependencies` entry against the exact `${name}@${reference}` snapshot key. This covers scoped names and peer-suffix references because the suffix remains part of the reference; all entries in the committed lockfile resolved to an existing same-name snapshot.
- The signed binary, octal, and hexadecimal forms are now covered by `CORE12` at lines 279-281. Inspection of pnpm 10.32.1’s bundled `@zkochan/js-yaml` integer and float resolvers found the expression conservative: it refuses all forms pnpm would coerce which PyYAML leaves as strings, including signed `0b`, `0o`, and `0x` values. Forms PyYAML itself coerces are already rejected through the mapping-key/type and structural checks where relevant.
- `scripts/codex-install-r2/snapshot-alias-and-signed-numbers.test.sh` passed at `9909372`, and failed as expected at `209049c`: its alias, missing-snapshot, `+0o17`, and `-0o17` cases were accepted by the old guard while the quoted control and committed lockfile remained accepted.
- With `TMPDIR` inside the review worktree and the supplied pnpm CJS, every prescribed adversary and Codex test returned `RC=0`; the final guard, allowlist test, and `done-r6-full-probe` also returned `RC=0`. The expected failure emitted by the full probe was a refusal and that probe itself returned success.

## Protocol record

- **U1/U7:** This was not a blind cold review: the prompt supplied the prior finding and target questions. No independent finding resulted, so the INSIDE/OUTSIDE metric is not meaningful evidence of neutrality.
- **U2-U4:** I enumerated importer, package, and snapshot name-to-reference consumers, including optional dependencies and peer-suffix snapshot keys. The changed exact-name constraint reaches each snapshot dependency consumer.
- **U5:** The new regression exercises both reported defects and proves the old/new distinction. The broad pre-existing adversary suite covers the surrounding import, package, YAML, and workspace-link surfaces.
- **U6:** The restrictive allowlist remains appropriate for a guard whose purpose is to keep install-time execution auditable; no design-level contradiction found.
- **U8:** All required local checks ran under the shared lock. No secrets, user configuration, real network endpoint, transaction, or publication was used. I did not independently install another pnpm version or make registry requests beyond the guard’s prescribed local verification path.
- **U9:** The complete guard scope was sampled beyond the narrow diff; no root finding outside the r2 fix scope was identified.

Disposition: SHIP
VERDICT: implementation-ready
