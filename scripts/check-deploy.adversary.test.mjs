// Adversary test for scripts/check-deploy.mjs (T10): a stale or dirty build.
//   flock /home/hr/.cache/attessa-heavy.lock node --test scripts/check-deploy.adversary.test.mjs
// Needs forge, anvil and git on PATH, and `forge build` already run in contracts/ (the clean
// artifact is the reference for the sanity check). No transaction is sent anywhere.
//
// SPEC §3.5 and ADR-001: the deployed CertManager must be base/nitro-validator's production code at
// the pinned commit 0ea0d12, unmodified. check-deploy compares on-chain code with whatever is in
// contracts/out and only checks the submodule's HEAD, so a build made from a modified CertManager
// passes every check.
//
// Setup: a mirror of the repo in a temp dir (scripts/check-deploy.mjs copied unchanged, contracts/
// copied, lib/nitro-validator cloned locally at 0ea0d12). CertManager.sol is patched to accept
// expired certificates (what CertManagerDemo does), the mirror is built, and DumpStack runs the
// deploy scripts' own deploy code there. That state is loaded into anvil (chain 11142220).
//   A. dirty submodule: the patch is still in the working tree when check-deploy runs.
//   B. stale build: the patch is reverted (tree clean, HEAD 0ea0d12) but contracts/out is not rebuilt.
// In both, the CertManager on chain is not the pinned production code, so check-deploy must not exit 0.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = join(ROOT, 'contracts');
const PINNED = '0ea0d12';
const PORT = 18950 + (process.pid % 40);

const tmp = mkdtempSync(join(tmpdir(), 'check-deploy-adv-'));
const M = join(tmp, 'mirror');
const MC = join(M, 'contracts');
const NV = join(MC, 'lib', 'nitro-validator');
let anvil;
let rpc;
let manifest;

const git = (...a) => execFileSync('git', ['-C', NV, ...a], { encoding: 'utf8' }).trim();

function deploymentsMd(m) {
  const rows = ['Admin', 'P384Verifier', 'CertManager', 'NitroValidator', 'EnclaveRegistry'].map((k) => `| ${k} | \`${m[k]}\` |`);
  return ['# Deployments (test)', '', '## celo-sepolia', '', '| Name | Address |', '|---|---|', ...rows, '', '## celo', ''].join('\n');
}

function coreTs(m) {
  const src = readFileSync(join(ROOT, 'packages/core/src/deployments.ts'), 'utf8');
  const before = '    enclaveRegistry: null,\n    validatorStack: null,\n';
  assert.ok(src.includes(before), 'deployments.ts layout changed; update this test');
  return src.replace(
    before,
    `    enclaveRegistry: '${m.EnclaveRegistry}',\n    validatorStack: { p384Verifier: '${m.P384Verifier}', certManager: '${m.CertManager}', nitroValidator: '${m.NitroValidator}' },\n`,
  );
}

function runCheck(label) {
  const dir = mkdtempSync(join(tmp, `${label}-`));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'DEPLOYMENTS.md'), deploymentsMd(manifest));
  writeFileSync(join(dir, 'deployments.ts'), coreTs(manifest));
  const r = spawnSync(
    'node',
    [join(M, 'scripts', 'check-deploy.mjs'), 'celo-sepolia', '--rpc-url', rpc, '--deployments', join(dir, 'DEPLOYMENTS.md'), '--core', join(dir, 'deployments.ts')],
    { encoding: 'utf8' },
  );
  process.stdout.write(`--- check-deploy, ${label} (exit ${r.status})\n${r.stdout}${r.stderr}`);
  return r;
}

before(async () => {
  // Mirror: check-deploy finds contracts/out and lib/nitro-validator relative to its own path.
  mkdirSync(join(M, 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'scripts', 'check-deploy.mjs'), join(M, 'scripts', 'check-deploy.mjs'));
  cpSync(CONTRACTS, MC, { recursive: true, filter: (p) => !['out', 'cache', 'broadcast', 'lib'].includes(basename(p)) || dirname(p) !== CONTRACTS });
  execFileSync('git', ['clone', '--quiet', '--no-checkout', join(CONTRACTS, 'lib', 'nitro-validator'), NV]);
  git('checkout', '--quiet', '--detach', PINNED);
  cpSync(join(CONTRACTS, 'lib', 'nitro-validator', 'lib', 'forge-std'), join(NV, 'lib', 'forge-std'), {
    recursive: true,
    filter: (p) => basename(p) !== '.git',
  });

  // The modification: accept expired certificates.
  const cm = join(NV, 'src', 'CertManager.sol');
  const src = readFileSync(cm, 'utf8');
  const orig = '        return notAfter < block.timestamp;\n';
  assert.ok(src.includes(orig), 'CertManager._certificateExpired changed; update this test');
  writeFileSync(cm, src.replace(orig, '        notAfter;\n        return false;\n'));
  assert.ok(git('rev-parse', 'HEAD').startsWith(PINNED));
  assert.equal(git('status', '--porcelain'), 'M src/CertManager.sol');

  mkdirSync(join(MC, 'cache', 'check-deploy'), { recursive: true });
  execFileSync('forge', ['script', 'test/deploy/DumpStack.s.sol:DumpStack', '--sig', 'run(string)', 'production'], {
    cwd: MC,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const state = JSON.parse(readFileSync(join(MC, 'cache/check-deploy/production.state.json'), 'utf8'));
  manifest = JSON.parse(readFileSync(join(MC, 'cache/check-deploy/production.manifest.json'), 'utf8'));
  const genesis = join(tmp, 'genesis.json');
  writeFileSync(genesis, JSON.stringify({ config: { chainId: 11142220 }, gasLimit: '0x1c9c380', alloc: state }));
  anvil = spawn('anvil', ['--init', genesis, '--port', String(PORT), '--silent'], { stdio: 'ignore' });
  rpc = `http://127.0.0.1:${PORT}`;
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
      if (r.ok) break;
    } catch {}
    if (i > 100) throw new Error('anvil did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(() => {
  anvil?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

test('sanity: the mirror CertManager is not the pinned production code', () => {
  const clean = JSON.parse(readFileSync(join(CONTRACTS, 'out/CertManager.sol/CertManager.json'), 'utf8'));
  const built = JSON.parse(readFileSync(join(MC, 'out/CertManager.sol/CertManager.json'), 'utf8'));
  assert.notEqual(built.deployedBytecode.object, clean.deployedBytecode.object);
});

test('A. dirty nitro-validator (HEAD 0ea0d12, CertManager.sol modified): check-deploy must not pass', () => {
  assert.equal(git('status', '--porcelain'), 'M src/CertManager.sol');
  const r = runCheck('dirty');
  assert.notEqual(r.status, 0, 'check-deploy passed a CertManager built from a modified CertManager.sol');
  assert.match(r.stdout, /^FAIL  nitro-validator is at 0ea0d12 with a clean tree: /m);
});

test('B. stale contracts/out (tree clean at 0ea0d12, not rebuilt): check-deploy must not pass', () => {
  git('checkout', '--quiet', '--', 'src/CertManager.sol');
  assert.equal(git('status', '--porcelain'), '');
  const r = runCheck('stale');
  assert.notEqual(r.status, 0, 'check-deploy passed a CertManager that the checked-out source does not compile to');
  // The mirror is not a git repo, so the contracts/src check also fails here; the stale build
  // itself must be caught by the source-hash check.
  assert.match(r.stdout, /^FAIL  CertManager artifact was built from the sources on disk: /m);
  assert.match(r.stdout, /^OK    nitro-validator is at 0ea0d12 with a clean tree$/m);
});
