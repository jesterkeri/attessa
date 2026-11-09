# Mainnet dress rehearsal (2026-11-09, local fork + the real Nitro host)

Branch `feat/mainnet-rehearsal` (staging + mainnet-entry + T30 tagged deploy + the T12 enclave Dockerfile). Everything below ran on
an `anvil --fork-url https://forno.celo.org` at block 82,276,163 (chain id 42220, block gas limit 30,000,000, `--hardfork osaka
--enable-tx-gas-limit` so the 16,777,216 per-transaction cap of EIP-7825 is enforced). No transaction left the machine: every send went to
`http://127.0.0.1:18546` (the scripts refuse any other send RPC and require `anvil_nodeInfo`). Keys were fresh `cast wallet new` keys in a
mode-0700 directory, deleted at the end. Tag used: `celo_rehearsal`. Scripts: `scripts/rehearse/`.

## Launch blockers and risks found (read this first)

No transaction exceeded the cap. **No launch blocker from gas.** The closest call is the real `registerSigner`: **14,639,544 gas = 87.3% of
the 16,777,215 cap**, with a real AWS attestation (calldata 32,388 bytes). Headroom is about 2.1M gas; a longer certificate chain or AWS
changing its CA chain could push it over, and the CLI then refuses (`gas_over_cap`) rather than sending.

Blockers or must-do items, in order of danger:

1. **`enclave/Dockerfile` and the host scripts are not on staging.** They exist only on `feat/t12-enclave-spike`. The mainnet commit must
   contain them (merged here as `e90e3fc`). Without the Dockerfile there is no enclave image.
2. **Two CLI bugs would have broken the morning run; both fixed here** (see Bugs). `attessa agent register` crashed with ENOENT after
   it had already sent the transaction (no `docs/` directory), and `attessa status` / `signer register` read registry logs from block 0,
   which Forno rejects (max 5000 blocks): on mainnet `status` would have said "Can't reach Celo".
3. **`packages/core/src/deployments.ts` `celo.enclaveRegistry` is `null`.** After the real deploy it must be filled in (with
   `validatorStack`), committed, pushed, and the host rebuilt, or every `--network mainnet` command fails with "no registry". Once it is filled,
   `ATTESSA_REGISTRY` is ignored, so this cannot be rehearsed with a different registry after that edit.
4. **Docker image builds are not reproducible**: a cached build gave PCR0 `44df64f8...`, a `--no-cache` rebuild of the same commit on the same
   host gave PCR0 `fb037fb3...` and a different PCR2. Approve the PCRs of the exact `.eif` you will start, from the same build, and never rebuild
   between `release approve` and `enclave start`. The reproducible `attessa enclave build` (kaniko) path was **not run**: no document gives a value
   for `ATTESSA_KANIKO_IMAGE` (it must be a digest-pinned image).
