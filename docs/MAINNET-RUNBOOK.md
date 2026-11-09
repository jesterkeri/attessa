# Mainnet runbook (Celo 42220), written from the rehearsal of 2026-11-09

Legend. Who: **[J]** Joshua in his own terminal (keystores, anything that signs), **[H]** on the EC2 host `ec2-user@16.192.129.244` (his terminal), **[A]** an agent may run it (read-only).
Status: **R** = run in the rehearsal on a fork with the same command; **P** = partly run (differences named); **N** = not run, cannot be run on a fork.
Times are measured wall-clock on the rehearsal. Every send needs `LOOPS_ATTRIBUTION_TAG=<real tag>` in that shell (public value; never a key).
Known so far, real: ERC-8004 `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, Self registry `0xaC3DF9ABf80d0F5c020C06B04Cced27763355944`, USDC `0xcebA9300f2b948710d2653dD7B07f33A8B32118C`,
USA₮ `0xd2ab3c9a02dbbab236bfec45d1d755df4267f771`, host IP `16.192.129.244`, CertManager root-cert pin in the repo. Placeholders in `<angle brackets>` are not known yet.

## 0. Before anything (stop here if any line fails)

1. **[J] [N]** Funding at today's gas price (Forno 202.5 gwei when measured; re-read it: `cast gas-price --rpc-url https://forno.celo.org`). Measured need: deployer 2.87 CELO used, 3.73 worst case, so 6 is fine.
   Agent wallet 0.5 CELO is plenty (register 0.033 + transfer 0.014). Owner 0.1 CELO. **Operator: `signer register` is 8.63 CELO used and needs about 12.5 CELO in the wallet at the moment of the last transaction; 16 CELO is enough only up to about 250 gwei.** Renewal is 2.94 CELO every 7 days.
2. **[J] [N]** Staging contains `enclave/Dockerfile`: `git ls-tree origin/staging enclave/Dockerfile` must print a line. (In the rehearsal it was only on `feat/t12-enclave-spike`, merged in `e90e3fc`.) Also cherry-pick the two CLI fixes `475006a` and `a75333c`; without the second, `attessa status` fails on Forno.
3. **[J]** `export LOOPS_ATTRIBUTION_TAG=<tag> ATTESSA_ADMIN=<cold admin address> DEPLOYER=<deployer address>`; clean tree on the commit to deploy. `node scripts/check-deploy.mjs --pre-deploy` must print PASS. **[R]** (16 s)

## 1. DNS (start first, it has a delay)

4. **[J] [N]** GoDaddy: add an A record `seller` (host `seller.attessa.xyz`) -> `16.192.129.244`, lowest TTL. The apex stays on GitHub Pages. Do not touch the apex. `getent hosts seller.attessa.xyz` printed nothing during the rehearsal, so it does not exist yet. Check: `dig +short seller.attessa.xyz`.
   Ports 80 and 443 on the host are already open in the security group (probe: connection refused = reachable, nothing listening); 22 open; 7070/8080 filtered (good).
   What could block the morning: Let's Encrypt cannot issue until the record resolves from the internet; propagation with GoDaddy is usually minutes but can be longer. Do this before the deploy, not after. The origin registered on chain (`endpoint add`) must be exactly `https://seller.attessa.xyz`; a different spelling is a different origin hash.

## 2. Deploy the validator stack and registry (tagged route) [J]

Each step: run `prepare`, then the `cast send --create` line it prints (from the keystore), then `check`. **[R]** with viem sends in place of `cast send` (a hook blocks `cast send` for agents). Prepare takes 2-3 s; the whole local deploy took 45 s; on mainnet add block time per send.

