# ADR-014: Self Agent ID link is informational; no `requireSelf` (supersedes ADR-009's enforcement)

- Status: accepted (r2). Door: two-way (a later registry can enforce it).
- Context:
  - Design review r1 (findings 9, 11, 23): the Self registry is an upgradeable ERC-1967 proxy, its `ownerOf` semantics differ by registration mode, and `requireSelf=true` on an immutable registry lets the Self upgrade key brick every future registration.
  - Frontier asks us to use, or commit to, Self Agent ID. The hackathon doesn't require enforcement.
  - The plan has no slack before Nov 2.
- Options:
  1. Keep ADR-009: `requireSelf` immutable per deployment, true on mainnet if S4 passes.
  2. Informational link: `linkSelfAgent` records it after checking `ownerOf`, `hasHumanProof` and `isProofFresh` (try/catch); nothing depends on it; the SDK re-checks live and shows "Self-verified owner" only if all three hold and the Self owner equals the current agent owner.
  3. Drop Self entirely.
- Decision: (2). Constructor loses `requireSelf`. Only Self's `linked` mode is supported.
- Consequences:
  - The Frontier story is "uses Self Agent ID to show buyers a human-verified owner", with enforcement in M1.
  - A compromised Self upgrade key can fake the badge but can't block registrations (L11, L19).
  - We give up on-chain enforcement of human verification.
- Confirmation: no `requireSelf` symbol in `src/`; unit tests for the try/catch mapping; S4 (T08) result in DONE.md.
