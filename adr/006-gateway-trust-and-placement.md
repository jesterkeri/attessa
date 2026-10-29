# ADR-006: The pre-settlement gateway is a marketplace-side step; the buyer never relies on it

- Status: accepted.
- Context:
  - In x402 the buyer signs the payment authorization before execution, and whoever holds it can settle until `validBefore`.
  - If the seller runs the gateway, "verify before settle" protects the buyer from faulty output but not from a dishonest seller.
- Options:
  1. Frame the gateway as the step a marketplace (buy) runs. In the demo we run it, as a separate process with its own config and no private key. Buyer protection rests on: a short window (120 s), cancel, payTo binding, and independent re-verification + evidence.
  2. Escrow contract that releases on a proof (out of scope: refunds/escrow excluded).
  3. Claim the gateway protects buyers from sellers (false).
- Decision: (1). The README states plainly what Mode B protects against.
- Consequences:
  - An honest narrative for judges and buy.
  - The demo gateway operator is also the seller (RISK-7, accepted).
  - Escrow is a Frontier option.
- Confirmation: the claims table forbids "protects you from dishonest sellers"; `paid_but_rejected` evidence path tested.

## Amendment r2 (design review r1, findings 3, 4)

- "Independent evidence" now means chain-confirmed: a refusal is recorded as `refused` and becomes `not_charged` only after the SDK reads `authorizationState == false` at a block past `validBefore + 5` (INV-20), or after a confirmed cancel. A refused call that settles anyway becomes `settled_after_refusal`.
- An ambiguous settle answer is 202 `settle_pending`, never "not charged"; the reconciler decides, and a settled result is served from `/v1/results`.