5. `node scripts/tagged-deploy.mjs p384 --deployer $DEPLOYER --account <keystore-name>` -> run the printed `cast send --create ...` (gas 1,735,133 used) -> `node scripts/tagged-deploy.mjs check p384 <addr> --deployer $DEPLOYER --tx <hash>` -> `export ATTESSA_P384_VERIFIER=<addr>`
6. `node scripts/tagged-deploy.mjs certmanager --deployer $DEPLOYER --account <keystore-name>` -> send (5,366,539 gas) -> `check certmanager <addr> --deployer $DEPLOYER --tx <hash>` -> `export ATTESSA_CERT_MANAGER=<addr>`
7. `node scripts/tagged-deploy.mjs nitro --deployer $DEPLOYER --account <keystore-name>` -> send (3,621,995) -> `check nitro ...` -> `export ATTESSA_NITRO_VALIDATOR=<addr>`
8. `node scripts/tagged-deploy.mjs registry --deployer $DEPLOYER --account <keystore-name>` -> send (3,444,978) -> `check registry ...`
9. **[J]** Record: fill the five addresses in `docs/DEPLOYMENTS.md` (celo table) **and** `packages/core/src/deployments.ts` (`celo.enclaveRegistry` and `celo.validatorStack`; both are `null` today), commit, push, then `node scripts/check-deploy.mjs celo` must print `OK` x 27 and exit 0. **[R]** against fork addresses with a temporary DEPLOYMENTS file (the committed edit itself: **N**).
   After this commit the CLI, SDK, gateway and site take the registry from `deployments.ts`; `ATTESSA_REGISTRY` is ignored. The host must be on this commit (step 11).

## 3. Identity [J]

10. `export ATTESSA_PRIVATE_KEY` must come from his own shell and never be pasted anywhere. Register: `attessa agent register --name "<name>" --uri https://seller.attessa.xyz/agent.json --network mainnet` (run from a directory where `docs/agent.json` should land; 161,066 gas). **[R]** (2.4 s). Note the printed agent id `<AGENT_ID>`.
11. Optional by OPEN-QUESTIONS: `attessa agent transfer --agent <AGENT_ID> --to <cold owner> --network mainnet` **[R]** (3.4 s).
12. **[H]** within 5 minutes of each other (the signature deadline is 5 minutes): on the host with the agent wallet key in its own env: `attessa agent wallet-sig --agent <AGENT_ID> --owner <cold owner> --json --network mainnet`; then **[J]** from the cold owner: `attessa agent set-wallet --agent <AGENT_ID> --wallet <agent wallet> --sig <sig> --deadline <deadline> --network mainnet`. **[R]** (1.2 s + 3.0 s).

## 4. Host: build and start the enclave [H]

13. Update the host: `cd /opt/attessa && git fetch origin && git checkout --detach <deploy commit> && pnpm install --frozen-lockfile && pnpm -r build` **[R]** (54 s).
14. Build the image. Stop the allocator first (3 enclave vCPUs): `sudo systemctl stop nitro-enclaves-allocator.service`, `docker build -f enclave/Dockerfile -t attessa/enclave:<tag> .` (clean build 157 s, cached 1 s), `sudo systemctl start nitro-enclaves-allocator.service`, `nitro-cli build-enclave --docker-uri attessa/enclave:<tag> --output-file build/enclave.eif | tee build/measurements.json` **[R]**. The reproducible path `attessa enclave build` needs `ATTESSA_KANIKO_IMAGE=<kaniko executor @sha256:digest>`, which no document gives: **[N]**. **Build once. A second docker build gives different PCRs.** Approve the PCRs of this exact `.eif` and start this `.eif`.
15. Bridge: `socat TCP-LISTEN:5005,bind=127.0.0.1,fork,reuseaddr VSOCK-CONNECT:16:5000 &` (or `sudo systemctl start attessa-vsock@mainnet`, units are installed by the setup script and were **not** run in the rehearsal: **P**).
16. Approve the release **[J]** (copy `build/measurements.json` to his machine): `attessa release approve --agent <AGENT_ID> --from-build measurements.json --source https://github.com/jesterkeri/attessa/commit/<sha> --network mainnet` **[R]** (2.8 s, 68,642 gas).
17. **[J]** `attessa endpoint add --agent <AGENT_ID> --origin https://seller.attessa.xyz --pay-to <payTo address> --operator <operator address> --network mainnet` **[R]** (2.9 s, 105,141 gas). Registry has `allowLocalOrigins=false`, so only the https origin works.
18. **[H]** `attessa enclave start --agent <AGENT_ID> --origin https://seller.attessa.xyz --network mainnet --eif build/enclave.eif --out att.bin` **[R]** (1.4 s; against a fork RPC through a tunnel; on the real host the default Forno RPC is used). `nitro-cli describe-enclaves` must show `"Flags": "NONE"` (non-debug) and CID 16.

