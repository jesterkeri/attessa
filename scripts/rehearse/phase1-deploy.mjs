#!/usr/bin/env node
// Rehearsal phase 1: the real tagged deploy route (scripts/tagged-deploy.mjs) against the local fork.
// Run from a CLEAN committed tree, under the heavy lock:  flock /home/hr/.cache/attessa-heavy.lock node scripts/rehearse/phase1-deploy.mjs
// Sends go to http://127.0.0.1 only (assertLocal). Throwaway keys, tag celo_rehearsal.
import { spawnSync } from 'node:child_process';
import { mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLocal, RPC, DIR, TAG, wallet, walletClient, fund, pub, rpc, realGasPriceWei, celoCost, save, ensureDir } from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STEPS = [['p384', 'ATTESSA_P384_VERIFIER'], ['certmanager', 'ATTESSA_CERT_MANAGER'], ['nitro', 'ATTESSA_NITRO_VALIDATOR'], ['registry', null]];
const info = await assertLocal();
console.log(`fork: block ${info.currentBlockNumber} ${JSON.stringify(info.forkConfig)}`);
ensureDir();
const deployer = wallet('deployer'), admin = wallet('admin');
await fund(deployer.address, 20);
const price = await realGasPriceWei();
console.log(`Forno eth_gasPrice ${price} wei (${Number(price) / 1e9} gwei)`);
const out = join(DIR, 'deploy'); mkdirSync(out, { recursive: true, mode: 0o700 }); chmodSync(out, 0o700);
const env = { ...process.env, LOOPS_ATTRIBUTION_TAG: TAG, ATTESSA_ADMIN: admin.address };
const node = (args) => spawnSync('node', args, { cwd: ROOT, env, encoding: 'utf8' });
let t0 = Date.now();
let r = node(['scripts/check-deploy.mjs', '--pre-deploy']);
console.log(`$ check-deploy --pre-deploy -> exit ${r.status} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n${(r.stdout + r.stderr).trim().split('\n').slice(-4).join('\n')}`);
if (r.status !== 0) process.exit(1);
const wc = walletClient(deployer.account);
const addrs = {}, rows = [];
for (const [step, envName] of STEPS) {
  t0 = Date.now();
  r = node(['scripts/tagged-deploy.mjs', step, '--deployer', deployer.address, '--account', 'rehearsal-keystore', '--rpc-url', RPC, '--out', out]);
  const text = r.stdout + r.stderr;
  console.log(`\n== ${step}: prepare exit ${r.status} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  console.log(text.split('\n').filter((l) => !/^cast send/.test(l)).join('\n').trim());
  if (r.status !== 0) { console.log(`STOP: prepare refused at ${step}`); process.exit(1); }
  const file = /data file\s+(\S+)/.exec(text)[1];
  const limit = BigInt(/gas limit\s+(\d+)/.exec(text)[1]);
  const est = BigInt(/gas estimate\s+(\d+)/.exec(text)[1]);
  const expected = /expected addr\s+(0x[0-9a-f]{40})/.exec(text)[1];
  const data = (await import('node:fs')).readFileSync(file, 'utf8').trim();
  const hash = await wc.sendTransaction({ data, gas: limit });
  const rc = await pub().waitForTransactionReceipt({ hash });
  console.log(`sent ${hash}: status ${rc.status}, gasUsed ${rc.gasUsed}, address ${rc.contractAddress}`);
  if (rc.status !== 'success' || rc.contractAddress.toLowerCase() !== expected) { console.log('STOP: send failed or address differs'); process.exit(1); }
  addrs[step] = rc.contractAddress;
  if (envName) env[envName] = rc.contractAddress;
  r = node(['scripts/tagged-deploy.mjs', 'check', step, rc.contractAddress, '--deployer', deployer.address, '--rpc-url', RPC, '--out', out, '--tx', hash]);
  console.log(`check --tx exit ${r.status}\n${(r.stdout + r.stderr).trim()}`);
  if (r.status !== 0) process.exit(1);
  rows.push({ step, est, used: rc.gasUsed, limit, cost: celoCost(rc.gasUsed, price) });
}
// check-deploy celo: needs DEPLOYMENTS.md + core file pointing at the fork addresses (its own flags), written outside the repo.
const { writeFileSync } = await import('node:fs');
const md = join(out, 'DEPLOYMENTS.md'), core = join(out, 'deployments.mjs');
const I = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', S = '0xaC3DF9ABf80d0F5c020C06B04Cced27763355944';
writeFileSync(md, `## celo\n\n| Name | Address |\n|---|---|\n| Admin | \`${admin.address}\` |\n| P384Verifier | \`${addrs.p384}\` |\n| CertManager | \`${addrs.certmanager}\` |\n| NitroValidator | \`${addrs.nitro}\` |\n| EnclaveRegistry | \`${addrs.registry}\` |\n| IdentityRegistry | \`${I}\` |\n| SelfRegistry | \`${S}\` |\n`);
writeFileSync(core, `export const DEPLOYMENTS = { celo: { chainId: 42220, identityRegistry: '${I}', selfRegistry: '${S}', enclaveRegistry: '${addrs.registry}', validatorStack: { p384Verifier: '${addrs.p384}', certManager: '${addrs.certmanager}', nitroValidator: '${addrs.nitro}' } } };\n`);
r = node(['scripts/check-deploy.mjs', 'celo', '--rpc-url', RPC, '--deployments', md, '--core', core]);
console.log(`\n== check-deploy celo exit ${r.status}\n${(r.stdout + r.stderr).trim()}`);
console.log(`\nGAS TABLE (CELO at Forno price ${Number(price) / 1e9} gwei)`);
let tot = 0n, totc = 0n;
for (const x of rows) { console.log(`${x.step.padEnd(12)} estimate ${x.est} limit ${x.limit} used ${x.used} cost ${x.cost} CELO (limit-cost ${celoCost(x.limit, price)})`); tot += x.used; totc += x.limit; }
console.log(`TOTAL used ${tot} = ${celoCost(tot, price)} CELO; sum of limits ${totc} = ${celoCost(totc, price)} CELO`);
save({ addrs: { ...addrs, admin: admin.address, deployer: deployer.address }, gasPrice: price.toString() });
process.exit(r.status);
