# EC2 runbook: from a logged-in AWS CLI to T12 passing

**These scripts have not yet run on a real instance.** They were written and checked with `bash -n` and a
test that reads them; no AWS command was run. Expect to fix a line or two. Stop at the first surprise.
Steps marked **[Joshua]** spend money or broadcast; everything else only prepares. Variable names only below.

## 0. The host already exists: skip step 1

`i-01d8e704fba8616b3` (`attessa-host`, c6g.xlarge, enclaves on) has run in `eu-north-1` since 2026-11-07, Elastic IP
`16.192.129.244`, key pair `attessa-host`. The account's organization denies EC2 calls in `us-east-1`. Allow SSH from
your current IP, and start the host if needed, with `.worktrees/prompts/aws-host-setup.sh`. Step 1 is only for a rebuild.

## 1. Launch (your machine, AWS CLI logged in)

1. See what it will do: `./scripts/ec2-launch.sh <key-pair-name> <your-ip>/32`
2. **[Joshua]** Create the instance (billable): `./scripts/ec2-launch.sh <key-pair-name> <your-ip>/32 --run`
   It prints the instance id and the Elastic IP. Opens 22 (your CIDR only), 80, 443. Nothing else.

## 2. DNS (GoDaddy, **[Joshua]**)

One A record: `<seller-subdomain>` (e.g. the Sepolia origin) of `attessa.xyz` -> the Elastic IP. The apex and
`www` stay on GitHub Pages. A second A record for the mainnet subdomain is needed only when mainnet is served
(SPEC §5 has one site per network); do not announce it early (L17).

## 3. Host setup (on the instance)

```
ssh -i <key.pem> ec2-user@<elastic-ip>
curl -fsSLO https://raw.githubusercontent.com/jesterkeri/attessa/<commit>/scripts/ec2-host-setup.sh
chmod +x ec2-host-setup.sh && ./ec2-host-setup.sh <commit>
exit        # log back in so the docker and ne groups apply
```
`<commit>` is a 40-hex commit on the public repo (push first). Safe to re-run. It starts no Attessa service.
`/etc/attessa` is `root:attessa-gw` mode 750, not 700, because the units read their JSON from it (comment in the script).

## 4. T12 spike S2 (on the instance)

```
cd /opt/attessa
pnpm install --frozen-lockfile && pnpm -r build     # already done by setup; harmless
nitro-cli --version                                  # expect 1.5.2
grep -E 'memory_mib|cpu_count' /etc/nitro_enclaves/allocator.yaml
./scripts/t12-spike.sh
node scripts/inspect-attestation.mjs att.bin && nitro-cli describe-enclaves | jq length
```
Done when (TASKS T12): public_key length 65, user_data length 160, PCR0/1/2 non-zero, timestamp within 60 s,
and `3` (if `2`, record it: the test enclave then runs only after stopping the Sepolia one). Paste the real
output into DONE.md. The spike stops its enclaves on exit.

## 5. Before T23 / serving (still on the instance)

1. Fill `/etc/attessa/caddy.env` with `ATTESSA_ORIGIN_MAINNET` and `ATTESSA_ORIGIN_SEPOLIA` (host names, no
   `https://`; an empty value stops Caddy from loading). Until the mainnet name resolves, Let's Encrypt will
   fail for that site only.
2. Config files the units expect, per network `<n>` = `mainnet` or `sepolia`:
   `/etc/attessa/seller-<n>.json`, `/etc/attessa/gateway-<n>.json` (SPEC §6.6), `/etc/attessa/gateway-<n>.secret`
   (holds `FACILITATOR_API_KEY`, optional `RPC_URL`), and `/etc/attessa/seller-<n>.secret` (holds
   `AGENT_PRIVATE_KEY`; mainnet only, SPEC §5). Create secrets in your own terminal, mode 0640, owner root,
   group `attessa-gw` (gateway) or `attessa-seller` (seller); never paste them anywhere.
3. `sudo systemctl enable --now caddy` then, per network, `attessa-vsock@<n>`, `attessa-seller@<n>`,
   `attessa-gw@<n>`. The enclave itself is started with `attessa enclave start` (CLI), not a unit.
4. Caddy proxies only 127.0.0.1:8080 (mainnet) and 127.0.0.1:8081 (Sepolia). The test gateway
   (`attessa-gw@sepolia-test`, 127.0.0.1:8083) is never in the Caddyfile; reach it by SSH tunnel.

## 6. T30 and T31, summary (not run here)

- **T30 mainnet deploy: [Joshua] broadcasts.** `forge script` is prepared and simulated without `--broadcast`;
  Joshua broadcasts, then `node scripts/check-deploy.mjs celo` must print `OK` for every check and
  `docs/DEPLOYMENTS.md` gets the explorer links. See TASKS.md T30 and `docs/DEPLOYMENTS.md`.
- **T31 mainnet identity and seller, same day, before any announcement (L17): [Joshua] signs.** Register the
  ERC-8004 agent, transfer to the cold owner only if the OPEN-QUESTIONS rules item allows it, then within one
  5-minute window `attessa agent wallet-sig` on EC2 and `attessa agent set-wallet` from the cold owner;
  release approve, endpoint add, signer register. Verify with `attessa status --agent $AGENT_ID --network mainnet --json`
  and `cast call ... ownerOf`. See TASKS.md T31 and PREFLIGHT.md.
