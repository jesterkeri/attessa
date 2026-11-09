# T28 buy inputs — round 2 review

Reviewed `1591a4cf5784a988308b4823918c1a1d0075fe5c..17d6d2c` under
`packages/seller-host`. This is a non-blind, single-prompt review: the U7
classification below is indicative, not a rigorous measurement.

## Findings

No actionable findings (critical, major, or minor).

The round-1 findings are closed:

- **M1 — paid inputs not anchored to the requested Celo height:** closed.
  `InputFetcher.fetch` obtains the head from Forno, reads the paid batch at
  `latest - 1`, and then compares the block hash, timestamp, code, nonce, and
  balance against a free Forno read at exactly that height before it can return
  `source: "buy:…"` (`src/inputs.ts:201-215`). A missing or failed
  cross-check rejects the paid result and uses the ordinary Forno fallback.
- **M2 — a paid authorization could be unrecorded or appear unpaid:** closed.
  The intent is fsynced before the paid request, and the nonce is appended
  before the wrapped fetch transmits its payment header (`src/buy.ts:177-191,
  217-225`; `src/ledger.ts:59-75`). A reset, 5xx, malformed reply, abort, or
  second 402 leaves an intent counted as spend and is reported as
  `payment_uncertain` when no response callback closed it. A received 5xx is
  recorded as a responded, ambiguous receipt rather than an unpaid read.
- **M3 — deleting or damaging the guard state could reset daily spend:**
  closed. `BuySpendGuard.state` takes the maximum of state and append-only
  intent-ledger spend, and treats a corrupt/unreadable state or ledger as a
  guard fault (`src/guard.ts:48-80`). The fetcher catches that fault before a
  paid request and falls back to Forno (`src/inputs.ts:179-198`).

U2/U3/U4 checks found the relevant complete sets covered: all four enclave
inputs are compared; both free-head retry and paid-read paths still allow at
most one paid batch; and all payment outcomes that can follow a sent request
remain conservative in the ledger. The extra free Forno read is compatible
with SPEC §5: it preserves one paid JSON-RPC batch per evaluate and does not
create a second paid call. No changed test was weakened; the former expectation
of two paid batches was corrected to one paid batch plus free head and
cross-check requests.

## Verification

Passed (with local loopback permission, required by the repository's fake RPC
and x402 servers):

```text
pnpm --filter @attessa/seller-host lint && pnpm --filter @attessa/seller-host typecheck && pnpm --filter @attessa/seller-host test

Test Files  14 passed (14)
Tests       140 passed (140)
```

## U7 classification

Findings: 0 INSIDE, 0 OUTSIDE. This is indicative only because the prompt
named its concerns before review; it is not evidence of an unframed cold read.

## U8/U9 limits

I did not perform a full-repository or live-mainnet audit, did not use a real
agent key or paid capability, and did not inspect secrets, keystores, `.env`,
or `.npmrc`. I reviewed the changed seller-host implementation, its changed
tests, the installed `@celo/buy-core` payment path, and the cited SPEC/FR/C5.3
requirements. No transaction was sent.

REVIEW DECISION: SHIP
VERDICT: implementation-ready
