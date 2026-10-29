# ADR-007: Enclave app in Rust; the parent talks to it over vsock through socat

- Status: accepted.
- Context: the enclave needs the NSM API, secp256k1 signing, a small deterministic rules engine, and a small reproducible image.
- Options:
  1. Rust (`aws-nitro-enclaves-nsm-api` 0.5.2 native, `k256`).
  2. Go (nsm bindings via third-party libs).
  3. Node (large image, weaker determinism).
- Decision: (1). The parent runs socat to bridge loopback TCP to vsock, so seller-host stays plain Node.
- Consequences:
  - A second language in the repo.
  - Cross-language vectors are required (INV-18).
  - We give up a single-language stack.
- Confirmation: `cargo test` runs `vectors/`.