## 5. Signer [operator wallet]

19. **[H or J]** within 30 minutes of the attestation (`MAX_ATTESTATION_AGE` = 1800 s): `attessa signer register --agent <AGENT_ID> --attestation att.bin --network mainnet` (or `--fresh` through seller-host once it runs). **[R]** 19.6 s, 5 transactions: 4 certificate transactions (6.9-7.2M gas each) and `registerSigner` 14,639,544 gas (87.3% of the 16,777,215 cap). If it prints `gas_over_cap` or reverts, stop and tell the team: it is a blocker. Cost 8.63 CELO at 202.5 gwei.
20. **[J]** `attessa status --agent <AGENT_ID> --network mainnet` -> release Approved, endpoint Active, signer Active, valid 7 days. **[R]** (works only with fix `a75333c`).

## 6. Host services [H]

21. Create the config files described in `docs/EC2-RUNBOOK.md` section 5 in his own terminal (`seller-mainnet.json`, `gateway-mainnet.json` with `network: celo`, `facilitatorUrl` the real one, secrets 0600). The gateway config is the one used in the rehearsal plus the real `facilitatorUrl` and no `RPC_URL` (defaults to Forno). Rehearsal gateway/seller-host config shapes: **R** as plain processes, **N** as systemd units.
22. `sudo systemctl enable --now attessa-vsock@mainnet attessa-seller@mainnet attessa-gw@mainnet` **[N]** (only plain `node` processes were run). `journalctl -u attessa-seller@mainnet` must show `enclave_already_configured` and `listening`; the seller-host config must contain the same registry, agent id and origin as steps 8-17.
23. Caddy (TLS) **[N]**: `/etc/attessa/caddy.env` needs **both** `ATTESSA_ORIGIN_MAINNET=seller.attessa.xyz` and a non-empty `ATTESSA_ORIGIN_SEPOLIA` (an empty value stops Caddy from loading; a name that does not resolve only fails its own certificate). Then `sudo systemctl enable --now caddy`. Check: `curl -sI https://seller.attessa.xyz/v1/evaluate` from another machine answers (402 or 405), valid certificate.

## 7. First paid call and evidence

24. **[J, other machine]** `attessa call https://seller.attessa.xyz/v1/evaluate --body request-allow.json --max-amount 0.05 --network mainnet`. **[P]** (identical command against the fork, with the origin mapped to a local gateway and a fake facilitator): USDC verified in 7.2 s, USA₮ verified in 12.7 s (add `--asset usat`), tampered answer refused and not charged. `vectors/request-allow.json` does not exist in the repo; use a body like `{"chainId":"42220","payTo":"0x<40 lowercase hex>","asset":"0xceba9300f2b948710d2653dd7b07f33a8b32118c","amount":"5"}`.
25. Only seen for real: the actual x402 facilitator (its auth header, latency, `/supported`, settlement and fee), the real buy-paid chain reads, Caddy and Let's Encrypt, DNS, a real block clock (the rehearsal needed interval mining on the fork), a real gas price.
26. **[J]** `attessa gateway export --format csv --since 2026-11-01` and `attessa evidence export --format csv` **[N]**.

## 8. Weekly and recovery

27. Renewal before expiry: `attessa signer renew --network mainnet` (certificates cached: 1 transaction, 14,512,815 gas = 2.94 CELO). **[R]**
28. After an enclave restart (new key): steps 18-19 again (certificates are cached then, about 3 CELO).
