# ADR-008: One c6g.xlarge in us-east-1; EIF built with kaniko --reproducible; run continuously only during judging

- Status: accepted, with the reproducibility claim gated on spike S3.
- Context:
  - Enclaves need a supported instance. Graviton with 2 vCPU allows only 1 enclave vCPU, which is too tight.
  - "Published code" is only meaningful if anyone can rebuild the same PCRs.
- Options:
  1. c6g.xlarge (4 vCPU, arm64), enclave 2 vCPU/1536 MiB; kaniko reproducible.
  2. c6i.xlarge (x86).
  3. Nix-based EIF (monzo/aws-nitro-util).
- Decision: (1). Nix is the fallback if kaniko doesn't reproduce.
- Consequences:
  - ~$0.136/hr (third-party price; confirm).
  - Arm64 builds happen on the instance, not on the Windows/WSL machine.
  - We give up building EIFs locally.
- Confirmation: S3, where two clean builds on two hosts give equal PCR0/1/2.

## Amendment r2 (design review r1, findings 20, 29)

- Allocator 2 vCPU / 3072 MiB; each enclave runs `--cpu-count 1 --memory 1024`, so the production enclave (vsock 5005) and a test-modified build (5006) can run side by side (S2 confirms). The modified-build check never stops the live enclave.
- Hours: availability from Nov 2 (mainnet demo, outreach) to Nov 13 is ~264 h, plus ~60 h of development: 324 h × $0.136 ≈ $44. Billing alarm at $50.

## Amendment r3 (design review r2, finding 9)

- The host serves two sellers during judging (SPEC §5, FR-13): mainnet enclave on vsock 5005, Sepolia on 5007, the test build on 5006 only when needed. Allocator 3 vCPU / 3072 MiB; the parent keeps 1 vCPU and ~5 GiB for two gateways, two seller-hosts and Caddy (load is ~1 req/s). S2 confirms three enclaves fit; if not, the test build runs only after stopping the Sepolia enclave. Cost is unchanged (one instance).

## Amendment r4 (design review r3, finding 5)

- `nitro-cli run-enclave` can't pass a port into the enclave. One EIF listens on vsock port 5000 on both networks; enclaves are told apart by `--enclave-cid` (16 mainnet, 17 Sepolia, 18 test). The same PCRs serve both networks, so one release and one S3 comparison.
