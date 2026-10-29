# ADR-009: Agent identity = reference ERC-8004 registry; Self Agent ID is a link, required on mainnet if the ABI spike passes

- Status: **superseded by ADR-014** (r2). Kept for history; don't build `requireSelf`.
- Context:
  - The hackathon requires ERC-8004 registered from the agent wallet.
  - Frontier requires Self Agent ID (use, or commit to).
  - Self runs a separate ERC-8004-style registry.
- Options:
  1. Authority = `ownerOf` on the reference registry, plus an optional `linkSelfAgent` proving the same wallet owns a Self Agent ID with a human proof (`requireSelf` immutable per deployment).
  2. Authority = Self registry only.
  3. Both identities independent, no link.
- Decision: (1).
- Consequences:
  - Two registrations for the owner.
  - The Self ABI is [unverified] until spike S4.
  - If S4 fails, mainnet deploys with `requireSelf=false`, recorded in KNOWN-LIMITS, and Frontier M1 delivers it.
  - We give up a single identity.
- Confirmation: unit tests with mock registries; the S4 result in DONE.md.
