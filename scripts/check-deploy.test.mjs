// Own test for scripts/check-deploy.mjs (T10). Needs forge and anvil on PATH; run from the repo root:
//   flock /home/hr/.cache/attessa-heavy.lock node --test scripts/check-deploy.test.mjs
//
// No transaction is sent anywhere. contracts/test/deploy/DumpStack.s.sol runs the deploy scripts'
// own deploy code in-process (forge script, no RPC) and dumps the state; each variant's dump is
// loaded into a fresh anvil as genesis (chain id 11142220), and check-deploy runs against it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = join(ROOT, 'contracts');
const CHECK = join(ROOT, 'scripts', 'check-deploy.mjs');
const VARIANTS = ['production', 'demo', 'mock-validator'];
const FIRST_PORT = 18600 + (process.pid % 300);

const tmp = mkdtempSync(join(tmpdir(), 'check-deploy-'));
const anvils = [];
const env = {}; // variant -> { rpc, manifest }

function startAnvil(genesis, port) {
  const p = spawn('anvil', ['--init', genesis, '--port', String(port), '--silent'], { stdio: 'ignore' });
  anvils.push(p);
  return `http://127.0.0.1:${port}`;
}

async function waitFor(rpc) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`anvil at ${rpc} did not start`);
}

/** A DEPLOYMENTS.md with the same layout as docs/DEPLOYMENTS.md. */
function deploymentsMd(m) {
  const rows = ['Admin', 'P384Verifier', 'CertManager', 'NitroValidator', 'EnclaveRegistry'].map((k) => `| ${k} | \`${m[k]}\` |`);
  return ['# Deployments (test)', '', '## celo-sepolia', '', '| Name | Address |', '|---|---|', ...rows, '', '## celo', ''].join('\n');
}

/** packages/core/src/deployments.ts with the celo-sepolia entry filled in from `m` (or left null). */
function coreTs(m) {
  let src = readFileSync(join(ROOT, 'packages/core/src/deployments.ts'), 'utf8');
  if (m) {
    const before = '    enclaveRegistry: null,\n    validatorStack: null,\n';
    assert.ok(src.includes(before), 'deployments.ts layout changed; update this test');
    src = src.replace(
      before, // first occurrence is celo-sepolia
      `    enclaveRegistry: '${m.EnclaveRegistry}',\n    validatorStack: { p384Verifier: '${m.P384Verifier}', certManager: '${m.CertManager}', nitroValidator: '${m.NitroValidator}' },\n`,
    );
  }
  return src;
}

function runCheck(variant, { manifest, core } = {}) {
  const m = manifest ?? env[variant].manifest;
  const dir = mkdtempSync(join(tmp, `${variant}-`));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'DEPLOYMENTS.md'), deploymentsMd(m));
  writeFileSync(join(dir, 'deployments.ts'), core === undefined ? coreTs(m) : core);
  const r = spawnSync(
    'node',
    [CHECK, 'celo-sepolia', '--rpc-url', env[variant].rpc, '--deployments', join(dir, 'DEPLOYMENTS.md'), '--core', join(dir, 'deployments.ts')],
    { encoding: 'utf8' },
  );
  process.stdout.write(`--- check-deploy against ${variant} (exit ${r.status})\n${r.stdout}${r.stderr}`);
  return { status: r.status, out: r.stdout, err: r.stderr, fails: r.stdout.split('\n').filter((l) => l.startsWith('FAIL  ')) };
}

before(async () => {
  let port = FIRST_PORT;
  for (const v of VARIANTS) {
    execFileSync('forge', ['script', 'test/deploy/DumpStack.s.sol:DumpStack', '--sig', 'run(string)', v], {
      cwd: CONTRACTS,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const state = JSON.parse(readFileSync(join(CONTRACTS, `cache/check-deploy/${v}.state.json`), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(CONTRACTS, `cache/check-deploy/${v}.manifest.json`), 'utf8'));
    const genesis = join(tmp, `${v}.genesis.json`);
    writeFileSync(genesis, JSON.stringify({ config: { chainId: 11142220 }, gasLimit: '0x1c9c380', alloc: state }));
    env[v] = { rpc: startAnvil(genesis, port++), manifest };
  }
  await Promise.all(VARIANTS.map((v) => waitFor(env[v].rpc)));
});

after(() => {
  for (const p of anvils) p.kill();
  rmSync(tmp, { recursive: true, force: true });
});

test('production stack deployed by the deploy scripts: every check OK, exit 0', () => {
  const r = runCheck('production');
  assert.equal(r.status, 0);
  assert.deepEqual(r.fails, []);
  assert.match(r.out, /\nOK: all 23 checks passed\n$/);
  for (const n of ['P384Verifier', 'CertManager', 'NitroValidator', 'EnclaveRegistry']) {
    assert.match(r.out, new RegExp(`^OK {4}${n} runtime code equals the production artifact with immutables spliced$`, 'm'));
  }
  assert.match(r.out, /^OK {4}CertManager\.owner\(\) == /m);
});

test('CertManagerDemo: the CertManager code check fails, exit 1', () => {
  const r = runCheck('demo');
  assert.equal(r.status, 1);
  assert.match(r.out, /\nFAILED: 1 of 23 checks failed\n$/);
  // The demo stack's owner is set as admin and its wiring is right, so the code check alone catches it.
  assert.deepEqual(r.fails.map((l) => l.split(':')[0]), ['FAIL  CertManager runtime code equals the production artifact with immutables spliced']);
});

test('registry wired to a mock validator: NitroValidator code and getters fail, exit 1', () => {
  const r = runCheck('mock-validator');
  assert.equal(r.status, 1);
  const names = r.fails.map((l) => l.split(':')[0]);
  assert.ok(names.includes('FAIL  NitroValidator runtime code equals the production artifact with immutables spliced'), names.join('\n'));
  assert.ok(names.some((n) => n.startsWith('FAIL  NitroValidator.certManager()')), names.join('\n'));
});

test('admin in DEPLOYMENTS.md is not the CertManager owner/revoker: exit 1', () => {
  const m = { ...env.production.manifest, Admin: '0x000000000000000000000000000000000000dEaD' };
  const r = runCheck('production', { manifest: m });
  assert.equal(r.status, 1);
  assert.deepEqual(
    r.fails.map((l) => l.split(' == ')[0]),
    ['FAIL  CertManager.owner()', 'FAIL  CertManager.revoker()'],
  );
});

test('swapped CertManager and P384Verifier addresses: exit 1', () => {
  const p = env.production.manifest;
  const r = runCheck('production', { manifest: { ...p, CertManager: p.P384Verifier, P384Verifier: p.CertManager } });
  assert.equal(r.status, 1);
  assert.ok(r.fails.some((l) => l.startsWith('FAIL  CertManager runtime code')));
  assert.ok(r.fails.some((l) => l.startsWith('FAIL  P384Verifier runtime code')));
});

test('deployments.ts not updated to the DEPLOYMENTS.md addresses: exit 1', () => {
  const r = runCheck('production', { core: coreTs(null) });
  assert.equal(r.status, 1);
  assert.equal(r.fails.length, 4);
  assert.ok(r.fails.every((l) => l.startsWith('FAIL  deployments.ts ')));
});

test('the repo as committed (TODO addresses): refuses with a clear error, exit 2', () => {
  const r = spawnSync('node', [CHECK, 'celo-sepolia'], { encoding: 'utf8' });
  process.stdout.write(`--- check-deploy celo-sepolia (exit ${r.status})\n${r.stdout}${r.stderr}`);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^check-deploy: DEPLOYMENTS\.md celo-sepolia: Admin is still "TODO/);
});