5. **Cost copy is stale at today's gas price.** Forno `eth_gasPrice` is 202.5 gwei now. Measured: `signer register` with a real attestation is
   8.63 CELO (FLOWS text says "about 4-6 CELO, up to 8"), and `signer renew` is 14.5M gas = 2.94 CELO per week (the CLI prints "about 0.01 CELO"
   on the fork only because the fork's gas price decays to 1 gwei; on Forno it would quote correctly).
6. **Operator funding**: the CLI refuses to sign unless balance >= gas x maxFeePerGas, with maxFeePerGas = 2 x gas price. For the final
   `registerSigner` that is 16,777,214 x 405 gwei = 6.8 CELO *after* the four certificate transactions have cost 5.66 CELO, so the operator needs
   about 12.5 CELO at 202.5 gwei; 16 CELO works, but only up to a gas price of about 250 gwei. Fund more if the price rises before the run.
7. `vectors/request-allow.json` (used by T22 and the brief) **does not exist** in the repo. The rehearsal used a body made from SPEC §4.3.
8. The **test-only tamper proxy (T23) does not exist** in the code (no `TEST_ONLY` anywhere). The rehearsal used a throwaway proxy
   (`scripts/rehearse/tamper-proxy.mjs`) in front of seller-host.
9. DNS: `seller.attessa.xyz` does not resolve yet. Ports 80 and 443 on 16.192.129.244 answer "connection refused" (open in the security group, nothing
   listening), 22 is open, 7070 and 8080 are filtered. Let's Encrypt needs the A record first.

## Phase 0, the fork

`scripts/rehearse/phase0-fork.sh 18546` (18545 was already used by someone else's non-fork anvil, which I left alone):

```
"hardFork":"Osaka" ... "gasLimit":"0x1c9c380" (30,000,000) ... "forkBlockNumber":82276163 ... "network":"celo"
```
Forno `eth_gasPrice` read at run time: 202,500,000,000 wei (202.5 gwei); latest Forno block base fee 200 gwei. ERC-8004 at 0x8004A169... answered on the fork.
Fork clock: new blocks take the wall clock, but a fork with no new blocks has an old head; the CLI compares attestations and the gateway compares
"inputs block" against the head. Run `evm_setIntervalMining 1` (done after the first stale-inputs failure). Not a product bug.

## Phase 1, deploy (the real tagged route), PASS

`flock ... node scripts/rehearse/phase1-deploy.mjs` (45 s in total). `check-deploy --pre-deploy` PASS (16 s); each step ran
`scripts/tagged-deploy.mjs <step>` for real, the sends went through viem with the printed data and gas limit, then `check --tx` passed (creation input
= reference bytecode ++ args ++ suffix, CREATE address as printed), then `check-deploy.mjs celo` ("OK: all 27 checks passed") using the fork addresses.
Admin differed from the deployer.

```
p384         estimate 1735133 limit 2255673 used 1735133 cost 0.3513644325 CELO (limit-cost 0.4567737825)
certmanager  estimate 5366539 limit 6976501 used 5366539 cost 1.0867241475 CELO (limit-cost 1.4127414525)
nitro        estimate 3621995 limit 4708594 used 3621995 cost 0.7334539875 CELO (limit-cost 0.953490285)
registry     estimate 3444978 limit 4478472 used 3444978 cost 0.697608045 CELO (limit-cost 0.90689058)
TOTAL used 14168645 = 2.8691506125 CELO; sum of limits 18419240 = 3.7298961 CELO   (at 202.5 gwei)
```
Deployer funding of 6 CELO covers the 3.73 CELO worst case. Fork addresses (not real): P384 0xd05676c2..., CertManager 0x050a7bb8..., NitroValidator 0x80f31f1c...,
EnclaveRegistry 0x6a967524.... Calldata of each creation ends with `63656c6f5f72656865617273616c0e00` + `80218021` x 8 (tag `celo_rehearsal`).

## Phase 2, identity, PASS (after a fix)

```
$ attessa agent register (no LOOPS_ATTRIBUTION_TAG) -> exit 1
LOOPS_ATTRIBUTION_TAG is not set (or is not a valid code), ... Nothing was signed.
$ attessa agent register --network local --rpc http://127.0.0.1:18546 (tag set) -> exit 0 (2371 ms)
Registered: agent 10058  (tx 0xda00...b4). Next: attessa enclave build.
tx to 0x8004a169fb4a3325136eb29fa0ceb6d2e539a432, input 164 bytes, ends with 80218021802180218021802180218021
tag celo_rehearsal present in calldata: true; ERC-8021 marker at end: true
gas used 161066 = 0.032615865 CELO at 202.5 gwei
```
CLI notes: `--network local` against a chain-42220 RPC is treated as mainnet (tag required) as designed. The CLI is told a fresh registry through env
`ATTESSA_REGISTRY` (used for every command here); `agent register` itself needs no registry (identity registry is pinned). It writes `docs/agent.json` in the
current directory. The prompt says "about 0.02 CELO"; measured 0.033 CELO at today's price.

## Phase 3, real enclave and signer registration, PASS

Host: image built from pushed commit `d7cc935` (`phase3-host-build.sh`): `pnpm install + build` 54 s, docker build (cached) 1 s, `nitro-cli build-enclave`
non-debug. A `--no-cache` rebuild takes 157 s (and gives different PCRs, see blocker 4). PCRs approved and run:

```
PCR0 44df64f80030e7355a32e656408a7df9aa77984edca74116f9c450f69300211ba7867188d8c409e6176339f313dac2a5
PCR1 3b4a7e1b5f13c5a1000b3ed32ef8995ee13e9876329f9bc72650b918329ef9cf4e2e4d1e1e37375dab0ba56ba0974d03
PCR2 e85759a34cf295e261dcaad5abfd1cec1d9d2cc565b6fdbf0724c3752d89f2464e5fcd1d617df47904329cbb993cd2ff
```
Owner sequence with the real CLI on the fork (T31 order), all exit 0, each about 3 s: `agent transfer` -> `agent wallet-sig` (host-side, 5-minute deadline) ->
`agent set-wallet` -> `release approve --from-build measurements.json` -> `endpoint add --origin https://seller.attessa.xyz --pay-to .. --operator ..`.
Registry used: the **production-style** one (`allowLocalOrigins=false`, https origin); no second registry was needed, because the buyer run maps the https origin to
the local gateway with a fetch preload (`scripts/rehearse/origin-map.mjs`). Gas of the owner transactions: transfer 68,810, setAgentWallet 68,034, approveRelease 68,642,
addEndpoint 105,141 (all about 0.014-0.021 CELO).

Enclave on the host, through an `ssh -R` tunnel to the fork, with the real CLI (1.4 s):
```
$ attessa enclave start --agent 10058 --origin https://seller.attessa.xyz --network mainnet --rpc http://127.0.0.1:18546 --eif ~/rehearsal/build/enclave.eif
Starting the sealed machine ... running (Nitro enclave, 1 vCPU, 1 GiB)
It made a fresh signing key and AWS signed a report of what's running  (attestation written to att-mainnet.bin; register within 30 minutes ...)
describe-enclaves: "EnclaveCID": 16, "State": "RUNNING", "Flags": "NONE"   (non-debug)
```
`attessa signer register --agent 10058 --attestation att.bin` (real AWS attestation, 4 certificates, none cached, operator wallet), 19.6 s:

```
tx 0x2451... CertManager gasUsed 6915038 (41.2% of cap 16777215) cost 1.4003 CELO
tx 0xa106... CertManager gasUsed 7167820 (42.7% of cap)           cost 1.4515 CELO
tx 0xd9be... CertManager gasUsed 6931325 (41.3% of cap)           cost 1.4036 CELO
tx 0x8f53... CertManager gasUsed 6952570 (41.4% of cap)           cost 1.4079 CELO
tx 0xbf48... EnclaveRegistry registerSigner gasUsed 14639544 (87.3% of cap) cost 2.9645 CELO
5 transactions, total gas 42606297, max single 14639544 under the cap, total cost 8.6277751425 CELO (at 202.5 gwei)
Signer 0x0a57...27 is live for seller.attessa.xyz, running agent 10058's approved build   Valid until Nov 16 04:20 UTC
```
A first attempt failed with "the machine's report is dated ahead of Celo's clock" because the fork's head was minutes old (fork-only; fixed by mining a block first).
Freshness rule: `MAX_ATTESTATION_AGE = 1800` s (30 min). `attessa signer renew --seller-host http://127.0.0.1:7070` (certificates now cached, 1 tx): **14,512,815 gas = 2.94 CELO**.
`attessa status --agent 10058` shows release Approved, endpoint Active, signer Active.

## Phase 4, paid calls against the real enclave, PASS

seller-host on the host with the **mainnet** config shape (`network: mainnet`, enclave CID 16 via socat 5005, port 7070, `fornoUrl` = the fork through the tunnel,
`enclave_already_configured` logged because the CLI had configured it). Gateway (`network: celo`) and fake facilitator ran locally; the gateway's facilitator URL is a config
field, so no code change was needed. The fake facilitator (`fake-facilitator.mjs`) refuses to start unless the RPC is a local anvil and settles with the real token's
`transferWithAuthorization` on the fork. Buyer: a separate throwaway wallet funded by impersonating real holders (2 USDC and 2 USA₮).

```
USDC before: buyer 2000000, seller payTo 0
$ attessa call https://seller.attessa.xyz/v1/evaluate --body request-allow.json --max-amount 0.05 --asset usdc -> exit 0 (7.2 s)
{"outcome":"verified", ... "settlementTx":"0x831c6dc0...","signer":"0x0a5700c3...","inputsChecked":true}
"Paid 0.02 USDC. The answer came from that approved build, for this request, using Celo data from block 82,276,180"
USDC after:  buyer 1980000 (delta -20000), seller payTo 20000 (delta 20000)
```
Tampered answer (proxy between gateway and seller-host flips the response; gateway log `proof_rejected ... response_hash_mismatch`):
```
"Refused: the answer doesn't match what the sealed machine signed  (response hash differs from the proof)"
"Not charged: confirmed on Celo, your payment permission expired unused  (block 82,276,183)"
USDC after: buyer 1980000 (delta 0), seller payTo 20000 (delta 0)
```
The CLI waited 120 s of chain time for the authorization to expire (it took 360 s wall time on the fork only because the fork head was not advancing).
USA₮ (0xd2ab..., EIP-5267 domain, gateway offers both assets): first try refused `stale_inputs` (stale fork head, correct refusal, not charged); after interval mining:
```
$ attessa call ... --asset usat -> exit 0 (12.7 s)   "outcome":"verified","settlementTx":"0x74b64633..."
USAT after:  buyer 1980000 (delta -20000), seller payTo 20000 (delta 20000)
```
Fake-facilitator settle gas (what a real facilitator pays per call): USDC 103,278, USA₮ 105,078 (about 0.021 CELO each at 202.5 gwei).

Not rehearsed: the real x402 facilitator (auth, `/supported`, latency, real settlement), the real `buy` paid reads (seller-host read inputs through the fork instead), Caddy and
TLS, DNS, `attessa enclave build` with kaniko, systemd units (everything ran as plain processes), `attessa gateway export`, `evidence export`, the CLI's
`--network mainnet` code path with a filled-in `deployments.ts`, the Self link (T08), and the kill/pause drills.

## Bugs found and fixed (cherry-pickable)

| Commit | Message |
|---|---|
| `475006a` | Rehearsal fix: agent register crashed with ENOENT after sending when docs/ did not exist (writeFile now creates the directory) |
| `a75333c` | Rehearsal fix: status and signer register read registry logs from block 0, which Forno rejects (max 5000 blocks); scan in windows from the creation block |

Both have tests (`packages/cli/test/rehearsal-fsutil.test.ts`, `rehearsal-logs.test.ts`); the full CLI suite passes (94 files, 388 tests).
The SDK's `sourceRef` still reads `fromBlock: 'earliest'` (best effort, errors swallowed), so on Forno the "owner says built from ..." claim may be missing for buyers;
not changed here.
