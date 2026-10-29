# ADR-002: EnclaveRegistry is immutable with no global admin

- Status: accepted. Door: one-way per deployment.
- Context: the registry is the root of trust for buyers. Any admin key is a key that can make a fake seller look genuine.
- Options:
  1. Immutable, per-agent authority only.
  2. UUPS proxy behind a timelocked multisig.
  3. Ownable with a pause.
- Decision: (1). Authority comes only from the agent owner (ERC-8004) and the endpoint operator.
- Consequences:
  - Bugs are fixed by deploying a new registry and bumping `packages/core/src/deployments.ts`. Owners re-approve and operators re-register (cheap, since signers rotate every boot anyway).
  - No pause: the per-agent kill switch is release revocation.
  - We give up hot fixes.
- Confirmation: Slither upgradeability checks show no proxy and no owner; a test asserting no function lacks an owner/operator check except views and `registerSigner` (operator).

## Amendment r2 (design review r1, finding 9)

- "Authority comes only from the agent owner" inherits the ERC-8004 Identity Registry's own trust: it's an ERC-1967 proxy whose owner (an EOA) can upgrade it and so rewrite `ownerOf`. The same holds for the Self registry. Our registry has no admin; the upstream ones do (L19). This is stated in the README's explanation page.
