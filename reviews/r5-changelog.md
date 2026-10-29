# r5 changelog

| Finding | Files changed | Change |
|---|---|---|
| 1 | SPEC.md, FLOWS.md, TASKS.md, ARCHITECTURE.md, THREAT-MODEL.md, GLOSSARY.md, PREFLIGHT.md, PIPELINE.md, OPEN-QUESTIONS.md, docs/design/RESEARCH.md, adr/005-x402-v1-celo-facilitator.md | Moved the production payment path to x402 v2 EIP-3009, CAIP-2 networks, and canonical v2 headers so the supported Sepolia USDC path is buildable. |
| 2 | SPEC.md, FLOWS.md, INVARIANTS.md, TASKS.md, adr/005-x402-v1-celo-facilitator.md | Made every pre-expiry 400/412 settlement response pending until reconciler chain evidence or expiry, and added the stale-RPC regression case. |
| 3 | FLOWS.md, INVARIANTS.md, TASKS.md, THREAT-MODEL.md, PREFLIGHT.md, GLOSSARY.md, KNOWN-LIMITS.md, OPEN-QUESTIONS.md, ARCHITECTURE.md, PIPELINE.md | Bumped the affected pack documents to r5 and removed stale r3 implementation references. |
