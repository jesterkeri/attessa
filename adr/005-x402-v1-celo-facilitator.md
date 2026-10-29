# ADR-005: x402 v1 `exact` on `celo`/`celo-sepolia`, settled through Celo's hosted facilitator

- Status: accepted. Door: two-way (adding v2 later is additive).
- Context: the buy client and gateway speak x402 v1. buy-core may mis-map v2 Celo Sepolia (`eip155:44787`). Celo's facilitator supports v1 and v2.
- Options:
  1. v1 + hosted facilitator.
  2. v2 + hosted facilitator.
  3. v1 + self-settlement (the gateway submits `transferWithAuthorization` itself).
- Decision: (1). Verify with `/verify`, settle with `/settle` (API key). No own facilitator.
- Consequences:
  - The buy client and our SDK can both pay us.
  - We depend on facilitator availability and credits (→ `gateway_paused`).
  - We give up v2 features (payment-identifier extension; mainnet doesn't advertise it anyway).
  - Self-settlement stays a fallback design if the facilitator becomes the bottleneck.
- Confirmation: spike S5 (our SDK and the buy client both pay the Sepolia gateway).

## Amendment r2 (design review r1, findings 12, 13)

- Generic x402 v1 clients (including `buy curl`) don't send `X-Request-Id`, so the gateway derives `requestId = keccak256(asset ‖ payer ‖ nonce)` and echoes it; it never answers 400 for a missing id.
- USA₮'s `version()` reverts. The EIP-712 domain is read with EIP-5267 `eip712Domain()` ("Tether America USD"/"1") and pinned in `packages/core` (SPEC §2.6); the 402 `extra.name` uses the domain name, not the ticker.

## Amendment r3 (design review r2, findings 2, 12)

- A v1 `X-PAYMENT` carries no asset. With USDC and USA₮ both offered on mainnet, the gateway identifies the asset by recovering the EIP-3009 signature under each pinned domain; if that is ambiguous it calls `/verify` once per offered requirement (SPEC §6.2 step 3).
- Settle outcomes are keyed on HTTP status, matching x402-rs: 400/412 before broadcast, 500 `unexpected_error` after broadcast.

## Amendment r5 (design review r4-codex, finding 1)

- Supersede the original decision. Production uses x402 v2 `exact` with EIP-3009 on both Celo networks. The quote uses `PAYMENT-REQUIRED`; the paid request uses `PAYMENT-SIGNATURE`; the successful response uses `PAYMENT-RESPONSE`.
- Use CAIP-2 networks `eip155:42220` and `eip155:11142220`. The `accepted` v2 requirement is JCS-equal to one quote entry and names the asset, so the mainnet multi-asset gateway does not infer an asset from the signature.
- Reason: the live Celo Sepolia facilitator advertises USDC for v2 only. Its legacy v1 `celo-sepolia` kind has no assets, so v1 cannot meet the public Sepolia paid-call gate.
- The v1 compatibility path is not part of the MVP. S5 may test buy against the v2 offer, but buy compatibility is not a prerequisite for the direct SDK path.

## Amendment r5 (design review r4-codex, finding 2)

- A 400 or 412 settlement response is never final before expiry. The gateway records it as `settle_pending`; only reconciler chain evidence can settle or terminalize the row.
