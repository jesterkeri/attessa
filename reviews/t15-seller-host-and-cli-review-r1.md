# T15 adversarial review, r1

No critical findings.

## Major

### M1 — `signer renew` can spend on certificate-cache transactions before discovering a report the registry must reject

**INSIDE** (the prompt calls out signer renewal and preventing writes with wrong data).

`packages/cli/src/commands/signer.ts:313` calculates age for renewal but never applies the `MAX_FUTURE_SKEW` test applied by registration at line 188.  `packages/cli/src/commands/signer.ts:294` also accepts any 65-byte public key, whereas registration rejects a key not beginning `0x04` at line 200.  Both are required by SPEC.md §3.4: `renewSigner` repeats register steps 2–7, including the timestamp bound and the uncompressed-key form.

This is materially worse than an inaccurate diagnostic.  With an uncached instance/leaf certificate, `certSteps` at `packages/cli/src/commands/signer.ts:327` plans cache writes, and `planOrSend` sends them before it re-simulates the final `renewSigner`.  The registry then rejects that final transaction as `AttestationFromFuture` or `InvalidPublicKey`.  The operator has spent CELO caching certificates but has not renewed the signer.

Reproduction: let an active signer have uncached current instance/leaf certificates and invoke `attessa signer renew --attestation report.bin --yes` with an otherwise genuine report made by a host clock 61 seconds ahead of the chain (or a report whose `public_key[0]` is changed from `0x04` while preserving the following 64 bytes).  Renewal passes the local checks, sends the missing `verify*CertWithHints` transactions, then the final `renewSigner` re-simulation/transaction reverts.  Registration correctly refuses the equivalent inputs before planning cache writes.

### M2 — seller-host can boot against a different network's enclave and declares it configured without checking its binding

**INSIDE** (the prompt explicitly makes seller-host/network binding a security boundary).

`packages/seller-host/src/config.ts:64` permits `enclavePort` to override the fixed production network port.  `packages/seller-host/src/enclave.ts:142` treats every `configure` reply of `bad_frame` as proof that the target is already configured, then accepts an `attest` reply without parsing or comparing its binding to the requested chain, registry, agent, and origin.  `packages/seller-host/src/server.ts:124` consequently starts serving after that unchecked result.

This breaks SPEC.md §5's fixed per-network CID/socat layout and its reason for pinning it: a running mainnet and Sepolia host must not be silently crossed.  Registry checks will prevent an invalid signer registration, but the production seller-host/gateway can remain live while sending paid evaluations to the wrong configured enclave, producing an avoidable outage after payment verification rather than failing closed at boot.

Reproduction: run both bridges, then give the Sepolia seller configuration `"network":"sepolia"` and `"enclavePort":5005`.  `parseConfig` accepts it although 5005 is the mainnet bridge.  The mainnet enclave's one-shot `configure` returns `bad_frame`; `configureOrAttest` fetches its attestation and returns success without inspecting its user-data binding.  The Sepolia seller-host starts on 7071 connected to that mainnet enclave.  The existing tests cover only default ports and a matching already-configured enclave, not this cross-port/binding case.

## Minor

### m1 — framed replies are not required to be JCS

**OUTSIDE** (not one of the prompt's stated adversary cases).

`packages/seller-host/src/enclave.ts:72` parses the framed enclave reply with plain `JSON.parse` and accepts the object at line 82.  It never verifies that the received payload is its JCS serialization.  This breaks SPEC.md §4.2, which defines each framed message as JCS JSON.

Reproduction: make the socat peer return a valid frame containing `{"z":1,"a":2}`.  `TcpEnclaveTransport.request` resolves successfully even though the required JCS form is `{"a":2,"z":1}`.  Add a framed non-canonical-reply test and reject it before it reaches an internal route.

## Protocol accounting

U1: this was not a blind cold read: the task prompt already contained the scope, prior adversary results, known gaps, and rationale before review began.  The INSIDE/OUTSIDE measure is therefore indicative only, per the protocol's admitted limitation.

U2: swept the changed source/comments/commit messages for completeness claims, including the claims that renew repeats registration rules and that the per-network services are pinned.  M1 and M2 are the resulting counterexamples.

U3/U4: followed renewal inputs through certificate-cache planning and sending, and network/port configuration through boot configuration and attestation handling.

U5: no test exercises renewal with a timestamp more than 60 seconds ahead, a non-`0x04` 65-byte key, an overridden production enclave port, or an already-configured enclave with a mismatching binding.  No test rejects a non-JCS framed reply.

U7: findings — INSIDE 2; OUTSIDE 1.

U8: reviewed all changed production files in `packages/seller-host/src`, `packages/seller-host/systemd`, `packages/cli/src`, and their T15 tests, plus the relevant SPEC, FLOWS, ADR-010, task/evidence, and contract renewal implementation.  I did not read secrets, `.env`, keystores, or key files.  `git submodule update --init --recursive` succeeded.  The required lock-wrapped `pnpm install --frozen-lockfile`, core build, and test command did not acquire/run to completion in this environment (the worktree still has no `node_modules`); `pnpm -r typecheck` therefore failed with `tsc: not found`.  I did not treat the prior DONE evidence as a rerun.  The protocol's required lock wait was attempted with its full 1800-second command timeout, but the command runner returned after about 31 seconds without installation output; this is an execution-environment limitation, not a test pass or a reported lock timeout.

U9: an unscoped sweep was not performed; the review covered the requested seller-host/CLI range plus the direct contract/core consumers needed to verify its security boundaries.  The last recorded T15 adversary round was scoped, so no absence-of-findings statement here applies outside that boundary.

Decision: REVISE
VERDICT: changes required
