# Stage 2.5: UX gate

Joshua, the gate ran twice with outside reviewers (Opus 5.5). Each reviewer read only the flow document and none of our reasoning. The raw first pass is in `UX-REVIEW-raw.md`.

## Which failure

**Comprehension.**

- **Premise:** fine but buried. The section 1 problem line now leads with a plain, concrete failure and names buy in plain words.
- **Comprehension:** the real failure. Buyer output was written in hashes and protocol nouns (agent, release, signer, liveness, payTo, settled), so a newcomer saw "Verified" and couldn't say what was checked or whether they paid.
- **Warmth:** mostly good. Refusals already led with "you were not charged".

## Round 1: 5 STOP, 6 STING, 19 STUMBLE

What changed in FLOWS.md:

| Finding | Severity | Fix |
|---|---|---|
| Buyer output in hashes/protocol nouns | STOP | Every line now gives the plain outcome first (paid? how much? checked against which published commit?), the true term second in brackets, hashes last. The vocabulary gains plain primaries: pay/settle, sealed machine/Nitro enclave, published code/release |
| No wallet, funding or network step | STOP | New J0 `attest init`: wallet in OS keychain, Sepolia by default, faucet links, visible spending limits; `--network` is the primary flag |
| Interrupted after signing: no copy, re-run could pay twice | STOP | "Lost the connection after you signed. Checking whether you were charged…" → charged/not charged; a pending ledger keyed by (origin, input hash) resumes instead of paying again |
| Enclave start / att.bin had no command | STOP | `attest enclave start` (wraps nitro-cli) writes att.bin and says it's valid for 30 minutes |
| agentId came from outside the journey | STOP | `attest agent register` added as J3 step 1 |
| 16 error codes without human copy | STUMBLE (blocks builders) | 20 rows added to the error table |
| 8 CELO spent without a confirm, while a 0.0004 CELO cancel had one | STING | Confirms now on register, approve, endpoint add, signer register (with cost) and revoke. Cancel doesn't prompt: waiting is free |
| 7-day expiry hidden | STING | Shown at registration with the renewal cost |
| "Report…" with no recipient | STING | Names the marketplace issue tracker |
| Paid-but-rejected silent on getting money back | STING | States on-chain payments can't be reversed; only the gateway operator can return it; the record proves it |
| J5 warned "not protected" after paying | STING | Warns before paying, with the price, and confirms |
| Revoke irreversible with no confirm | STING | Specific confirm naming the consequence |

## Round 2: 1 STOP, 2 STING. All fixed

| Finding | Fix |
|---|---|
| STOP: no step makes the build or measurements file | `attest enclave build` (reproducible, refuses a dirty tree) + a seller premise line in `attest seller --help` |
| STING: J0 promised a default limit, J1 demanded `--max-amount` | The limit from `init` (0.10 USDC per call) applies; `--max-amount` overrides |
| STING: registration cost not called recurring | "Every restart or renewal makes a new key … about 3 CELO cached, up to 8" |
| Misleading: "money only moves if the answer checks out" | "The service's gateway only uses it if the answer checks out, and it expires in 120 s either way". J2 says only that gateway can use the permission until expiry |
| Unpriced confirm in J5; uncosted approve/endpoint txs | Price in the J5 prompt; cost on every transaction confirm |

Round 2 found J1 passing the acceptance test.

## Word budget

The output lines were rewritten, not added to: J1 stays at 6 lines. New words went to J0 (a new first run) and to confirms, which carry costs the user had to discover before.

## Acceptance test (run tomorrow with a real developer)

1. Show the six-line J1 output to a developer who has used a paid API, for 20 seconds, with no docs and no scrolling.
2. Ask: **"Did you pay, how much, and what was checked before the money moved?"**
3. Pass: at least 4 of 5 answer "yes, 0.02 USDC, the seller's published code (and that it was running)".

## Gate verdict

**PASS** after round 2 fixes. Stage 3 may begin.
