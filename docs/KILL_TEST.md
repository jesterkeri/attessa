# Kill test (T01)

Can a real AWS Nitro attestation be validated on Celo Sepolia inside one transaction's gas limit? If not,
the design fails. This deploys base/nitro-validator's **demo** stack and runs its cold path with the
bundled real attestation, exactly as base's `script/BaseSepoliaDemo.s.sol` sends it.

- Chain: Celo Sepolia (11142220), RPC `https://forno.celo-sepolia.celo-testnet.org`.
- Code: base/nitro-validator at the pinned commit `0ea0d12` (ADR-001), `contracts/lib/nitro-validator`.
- Run: 2026-11-02, broadcast by Joshua from deployer `0xF31207eE5831fb2a7bFB6f844a4fb16776193964`, with
  `USE_BUNDLED_REAL_ATTESTATION=true` and `--gas-estimate-multiplier 110` (the simulation padded each
  validate call to 16,046,664 gas, under Celo's 16,777,216 per-transaction cap).
- These are demo contracts (`CertManagerDemo` accepts expired certificates within a grace period). The
  registry never uses them (SPEC §3.5); the production stack is in `docs/DEPLOYMENTS.md`.

Demo addresses: P384Verifier `0x485975462b921addB2C1Ad64FDD962e7C4E4b38e`, CertManagerDemo
`0x5aB5bfb3e8b39D12aAEF2075B3B4836baFAFC09D`, NitroValidator `0x1a1CEca1b358C17b3Fb0a4965BDF8ACed06557A5`.

| Kind | Name | Transaction |
|---|---|---|
| deploy | P384Verifier | 0xb581a2adf816be631abe5e750dee1c2ed0c93be5fc1c1038acc27b403d59e7eb |
| deploy | CertManagerDemo | 0x4642793c366c3773c4b072389c09363d96050d5b1cda9f4b0b38fe27baa3e7c7 |
| deploy | NitroValidator | 0xb1de54d54ae97636a0d8d27738aa9f19669f58ebd491128acdd8d5672b02b37e |
| call | verifyCACertWithHints (CA index 1) | 0x8685c3a154eea475ae7cb5490fdbc7fcff4f4233b364c73095df75900c0f8978 |
| call | verifyCACertWithHints (CA index 2) | 0x08ca0ea3a978808ac788a99616343c98a5106d465a8acb6e970259f7574e0d3c |
| call | verifyCACertWithHints (CA index 3) | 0xe48859922349c1b50d25dee787c9b9cd47569b565dc89baf72650be343ac42c5 |
| call | verifyClientCertWithHints | 0xb4f1d7dde86649def564b7c1a12228558563276d1e5d88413fea819ad365d3db |
| call | validateAttestationWithHints (cold) | 0xc32ca82c85fd0f0b8c56c35936c1ae6a62e7c73112986cdab1dc58afe8566096 |
| call | validateAttestationWithHints (warm) | 0x41642666e7f7a58285c8852c5479b4be744a1b7437d4c39bf4a7ddffd332f236 |

Gas used, from the receipts (blocks 40363205 to 40363248): deploys 1,734,631 / 5,382,414 / 3,621,490;
certificate caching 5,993,778 / 6,246,708 / 6,026,223 / 6,051,782; validate 12,967,002 (cold) and
12,967,002 (warm). The largest is 77% of the cap. Cold and warm cost the same here because the script
caches all four certificates before the first validate, so both validates run with a warm cache.
Total 60,991,030 gas, 3.0496 CELO at 50 gwei.
