# T13 adversarial review r1

Reviewed `git diff e2aeb15 ca8a26e` for the enclave implementation, excluding the
tracking-file changes as requested. I read the changed Rust sources and tests, the T03
format implementations/vectors, the binding spec, the named invariants and ADRs, and
the relevant threat-boundary material.

## Findings

### Critical

None.

### Major

None.

### Minor

None.

The proof path builds `responseHash` from the response bytes it has just produced and
builds `inputsHash` from the same typed inputs placed in that response
(`enclave/src/enclave.rs:260-276`). Strict parsing rejects duplicate fields, unknown
fields, and positional/array forms at each struct boundary; it does not reject valid
alternative JSON spellings. The EIP-712 layouts, low-s recovery byte, origin handling,
JCS ordering, binding bytes, and hashes match the checked cross-language vectors.

## Verification performed

- `flock /home/hr/.cache/attessa-heavy.lock cargo test --locked --manifest-path enclave/Cargo.toml`
  passed: 42 tests across the enclave, adversarial, format, and vector suites.
- `flock /home/hr/.cache/attessa-heavy.lock cargo fmt --check --manifest-path enclave/Cargo.toml`
  passed.
- `flock /home/hr/.cache/attessa-heavy.lock cargo clippy --locked --manifest-path enclave/Cargo.toml -- -D warnings`
  passed.
- `git diff --check e2aeb15 ca8a26e` passed.

## Protocol notes

U1: This was necessarily a single-prompt review: the stated concerns and invariants
were already visible before the cold read. The U7 count below is therefore indicative,
not a rigorous measure of framing.

U2: I enumerated the rules R1--R5 and their downstream response fields; all five are
evaluated in order. The one-shot configure gate has both pre- and post-configuration
paths covered.

U3/U4: The additional derived invariant checked was that parse acceptance cannot change
the semantics of either signed response hash: raw request bytes remain in `requestHash`,
while canonical typed inputs are both embedded in the emitted response and hashed for
`inputsHash`. I traced the configured chain, agent, origin, release, domain, key and
input values through attestation, liveness, evaluation and signatures.

U5: There is no integration test against a real `/dev/nsm` or AF_VSOCK peer, nor a test
that injects malformed-length PCR data from the NSM seam. Those are coverage gaps, not
findings here: the former requires the prohibited enclave-image/EC2 run, and normal NSM
PCR responses are fixed-width. The parser, framing, key-retry, NSM-failure, and
cross-language format paths are covered in the local suite.

U6: I challenged the configuration and parent/enclave trust premise. An incorrect
one-shot configuration is bound into the attestation and the registry refuses a mismatch;
parent-side withholding, reordering, and connection-level DoS are explicitly accepted
TB4 availability limits, not proof-forgery paths.

U7: Findings inside the prompt's stated concerns: 0. Findings outside them: 0.

U8: I could not execute the arm64 EIF, obtain a real AWS NSM attestation, exercise the
real AF_VSOCK listener, or independently establish image PCR reproducibility; those need
T12/T14's EC2 work and were not run locally. I also did not inspect unrelated future
gateway, SDK, seller-host, CLI, or contract diffs.

U9: I inspected the task boundary plus the TypeScript format consumers needed to assess
INV-18. No unscoped external-root finding emerged. The explicitly logged frame-size,
`rpcAllowedChains`, empty-denylist, source-grammar, error-shape, and related accepted/
open items were not re-reported.

Decision: SHIP
VERDICT: implementation-ready
