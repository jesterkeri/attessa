# T34 README review r1 — `d2a257c`

Reviewed `README.md` at the frozen detached commit `d2a257c`. No transaction
was sent and no credential, `.env`, `.npmrc`, keystore, or key file was read.

## Findings

No critical, major, or minor finding.

## Claim and command checks

- The first paragraph is the FLOWS §1 premise line verbatim. The provenance,
  payment-order, owner-claim, and availability boundaries accurately match the
  described design and the selected Known Limits.
- All repository-map paths and root-document links exist. The package
  descriptions match their package/source boundaries, including the MCP
  tool list and the gateway/host split.
- Build/test commands are the AGENTS.md commands, including the correct
  contract subshells, invariant variables, Foundry-version location, Rust
  manifest, and Slither config. The stated CLI and gateway command families
  match the parser; `verify`, `call --via buy`, and `release verify` are
  correctly marked unavailable.
- The source-install instructions correctly use the CLI package’s global bin
  link. `keytar` is not a package dependency, so the wallet note accurately
  says a source install has no OS-keychain support and directs users to an
  environment key or V3 keystore instead.
- The README does not claim a live mainnet seller, paid mainnet call, or users.
  Its incomplete-work list agrees with T30–T35 remaining unchecked in
  `TASKS.md`, and its Selected Known Limits agree with the numbering and
  wording in `KNOWN-LIMITS.md`.
- Mainnet identity claims were independently checked with read-only Celo
  RPC calls. The cited transaction is a chain-`42220` transaction from
  `0x08ee…Bfe1` to the stated ERC-8004 registry; `ownerOf(10061)` returns
  that address, and `tokenURI(10061)` returns
  `https://attessa.xyz/.well-known/agent.json`. The public metadata is
  reachable, contains the mainnet registration `10061` at that registry, and
  explicitly says Attessa is not yet serving paid Celo-mainnet calls.

## Verification

The frozen worktree deliberately has no `node_modules`. A local attempted
command therefore produced the expected non-product failure before build:

```
pnpm --filter @attessa/cli build
sh: 1: tsc: not found
WARN Local package.json exists, but node_modules missing, did you mean to install?
```

I did not install dependencies solely to review documentation. Static command,
path, package, and source checks above were completed; full build/test results
are not independently reproduced in this review.

## U1–U9 record

- **U1:** This is a single-prompt review, so the INSIDE/OUTSIDE count is
  indicative rather than a blind-review measurement.
- **U2:** I checked the README’s universal/completeness claims against all
  listed commands, mapped packages, selected limits, and status bullets.
- **U3/U4:** Derived invariant: public status must distinguish an identity
  registration from a deployed seller and paid usage. The README does so, and
  its mainnet statement is corroborated by the registry and metadata reads.
- **U5:** No changed README behavior or assertion lacked a corresponding
  source/document check in the reviewed scope.
- **U6:** The README appropriately refuses to use an ERC-8004 identity alone
  as evidence of an operating service; it names the remaining mainnet deploy,
  seller, and call work explicitly.
- **U7:** Findings: **0 INSIDE, 0 OUTSIDE** (indicative only).
- **U8:** I opened the README, task/status/limits/deployment documents,
  package manifests, CLI/MCP source, and public read-only Celo/site evidence.
  The worktree lacks dependencies, so I could not compile or run the CLI;
  no live seller, gateway, enclave, or comprehensive repository test suite was
  exercised.
- **U9:** I swept command/package claims and public mainnet claims beyond the
  prose-only review boundary. This was not a whole-repository security audit.

REVIEW DECISION: SHIP
VERDICT: implementation-ready
