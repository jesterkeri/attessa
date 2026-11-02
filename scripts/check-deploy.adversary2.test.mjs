// Adversary test for scripts/check-deploy.mjs (T10, round 2): provenance that the new checks miss.
//   flock /home/hr/.cache/attessa-heavy.lock node --test scripts/check-deploy.adversary2.test.mjs
// Needs forge, anvil, cast and git on PATH, and `forge build` already run in contracts/ (the clean
// artifact is the reference for the sanity checks). No transaction is sent anywhere.
//
// SPEC §3.5 and ADR-001: the deployed stack must be base/nitro-validator's production code at the
// pinned commit 0ea0d12, unmodified, built from this repo. T10: check-deploy must prove that, and
// that DEPLOYMENTS.md and deployments.ts agree.
//
// Setup: a mirror of the repo in a temp dir that IS a git repo (everything committed, the repo's
// .gitignore), so check-deploy's `git status -- contracts/src` passes as on a real checkout;
// lib/nitro-validator cloned locally at 0ea0d12. Each scenario runs DumpStack (the deploy scripts'
// own deploy code) in the mirror and loads the dumped state into a fresh anvil (chain 11142220).
//   H. hand-edited artifact: CertManager.sol is patched to accept expired certificates, built and
//      deployed; the patch is reverted (tree clean at 0ea0d12) and only the one keccak256 under
//      metadata.sources in out/CertManager.sol/CertManager.json is set to the clean file's hash.
//   S. DEPLOYMENTS.md lists a SelfRegistry and IdentityRegistry that differ from deployments.ts.
//   O. contracts/foundry.toml changed (optimizer_runs 200, not committed), sources untouched.
// check-deploy must not exit 0 in any of them.

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
const FIRST_PORT = 19100 + (process.pid % 40) * 4;

const tmp = mkdtempSync(join(tmpdir(), 'check-deploy-adv2-'));
const M = join(tmp, 'mirror');
const MC = join(M, 'contracts');
const NV = join(MC, 'lib', 'nitro-validator');
const anvils = [];
const env = {}; // scenario -> { rpc, manifest, certManagerCode }
let port = FIRST_PORT;
const results = {}; // check-deploy runs made in before()

const gitIn = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
const forge = (...a) => execFileSync('forge', a, { cwd: MC, stdio: ['ignore', 'ignore', 'inherit'] });
const cmArtifact = (contractsDir) => join(contractsDir, 'out/CertManager.sol/CertManager.json');

