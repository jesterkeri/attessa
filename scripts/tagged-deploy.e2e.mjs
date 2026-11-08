#!/usr/bin/env node
// T30 end-to-end proof, local chain only: the tagged creation route, all four contracts, in order.
//
//   node scripts/tagged-deploy.e2e.mjs        (clean committed tree; needs anvil, forge, cast, git, network for one git clone)
//
// An anvil on 127.0.0.1, chain id 42220, no fork. Sender and admin are anvil's own dev accounts
// (unlocked, so no key is read or held). Nothing reaches a public RPC; the only network use is one
// `git clone` of celo-org/attribution-tags (pinned commit, no install scripts) for its real verifyTx.
// The identity and Self registries get a one-byte stub code (anvil_setCode) because the registry step
// refuses to run without code at the pinned addresses and the constructor never calls them.
//
// For each of P384Verifier, CertManager, NitroValidator, EnclaveRegistry it runs scripts/tagged-deploy.mjs
// for real (preflight, reference build, data file, estimate), sends the file's data, and proves:
//   1. the Celo attribution-tags verifyTx (real code) and ox/erc8021 find the tag on the mined creation tx (to = null)
//   2. runtime code equals the reference artifact (immutables spliced) and an untagged control deployment
//   3. constructor-set state equals the control: storage slots 0..31 and every getter
//   4. the address is the CREATE address of sender and nonce printed before sending
//   5. tagged-deploy's own `check` passes, then scripts/check-deploy.mjs celo passes against the local stack
// Not covered: `cast send --create` itself (a repo hook blocks running cast send; the harness sends the same data
// with eth_sendTransaction), the real forno, and the real identity and Self registries (stub code here).
// Any failure stops the run: this route must not be used.

import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync, realpathSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, PINS, expectedRuntime, keccak } from './check-deploy.mjs';
import { prepare, check, realDeps, createAddress } from './tagged-deploy.mjs';
import { attributionSuffix } from '../packages/core/src/attribution.ts';

const TAG = 'celo_0123456789ab'; // synthetic, the shape Loops assigns: celo_ + 12 hex
const ATTR_TAGS_COMMIT = '2109b0428cdda158309fa1a754e983475071c074';
const STEPS = [
  ['p384', 'P384Verifier'],
  ['certmanager', 'CertManager'],
  ['nitro', 'NitroValidator'],
  ['registry', 'EnclaveRegistry'],
];

let failures = 0;
const results = {};
function ok(name, cond, detail) {
  const line = `${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `: ${detail}`}`;
  console.log(`      ${line}`);
  if (!cond) {
    failures++;
    throw new Error(`${name}: ${detail}`);
  }
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => res(port));
  });
  s.on('error', rej);
});

async function main() {
  const cleanup = [];
  const finish = () => {
    for (const f of cleanup.reverse()) {
      try {
        f();
      } catch {}
    }
  };
  process.on('SIGINT', () => {
    finish();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    finish();
    process.exit(143);
  });
  try {
    await run(cleanup);
  } finally {
    finish();
  }
}

