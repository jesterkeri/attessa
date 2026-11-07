// Adversary test for scripts/check-deploy.mjs (T10, round 3): the nitro-validator pin.
//   flock /home/hr/.cache/attessa-heavy.lock node --test scripts/check-deploy.adversary3.test.mjs
// Needs forge, anvil and git on PATH. No transaction is sent anywhere.
//
// ADR-001 and SPEC §3.5: the validator stack is base/nitro-validator at the pinned commit 0ea0d12,
// never modified. The full commit is 0ea0d12366b4fa44f9e07e4755f2ad36561cb674. check-deploy reads
// the gitlink HEAD records and only checks that it starts with the 7-character prefix.
//
// A 7-hex-digit prefix is 28 bits. COLLIDING below is a real commit object, ground in about four
// seconds on 8 cores (C + OpenSSL SHA-1, nonce in the message), whose parent is the pinned commit
// and whose tree is the pinned tree with CertManager._certificateExpired patched to always return
// false (accept expired certificates). Its id starts with 0ea0d12. The test rebuilds it byte for
// byte with `git hash-object -t commit` and asserts the id, so nothing here is assumed.
//
// Setup, as in check-deploy.adversary2.test.mjs: a committed mirror of the repo whose submodule
// gitlink points at COLLIDING; DumpStack (the deploy scripts' own deploy code) deploys from it and
// the dumped state is loaded into anvil at chain 11142220. A baseline at the real pin must pass.
// check-deploy must not exit 0 for the colliding pin.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = join(ROOT, 'contracts');
const PINNED_FULL = '0ea0d12366b4fa44f9e07e4755f2ad36561cb674';
const COLLIDING = '0ea0d128d79e521db680564842e49fff46a08154';
const COMMIT_BODY = [
  'tree eec676232eaf5272648fcdef918efba454cbacc1',
  `parent ${PINNED_FULL}`,
  'author adversary <adversary@test> 1700000000 +0000',
  'committer adversary <adversary@test> 1700000000 +0000',
  '',
  'CertManager: tidy expiry check 000000000e3a6c4d',
  '',
].join('\n');
const FIRST_PORT = 19300 + (process.pid % 40) * 4;

const tmp = mkdtempSync(join(tmpdir(), 'check-deploy-adv3-'));
const M = join(tmp, 'mirror');
const MC = join(M, 'contracts');
const NV = join(MC, 'lib', 'nitro-validator');
const anvils = [];
const env = {};
let port = FIRST_PORT;
const results = {};

const gitIn = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
const forge = (...a) => execFileSync('forge', a, { cwd: MC, stdio: ['ignore', 'ignore', 'inherit'] });

function deploymentsMd(m) {
  let md = readFileSync(join(ROOT, 'docs/DEPLOYMENTS.md'), 'utf8');
  for (const k of ['Admin', 'P384Verifier', 'CertManager', 'NitroValidator', 'EnclaveRegistry']) {
    const re = new RegExp(`^\\| ${k} \\| \`TODO[^\`]*\` \\|$`, 'm');
    assert.match(md, re, 'DEPLOYMENTS.md layout changed; update this test');
    md = md.replace(re, `| ${k} | \`${m[k]}\` |`);
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
}

function runCheck(label) {
  const { rpc, manifest } = env[label];
  const dir = mkdtempSync(join(tmp, `${label}-run-`));
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

const commitMirror = (msg) => {
  gitIn(M, 'add', '-A');
  gitIn(M, '-c', 'user.email=adversary@test', '-c', 'user.name=adversary', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', msg);
};

before(async () => {
  mkdirSync(join(M, 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'scripts', 'check-deploy.mjs'), join(M, 'scripts', 'check-deploy.mjs'));
  cpSync(join(ROOT, '.gitignore'), join(M, '.gitignore'));
  cpSync(CONTRACTS, MC, { recursive: true, filter: (p) => !['out', 'cache', 'broadcast', 'lib'].includes(basename(p)) || dirname(p) !== CONTRACTS });
  execFileSync('git', ['clone', '--quiet', '--no-checkout', join(CONTRACTS, 'lib', 'nitro-validator'), NV]);
  gitIn(NV, 'checkout', '--quiet', '--detach', PINNED_FULL);
  cpSync(join(CONTRACTS, 'lib', 'nitro-validator', 'lib', 'forge-std'), join(NV, 'lib', 'forge-std'), {
    recursive: true,
    filter: (p) => basename(p) !== '.git',
  });
  gitIn(M, 'init', '--quiet');
  commitMirror('mirror at the real pin');
  assert.equal(gitIn(M, 'ls-tree', 'HEAD', 'contracts/lib/nitro-validator').split(/\s+/)[2], PINNED_FULL);
  mkdirSync(join(MC, 'cache', 'check-deploy'), { recursive: true });

  await deploy('clean');
  results.baseline = runCheck('clean');

  // The colliding commit: pinned tree with the expiry check patched out, rebuilt byte for byte.
  const cm = join(NV, 'src', 'CertManager.sol');
  const src = readFileSync(cm, 'utf8');
  const orig = '        return notAfter < block.timestamp;\n';
  assert.equal(src.split(orig).length, 2, 'CertManager._certificateExpired changed; update this test');
  writeFileSync(cm, src.replace(orig, '        notAfter;\n        return false;\n'));
  gitIn(NV, 'add', 'src/CertManager.sol');
  assert.equal(gitIn(NV, 'write-tree'), 'eec676232eaf5272648fcdef918efba454cbacc1');
  const id = execFileSync('git', ['-C', NV, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: COMMIT_BODY, encoding: 'utf8' }).trim();
  assert.equal(id, COLLIDING);
  gitIn(NV, 'checkout', '--quiet', '--detach', COLLIDING);
  commitMirror('bump nitro-validator (still 0ea0d12)');
  assert.equal(gitIn(M, 'ls-tree', 'HEAD', 'contracts/lib/nitro-validator').split(/\s+/)[2], COLLIDING);
  forge('build', '--force');
  await deploy('colliding');
});

after(() => {
  for (const p of anvils) p.kill();
  if (!process.env.KEEP_TMP) rmSync(tmp, { recursive: true, force: true });
});

test('baseline: the stack at the real pin passes (the harness is sound)', () => {
  assert.equal(results.baseline.status, 0);
});

test('P. gitlink at a different commit sharing the 0ea0d12 prefix, CertManager backdoored: check-deploy must not pass', () => {
  assert.ok(COLLIDING.startsWith('0ea0d12') && COLLIDING !== PINNED_FULL);
  assert.equal(gitIn(M, 'status', '--porcelain'), '');
  // The deployed CertManager is not the code the real pin compiles to.
  assert.notEqual(env.colliding.certManagerCode, env.clean.certManagerCode);
  const r = runCheck('colliding');
  assert.notEqual(r.status, 0, `check-deploy passed nitro-validator ${COLLIDING}, which is not ${PINNED_FULL} (ADR-001)`);
});
