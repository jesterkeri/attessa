# Preflight (r5)

Run before every deploy (Sepolia and mainnet). Every line is a command or a yes/no observation. Never delete a line because it failed.

## Build
- [ ] Clean clone builds: `git clone … && pnpm install --frozen-lockfile && pnpm -r build && (cd contracts && forge build) && cargo build --release --locked --manifest-path enclave/Cargo.toml`
- [ ] Lint, typecheck, format clean: `pnpm -r lint && pnpm -r typecheck && (cd contracts && forge fmt --check) && cargo fmt --check --manifest-path enclave/Cargo.toml`
- [ ] Tests green, counts recorded here (ts / forge / cargo): ___ / ___ / ___
- [ ] Contracts: `forge coverage` EnclaveRegistry branches ≥ 90% (value: ___); Slither clean or triaged in `docs/SLITHER_TRIAGE.md`
- [ ] Vectors: all three suites pass on `vectors/`

## Secrets and access
- [ ] `./scripts/check-secrets.sh` passes
- [ ] `grep -rE '0x[0-9a-fA-F]{64}' packages/*/dist` returns no private-key-shaped values (only hashes in test fixtures, reviewed)
- [ ] Every registry write has a non-owner / non-operator refusal test (INV-5 suite green)
- [ ] Gateway: no admin routes; `curl -s https://$ORIGIN/healthz` returns only `{"ok":true}`
- [ ] Rate limit active: 31 liveness calls in 60 s → the 31st returns 429 `rate_limited` (SPEC §6.1)
- [ ] Seller-hosts listen on 127.0.0.1 only: `ss -ltnp | grep -E '707[01]'` shows only `127.0.0.1`
- [ ] Both sellers answer: `attessa status <mainnet origin>` and `attessa status <sepolia origin>` show signer Active and liveness OK

## Failure behaviour
- [ ] Every non-2xx gateway response has `error`, `message`, `suggestion`, `correlationId`, and no stack trace (`pnpm --filter @attessa/gateway test -- -t "error shape"`)
- [ ] CLI snapshots match FLOWS §6/§8 copy (`pnpm --filter @attessa/cli test`)
- [ ] Reconciler drill passed (T24) and its restart duration recorded: ___
- [ ] `scripts/health.sh --self-test` fires each alert once (signer expiry < 24 h, settle_pending > 60 s, paused)
- [ ] The tamper proxy and fake facilitator exist only in `attessa-gw@sepolia-test` (TEST_ONLY=1, 127.0.0.1:8083, not in the Caddyfile): `grep -l tamper deploy/` lists only that unit's config
- [ ] Point of no return written: registry deploy is final; settlement txs are final (PIPELINE.md)

## Operations
- [ ] Uptime monitor on `/healthz` alerting to Joshua's email; triggered once deliberately
- [ ] `scripts/health.sh` cron installed on EC2 (every 5 min)
- [ ] AWS billing alarm at $50 (budget 324 h ≈ $44)
- [ ] Facilitator credit balance checked (`/api/config` or dashboard): ___
- [ ] `GET /supported` confirms the deployed network's x402 v2 EIP-3009 tuple: mainnet `eip155:42220` USDC (and USA₮ before T32b), Sepolia `eip155:11142220` USDC. Paste the response date and selected asset: ___
- [ ] TLS valid for the origin; HSTS header present; `/.well-known/security.txt` published with a contact

## On chain
- [ ] Deploy simulated without `--broadcast`; expected addresses recorded
- [ ] Contract verification on Celoscan/Blockscout ready (`forge verify-contract …` command prepared)
- [ ] Registry has no admin (Slither `--print human-summary`; no owner functions)
- [ ] `node scripts/check-deploy.mjs <network>` prints OK: all four contracts' runtime code matches the production artifacts with immutables spliced (never CertManagerDemo, never a mock validator), admin owner, wiring
- [ ] Endpoint for the public origin added the same day as the registry deploy, before any announcement (L17)
- [ ] Both signers (mainnet, Sepolia) `expiresAt` cover the next 48 h; `attessa signer renew` drilled on Sepolia (T24); renew both on Nov 8
- [ ] `ownerOf(agentId)` is the cold owner, not the EC2 agent wallet (unless the rules forbid the transfer)
- [ ] CertManager owner/revoker is the admin key, not the deployer: `cast call $CERT_MANAGER "owner()(address)"`
- [ ] Our own mainnet txs carry the Loops attribution tag (`npx @celo/attribution-tags verify <tx>` on one deploy-adjacent tx)
- [ ] Agent registration JSON resolves and lists `supportedTrust: ["reputation","tee-attestation"]`

## Evidence
- [ ] DONE.md entries exist for this gate with real output
- [ ] `./scripts/check-reviews.sh` passes (Codex review at `implementation-ready`)