async function run(cleanup) {
  const work = mkdtempSync(join(tmpdir(), 'tagged-e2e-'));
  cleanup.push(() => rmSync(work, { recursive: true, force: true }));
  const outDir = join(work, 'out');

  // ---- anvil
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const anvil = spawn('anvil', ['--chain-id', '42220', '--port', String(port), '--host', '127.0.0.1', '--silent'], { stdio: 'ignore' });
  cleanup.push(() => anvil.kill('SIGKILL'));
  const rpc = async (method, params = []) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const b = await r.json();
    if (b.error) throw new Error(`${method}: ${b.error.message}`);
    return b.result;
  };
  for (let i = 0; ; i++) {
    try {
      await rpc('eth_chainId');
      break;
    } catch {
      if (i > 100) throw new Error('anvil did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const [deployer, admin] = (await rpc('eth_accounts')).map((a) => a.toLowerCase());
  console.log(`anvil ${url} chain ${parseInt(await rpc('eth_chainId'), 16)}, deployer ${deployer}, admin ${admin} (anvil dev accounts)`);
  for (const a of [PINS.celo.identityRegistry, PINS.celo.selfRegistry]) await rpc('anvil_setCode', [a, '0x00']);

  // ---- the real attribution tooling, from a pinned clone, in its own empty directory
  let sdkSrc = process.env.ATTRIBUTION_TAGS_SDK;
  const viemReal = realpathSync(createRequire(join(ROOT, 'packages/core/package.json')).resolve('viem'));
  const oxDir = join(viemReal.slice(0, viemReal.lastIndexOf('node_modules') + 'node_modules'.length), 'ox');
  if (!sdkSrc) {
    const dir = join(work, 'attribution-tags');
    mkdirSync(dir);
    execFileSync('git', ['clone', '--quiet', 'https://github.com/celo-org/attribution-tags.git', dir], { stdio: 'pipe' });
    execFileSync('git', ['-C', dir, 'checkout', '--quiet', ATTR_TAGS_COMMIT], { stdio: 'pipe' });
    mkdirSync(join(dir, 'sdk', 'node_modules'));
    symlinkSync(existsSync(oxDir) ? oxDir : join(ROOT, 'node_modules', 'ox'), join(dir, 'sdk', 'node_modules', 'ox'));
    sdkSrc = join(dir, 'sdk', 'src', 'index.ts');
  }
  const { verifyTx, fromDataSuffix } = await import(pathToFileURL(sdkSrc).href);
  const { Attribution } = await import(pathToFileURL(join(realpathSync(join(dirname(dirname(sdkSrc)), 'node_modules', 'ox')), '_esm', 'erc8021', 'index.js')).href);
  console.log(`attribution-tags verifyTx from ${ATTR_TAGS_COMMIT.slice(0, 12)} (${typeof verifyTx}), ox Attribution (${typeof Attribution?.fromData})`);

  // ---- the route
  const suffix = attributionSuffix(TAG);
  const base = realDeps(url);
  let arts;
  const deps = { ...base, tmp: () => outDir, loadReference: () => (arts ??= base.loadReference()) };
  const env = { LOOPS_ATTRIBUTION_TAG: TAG, ATTESSA_ADMIN: admin };
  const addrs = {};
  const sel = (n, sig) => '0x' + arts[n].methodIdentifiers[sig];
  const send = async (data, gas) => {
    const hash = await rpc('eth_sendTransaction', [{ from: deployer, data, gas: '0x' + gas.toString(16) }]);
    let rc = null;
    for (let i = 0; i < 100 && !rc; i++) {
      rc = await rpc('eth_getTransactionReceipt', [hash]);
      if (!rc) await new Promise((r) => setTimeout(r, 100));
    }
    return { hash, rc };
  };
  const GETTERS = {
    P384Verifier: [],
    CertManager: ['owner()', 'revoker()', 'p384Verifier()'],
    NitroValidator: ['certManager()', 'p384Verifier()'],
    EnclaveRegistry: ['identityRegistry()', 'nitroValidator()', 'selfRegistry()', 'allowLocalOrigins()'],
  };
  const envName = { p384: 'ATTESSA_P384_VERIFIER', certmanager: 'ATTESSA_CERT_MANAGER', nitro: 'ATTESSA_NITRO_VALIDATOR' };

  for (const [step, name] of STEPS) {
    console.log(`\n[${step}] ${name}`);
    const lines = [];
    const a = { positional: [], deployer, account: 'e2e-keystore-name', rpcUrl: url, out: null, tx: null };
    const prep = await prepare(step, a, env, deps, (l) => lines.push(l));
    for (const l of lines) console.log(`      ${l}`);
    const data = readFileSync(prep.file, 'utf8').trim();
    ok(`${step}: the data file ends with the suffix`, data.endsWith(suffix.slice(2)), 'it does not');
    ok(`${step}: the printed command is cast send --create with --account, no key flag`, lines.some((l) => /^cast send --create .* --account '[^']+' --from 0x[0-9a-f]{40} --rpc-url '[^']+' --gas-limit \d+$/.test(l)) && !lines.join('\n').match(/private-key|--mnemonic|--interactive/), 'unexpected command');

    // send the file's data, tagged
    const { hash, rc } = await send(data, prep.gasLimit);
    ok(`${step}: the creation mined`, rc?.status === '0x1', `status ${rc?.status}`);
    const addr = rc.contractAddress.toLowerCase();
    ok(`4. ${step}: deployed at the CREATE address printed beforehand ${prep.expected}`, addr === prep.expected, `got ${addr}`);
    ok(`4. ${step}: and createAddress(deployer, nonce ${prep.nonce}) agrees`, createAddress(deps, deployer, prep.nonce) === addr, 'mismatch');
    addrs[step] = addr;
    if (envName[step]) env[envName[step]] = addr;
    const used = parseInt(rc.gasUsed, 16);
    console.log(`      gas used ${used} of limit ${prep.gasLimit}`);

    // 1. the attribution tooling on the mined transaction
    const tx = await rpc('eth_getTransactionByHash', [hash]);
    ok(`1. ${step}: the mined transaction has to = null (a creation)`, tx.to === null, `to ${tx.to}`);
    ok(`1. ${step}: input on chain equals the data file`, tx.input.toLowerCase() === data, 'differs');
    const v = await verifyTx({ client: { getTransaction: async ({ hash: h }) => rpc('eth_getTransactionByHash', [h]) }, hash });
    ok(`1. ${step}: celo-org/attribution-tags verifyTx returns the tag (${JSON.stringify(v)})`, v && v.schemaId === 0 && v.codes.length === 1 && v.codes[0] === TAG, `got ${JSON.stringify(v)}`);
    const ox = Attribution.fromData(tx.input);
    ok(`1b. ${step}: (separate check) ox/erc8021 Attribution.fromData agrees`, ox && ox.codes?.[0] === TAG, `got ${JSON.stringify(ox)}`);

    // control: the same creation without the suffix, from the same sender
    const baseData = '0x' + data.slice(2, data.length - (suffix.length - 2));
    const ctl = await send(baseData, prep.gasLimit);
    ok(`${step}: the untagged control mined`, ctl.rc.status === '0x1', 'failed');
    const caddr = ctl.rc.contractAddress.toLowerCase();
    const ctlTx = await rpc('eth_getTransactionByHash', [ctl.hash]);
    ok(`1. ${step}: control has no tag for verifyTx`, (await verifyTx({ client: { getTransaction: async () => ctlTx }, hash: ctl.hash })) === null, 'control looks tagged');

    // 2. runtime code
    const code = (await rpc('eth_getCode', [addr, 'latest'])).toLowerCase();
    const ccode = (await rpc('eth_getCode', [caddr, 'latest'])).toLowerCase();
    ok(`2. ${step}: runtime code equals the untagged control (${(code.length - 2) / 2} bytes, keccak ${keccak(Buffer.from(code.slice(2), 'hex')).slice(0, 18)}...)`, code === ccode && code.length > 2, 'differs');
    const values = {
      P384Verifier: {},
      CertManager: { p384Verifier: addrs.p384 },
      NitroValidator: { certManager: addrs.certmanager, p384Verifier: addrs.p384 },
      EnclaveRegistry: { identityRegistry: PINS.celo.identityRegistry, nitroValidator: addrs.nitro, selfRegistry: PINS.celo.selfRegistry, allowLocalOrigins: false },
    }[name];
    ok(`2. ${step}: runtime code equals the reference artifact with immutables spliced`, code === expectedRuntime(arts[name], name, values), 'differs');

    // 3. state equals the control
    for (let i = 0; i < 32; i++) {
      const s = '0x' + i.toString(16);
      const x = await rpc('eth_getStorageAt', [addr, s, 'latest']);
      const y = await rpc('eth_getStorageAt', [caddr, s, 'latest']);
      if (x !== y) ok(`3. ${step}: storage slot ${i} equals the control`, false, `${x} vs ${y}`);
    }
    ok(`3. ${step}: storage slots 0..31 equal the control`, true);
    const read = {};
    for (const g of GETTERS[name]) {
      const x = await rpc('eth_call', [{ to: addr, data: sel(name, g) }, 'latest']);
      const y = await rpc('eth_call', [{ to: caddr, data: sel(name, g) }, 'latest']);
      read[g] = x;
      if (x !== y) ok(`3. ${step}: ${g} equals the control`, false, `${x} vs ${y}`);
    }
    if (name === 'CertManager') {
      const rootCall = sel(name, 'verified(bytes32)') + '311d96fcd5c5e0ccf72ef548e2ea7d4c0cd53ad7c4cc49e67471aed41d61f185';
      const x = await rpc('eth_call', [{ to: addr, data: rootCall }, 'latest']);
      const y = await rpc('eth_call', [{ to: caddr, data: rootCall }, 'latest']);
      ok(`3. CertManager: the stored root certificate equals the control (${(x.length - 2) / 2} bytes)`, x === y && x.length > 200, 'differs or empty');
      ok(`3. CertManager: owner and revoker are the admin, in tagged and control`, read['owner()'].endsWith(admin.slice(2)) && read['revoker()'].endsWith(admin.slice(2)), JSON.stringify(read));
    }
    ok(`3. ${step}: ${GETTERS[name].length} getters equal the control: ${GETTERS[name].map((g) => `${g}=${read[g].slice(-8)}`).join(' ')}`, true);

    // 5a. tagged-deploy's own post-check against what was mined
    const clines = [];
    await check(step, addr, { ...a, tx: hash, out: outDir }, env, deps, (l) => clines.push(l));
    for (const l of clines) console.log(`      ${l}`);
    results[name] = { addr, hash, gasUsed: used };
  }

  // Real-artifact refusals: a prior address that is not the production contract is refused, nothing written.
  console.log('\n[refusals] against the real reference build');
  const refuse = async (step, over, re, label) => {
    let msg = null;
    try {
      await prepare(step, { positional: [], deployer, account: 'acct', rpcUrl: url, out: join(work, 'neg') }, { ...env, ...over }, deps, () => {});
    } catch (e) {
      msg = e.message;
    }
    ok(`refused: ${label}`, msg !== null && re.test(msg), `got ${msg}`);
  };
  await refuse('certmanager', { ATTESSA_P384_VERIFIER: PINS.celo.identityRegistry }, /not the production P384Verifier/, 'certmanager over a P384Verifier address holding other code');
  await refuse('nitro', { ATTESSA_CERT_MANAGER: addrs.p384 }, /not the production CertManager/, 'nitro over a CertManager address holding the P384Verifier');
  await refuse('registry', { ATTESSA_NITRO_VALIDATOR: addrs.certmanager }, /did not answer|not the production/, 'registry over a validator address that is a CertManager');
  await refuse('certmanager', { ATTESSA_ADMIN: deployer }, /not the deployer/, 'admin equal to the deployer');
  ok('refused runs wrote no data file', !existsSync(join(work, 'neg')) || readdirSync(join(work, 'neg')).length === 0, 'files written');

  // 5b. check-deploy against the local deployment, through its existing --rpc-url/--deployments/--core flags
  console.log('\n[check-deploy] scripts/check-deploy.mjs celo against the local stack');
  const md = join(work, 'DEPLOYMENTS.md');
  const core = join(work, 'deployments.mjs');
  writeFileSync(md, `## celo\n\n| Name | Address |\n|---|---|\n| Admin | \`${admin}\` |\n| P384Verifier | \`${addrs.p384}\` |\n| CertManager | \`${addrs.certmanager}\` |\n| NitroValidator | \`${addrs.nitro}\` |\n| EnclaveRegistry | \`${addrs.registry}\` |\n| IdentityRegistry | \`${PINS.celo.identityRegistry}\` |\n| SelfRegistry | \`${PINS.celo.selfRegistry}\` |\n`);
  writeFileSync(core, `export const DEPLOYMENTS = { celo: { chainId: 42220, identityRegistry: '${PINS.celo.identityRegistry}', selfRegistry: '${PINS.celo.selfRegistry}', enclaveRegistry: '${addrs.registry}', validatorStack: { p384Verifier: '${addrs.p384}', certManager: '${addrs.certmanager}', nitroValidator: '${addrs.nitro}' } } };\n`);
  const cd = spawnSync('node', [join(ROOT, 'scripts', 'check-deploy.mjs'), 'celo', '--rpc-url', url, '--deployments', md, '--core', core], { encoding: 'utf8' });
  for (const l of (cd.stdout + cd.stderr).trim().split('\n')) console.log(`      ${l}`);
  ok('5. check-deploy celo exits 0 against the tagged local deployment', cd.status === 0, `exit ${cd.status}`);
  ok('5. check-deploy compared runtime code for all four contracts', ['P384Verifier', 'CertManager', 'NitroValidator', 'EnclaveRegistry'].every((n) => cd.stdout.includes(`OK    ${n} runtime code equals the production artifact`)), 'a runtime check is missing');

  console.log('\nSUMMARY');
  for (const [n, r] of Object.entries(results)) console.log(`  ${n.padEnd(15)} ${r.addr}  tx ${r.hash}  gas ${r.gasUsed}`);
  console.log('E2E OK: all four tagged creations passed every check');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`\nE2E FAILED: ${e.message}\nDo not use the tagged route.`);
    process.exit(1);
  },
);
