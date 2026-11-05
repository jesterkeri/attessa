# T06/T07 review — round 4

Reviewed frozen commit `3f0177c` against T06/T07, SPEC §2.5, §3, INV-18, RFC 8785, and adr/001.

## Findings

### Critical

None.

### Major

None.

### Minor

None.

## Earlier findings

- **T06 r1 M1 — fixed.** `contracts/test/VectorsTest.t.sol:483-550` now executes every valid and invalid `vectors/headers.json` `attestedProof` case, checks decoded bytes and fields, and maps each invalid-vector reason to the Solidity error. The current vector run reports 20 passing tests.
- **T06 r3 M1 — fixed.** TypeScript checks the decoded byte stream before UTF-8/JSON/JCS at `packages/core/src/headers.ts:110-139`; Solidity does the same in `contracts/test/HeaderGrammar.sol`; and the independent oracle does so at `scripts/check-vectors-oracle.py:467-487`. Each treats the outer object as level 1, rejects level 33 as `too_deep`, ignores brackets in strings/escapes, and clamps stray closers at zero. The 32/33, escaped-string, and stray-closer header vectors pin those cases. The exact invalid-reason comparison in `VectorsTest.t.sol:541-550` and oracle run covers the required ordering (`base64`, then `too_deep`, then parsing/JCS/field checks).

## Assessment

The strict-base64 implementations accept only nonempty, canonical RFC 4648 standard-alphabet padded forms. The TypeScript scanner is linear rather than regex-based (`headers.ts:58-84`), then requires `Buffer`'s re-encoding to match; the Solidity decoder rejects malformed padding and nonzero pad bits; the Python oracle independently applies the same canonical round-trip. This removes the prior large-input regex overflow without moving depth validation behind JSON parsing.

The completeness claims hold for the changed header family: three valid and 27 invalid attested-proof vectors, including the one- and two-`=` forms, noncanonical padding bits, nesting 32/33, strings/escapes, and stray closers. Solidity consumes the complete valid and invalid lists, while the oracle recomputes each vector's result and checks the committed minimum family sizes.

T07 uses the upstream `P384Verifier -> CertManager -> NitroValidator` path (`contracts/test/fork/RealFixture.t.sol:68-79`), not `CertManagerDemo`; `NitroParseHarness` only exposes the inherited parser needed to cache the upstream certificate chain. The fixture hash is asserted before decoding. Part (a) first validates the genuine fixture and asserts the exact `BindingMismatch(0)` result (`:116-133`). Part (b) verifies that the source unprotected header is precisely an empty CBOR map, replaces just that map with a CBOR map holding an attacker key, a correctly ABI-encoded binding, and 512 bytes of padding (`:193-232`), then proves TBS hash/signature equality, validator acceptance, and the same registry rejection (`:135-152`). Part (c) measures precisely `validateAttestationWithHints` after copying inputs from test storage to memory, and enforces the 16,000,000 ceiling both measured and with the explicitly calculated MODEXP projection (`:154-191`).

## Verification

- `flock -w 1800 /home/hr/.cache/attessa-heavy.lock forge test --match-contract VectorsTest` from `contracts/`: 20 passed.
- `flock -w 1800 /home/hr/.cache/attessa-heavy.lock forge test --match-path 'test/adv/*'` from `contracts/`: 61 passed.
- `flock -w 1800 /home/hr/.cache/attessa-heavy.lock python3 -I scripts/check-vectors-oracle.py`: `checks: 487 fails: 0`.
- The recorded outside-sandbox verification at `93084fd` reports the complete core suite (69 passed) and all three real-fixture tests passed; the measured validator gas was 12,994,642, below the 16,000,000 threshold.

## U1–U9 record

- **U1:** This was a single-message review, so a genuine pre-prompt cold-read measurement was not possible. The U7 count below is indicative only.
- **U2:** Enumerated the changed header vector family and both its Solidity consumer loops; no claimed case was omitted. Also followed fixture, TBS, signature, binding, hints, and gas values to their assertions and registry consumers.
- **U3/U4:** The independently derived requirements are a bounded nonrecursive pre-parse scan, canonical base64, exact refusal precedence, and a test that exercises production certificate validation rather than merely COSE decoding. The implementation enforces each.
- **U5:** No materially changed path lacks a corresponding vector, adversary, or fixture assertion.
- **U6:** The harness is appropriate here: it does not substitute the demo validator stack, and its only addition is access to an inherited parser required by setup.
- **U7:** Findings: INSIDE 0, OUTSIDE 0. This is only a weak signal under U1's single-prompt caveat.
- **U8:** The local core test could execute 64 of 69 tests, but five pre-existing T03 adversarial tests could not spawn `cast` under the sandbox (`EPERM`); this is not a T06/T07 failure. The fork command could not resolve `forno.celo-sepolia.celo-testnet.org` in this sandbox, so the live fork result is taken from the recorded outside-sandbox output in `DONE.md`. I did not inspect credentials, environment files, or keys.
- **U9:** I swept the complete T06/T07 implementation paths and their direct dependencies. The staging-only changes merged at `d378b33` were outside this task's scope and were not treated as evidence for it.

Decision: SHIP
VERDICT: implementation-ready