/** docs/DEPLOYMENTS.md with the TODO rows of our five contracts filled from `m`. */
function deploymentsMd(m, replace = {}) {
  let md = readFileSync(join(ROOT, 'docs/DEPLOYMENTS.md'), 'utf8');
  for (const k of ['Admin', 'P384Verifier', 'CertManager', 'NitroValidator', 'EnclaveRegistry']) {
    const re = new RegExp(`^\\| ${k} \\| \`TODO[^\`]*\` \\|$`, 'm');
    assert.match(md, re, 'DEPLOYMENTS.md layout changed; update this test');
    md = md.replace(re, `| ${k} | \`${m[k]}\` |`);
  }
  for (const [from, to] of Object.entries(replace)) {
    assert.ok(md.includes(from));
    md = md.replace(from, to);
  }
  return md;
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

async function deploy(label) {
  forge('script', 'test/deploy/DumpStack.s.sol:DumpStack', '--sig', 'run(string)', 'production');
  const state = JSON.parse(readFileSync(join(MC, 'cache/check-deploy/production.state.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(MC, 'cache/check-deploy/production.manifest.json'), 'utf8'));
  const genesis = join(tmp, `${label}.genesis.json`);
  writeFileSync(genesis, JSON.stringify({ config: { chainId: 11142220 }, gasLimit: '0x1c9c380', alloc: state }));
  const p = port++;
  anvils.push(spawn('anvil', ['--init', genesis, '--port', String(p), '--silent'], { stdio: 'ignore' }));
  const rpc = `http://127.0.0.1:${p}`;
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
      if (r.ok) break;
    } catch {}
    if (i > 100) throw new Error('anvil did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  const code = state[manifest.CertManager.toLowerCase()]?.code ?? state[manifest.CertManager]?.code;
  env[label] = { rpc, manifest, certManagerCode: code };
  process.stdout.write(`DEBUG ${label} CertManager ${manifest.CertManager} code bytes ${(code.length - 2) / 2}\n`);
}

function runCheck(label, { md } = {}) {
  const { rpc, manifest } = env[label];
  const dir = mkdtempSync(join(tmp, `${label}-run-`));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'DEPLOYMENTS.md'), md ?? deploymentsMd(manifest));
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
  // Mirror, committed as a git repo with the repo's own .gitignore (contracts/out, cache ignored).
  mkdirSync(join(M, 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'scripts', 'check-deploy.mjs'), join(M, 'scripts', 'check-deploy.mjs'));
  cpSync(join(ROOT, '.gitignore'), join(M, '.gitignore'));
  cpSync(CONTRACTS, MC, { recursive: true, filter: (p) => !['out', 'cache', 'broadcast', 'lib'].includes(basename(p)) || dirname(p) !== CONTRACTS });
  execFileSync('git', ['clone', '--quiet', '--no-checkout', join(CONTRACTS, 'lib', 'nitro-validator'), NV]);
  gitIn(NV, 'checkout', '--quiet', '--detach', PINNED);
  cpSync(join(CONTRACTS, 'lib', 'nitro-validator', 'lib', 'forge-std'), join(NV, 'lib', 'forge-std'), {
    recursive: true,
    filter: (p) => basename(p) !== '.git',
  });
  gitIn(M, 'init', '--quiet');
  gitIn(M, 'add', '-A');
  gitIn(M, '-c', 'user.email=adversary@test', '-c', 'user.name=adversary', 'commit', '--quiet', '-m', 'mirror');
  assert.equal(gitIn(M, 'status', '--porcelain', '--', 'contracts/src'), '');
  assert.equal(gitIn(NV, 'status', '--porcelain', '--ignore-submodules=none'), '');
  mkdirSync(join(MC, 'cache', 'check-deploy'), { recursive: true });

  // Clean build and deploy: the baseline, and the stack for S. Both checks run now, while
  // contracts/out is still the clean build.
  await deploy('clean');
  results.baseline = runCheck('clean');
  results.S = runCheck('clean', {
    md: deploymentsMd(env.clean.manifest, {
      '| SelfRegistry | `0x043DaCac8b0771DD5b444bCC88f2f8BBDBEdd379` |': '| SelfRegistry | `0x000000000000000000000000000000000000dEaD` |',
      '| IdentityRegistry (ERC-8004) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |': '| IdentityRegistry (ERC-8004) | `0x000000000000000000000000000000000000bEEF` |',
    }),
  });

  // H. Patched CertManager built and deployed, patch reverted, artifact hash edited by hand.
  const cm = join(NV, 'src', 'CertManager.sol');
  const src = readFileSync(cm, 'utf8');
  const orig = '        return notAfter < block.timestamp;\n';
  assert.ok(src.includes(orig), 'CertManager._certificateExpired changed; update this test');
  writeFileSync(cm, src.replace(orig, '        notAfter;\n        return false;\n'));
  // --force: forge 1.8.1's cache does not recompile DumpStack.s.sol after a lib/ change.
  forge('build', '--force');
  await deploy('hand-edited');
  gitIn(NV, 'checkout', '--quiet', '--', 'src/CertManager.sol');
  const art = JSON.parse(readFileSync(cmArtifact(MC), 'utf8'));
  const key = 'lib/nitro-validator/src/CertManager.sol';
  art.metadata.sources[key].keccak256 = execFileSync('cast', ['keccak'], { input: readFileSync(cm), encoding: 'utf8' }).trim();
  writeFileSync(cmArtifact(MC), JSON.stringify(art));
  env['hand-edited'].artifact = art;
});

after(() => {
  for (const p of anvils) p.kill();
  if (!process.env.KEEP_TMP) rmSync(tmp, { recursive: true, force: true });
});

test('baseline: the clean mirror stack passes (the harness is sound)', () => {
  assert.equal(results.baseline.status, 0);
});

test('H. backdoored CertManager on chain, artifact hash edited by hand: check-deploy must not pass', () => {
  const clean = JSON.parse(readFileSync(cmArtifact(CONTRACTS), 'utf8'));
  // Sanity: the mirror tree is clean at the pinned commit, and the code on chain is not the
  // production code that the committed, pinned sources compile to.
  assert.equal(gitIn(NV, 'status', '--porcelain', '--ignore-submodules=none'), '');
  assert.ok(gitIn(NV, 'rev-parse', 'HEAD').startsWith(PINNED));
  assert.notEqual(env['hand-edited'].artifact.deployedBytecode.object, clean.deployedBytecode.object);
  assert.notEqual(env['hand-edited'].certManagerCode, env.clean.certManagerCode);
  const r = runCheck('hand-edited');
  assert.notEqual(r.status, 0, 'check-deploy passed a CertManager that accepts expired certificates');
  assert.match(r.stdout, /^FAIL  CertManager runtime code equals the production artifact with immutables spliced: /m);
});

test('S. DEPLOYMENTS.md SelfRegistry and IdentityRegistry disagree with deployments.ts: check-deploy must not pass', () => {
  const r = results.S;
  assert.match(r.stdout, /^OK    EnclaveRegistry\.selfRegistry\(\) == 0x043dacac8b0771dd5b444bcc88f2f8bbdbedd379$/m);
  assert.notEqual(r.status, 0, 'check-deploy passed while DEPLOYMENTS.md and deployments.ts list different registries');
  assert.match(r.stdout, /^FAIL  deployments.ts selfRegistry matches DEPLOYMENTS.md: /m);
  assert.match(r.stdout, /^FAIL  deployments.ts identityRegistry matches DEPLOYMENTS.md: /m);
});

test('O. CertManager built with uncommitted foundry.toml settings (optimizer_runs 200): check-deploy must not pass', async () => {
  const toml = join(MC, 'foundry.toml');
  const t = readFileSync(toml, 'utf8');
  assert.ok(t.includes('optimizer_runs = 10000\n'));
  writeFileSync(toml, t.replace('optimizer_runs = 10000\n', 'optimizer_runs = 200\n'));
  forge('build');
  await deploy('settings');
  const clean = JSON.parse(readFileSync(cmArtifact(CONTRACTS), 'utf8'));
  assert.equal(gitIn(M, 'status', '--porcelain', '--', 'contracts/src'), '');
  assert.notEqual(env.settings.certManagerCode, env.clean.certManagerCode);
  assert.notEqual(JSON.parse(readFileSync(cmArtifact(MC), 'utf8')).deployedBytecode.object, clean.deployedBytecode.object);
  const r = runCheck('settings');
  assert.notEqual(r.status, 0, 'check-deploy passed a stack compiled with settings the repo does not commit');
  assert.match(r.stdout, /^FAIL  CertManager runtime code equals the production artifact with immutables spliced: /m);
});
