# ADR-012: Demo seller workload = payment check over public chain inputs bought through buy

- Status: accepted. Door: two-way (it's the demo workload, not the protocol).
- Context:
  - Codex flagged that the seller must justify remote attested execution.
  - The hackathon scores paid calls into services we don't control.
  - The trust layer story needs a workload buyers would want checked.
- Options:
  1. Payment check: rules over chain reads (account code, nonce, balance at block N) fetched by paying a buy RPC capability; the proof commits to `inputsHash`.
  2. Verified Cencori inference proxy (only attests forwarding code; model unverifiable).
  3. Private-rules evaluator (rules can't be private if the build is reproducible and public).
- Decision: (1).
- Why:
  - The rules are public, so anyone can audit them.
  - The inputs are public chain facts at a stated block, so anyone can audit them.
  - The proof gives buyers a cheap, signed, accountable verdict from exactly that code.
  - Each evaluation produces a real paid call into buy.
- Consequences:
  - A buyer could in principle recompute the verdict themselves. Value = convenience + accountability + an auditable record, which is stated honestly.
  - Cencori and private workloads are Frontier M3.
- Confirmation: determinism property test (INV-16); evidence rows show `source:"buy:<id>"`.

## Amendment r2 (design review r1, findings 15, 16)

- The response body carries the full `inputs` object (block number, hash, timestamp, the address read, code, nonce, balance, source), so `responseHash` covers it and a buyer can recompute `inputsHash` without guessing.
- The gateway and the SDK both check the inputs block: its hash matches the chain and it's at most 300 s old (L22). Without this an operator could pick an old block and flip R3/R4 with a "correct" audit.
- Request grammar is strict (lowercase hex, `chainId == configured`, `amount` regex). Enclave `bad_request` → 400, `bad_inputs` → 503, both before settlement, so never charged.
- The claim is "auditable after the fact" (anyone can re-read the chain at that block). `attessa audit` that does it for you is M1.

## Amendment r3 (design review r2, finding 6)

- Checking only the block left the values open: a seller-host could put fabricated code, nonce or balance next to a real block hash. The gateway now re-reads all three at `inputs.block.number` before settling (`inputs_mismatch`), and the SDK does the same when its RPC still has that state (L23).
