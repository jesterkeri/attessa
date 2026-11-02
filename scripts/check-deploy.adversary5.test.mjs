// Adversary test for scripts/check-deploy.mjs (T10, round 5): remappings that redirect the pinned
// nitro-validator sources' own relative imports.
//   flock /home/hr/.cache/attessa-heavy.lock node --test scripts/check-deploy.adversary5.test.mjs
// Needs forge, anvil and git on PATH. No transaction is sent anywhere.
//
// ADR-001: "Verify Nitro attestations with base/nitro-validator, pinned, unmodified ... Never modify
// it." SPEC §3.5: check-deploy asserts each runtime code equals "the compiled production artifact".
//
// solc applies remappings to the source unit name a relative import resolves to. So a remapping
// `lib/nitro-validator/src/LibBytes.sol=src/evil/LibBytes.sol` makes the pinned CertManager.sol's
// `import "./LibBytes.sol"` compile src/evil/LibBytes.sol instead. The pinned files are untouched,
// the submodule is clean at the full pinned id, and the artifact's compilationTarget is still
// lib/nitro-validator/src/CertManager.sol, so check-deploy's selectArtifacts picks it. The patched
// LibBytes.keccak hashes at most 64 bytes; CertManager keys its verified-certificate cache on
// LibBytes.keccak(tbsCertificate), so any certificate whose first 64 TBS bytes match a cached one
// would be treated as already verified.
//
// M. The remapping is committed in contracts/remappings.txt, with src/evil/LibBytes.sol: the deploy
//    scripts (DumpStack runs their own deploy code) and check-deploy's reference build both compile
//    the patched library. check-deploy must not exit 0.
// G. Nothing committed. The remapping (plus allow_paths) sits in the global ~/.foundry/foundry.toml,
//    which forge merges under the committed foundry.toml; check-deploy strips FOUNDRY_* and DAPP_*
//    but keeps HOME. The target is `../../evilsrc/LibBytes.sol` relative to the project root, which
//    is <tmp>/evilsrc both for the mirror (<tmp>/mirror/contracts) and for check-deploy's
//    mkdtemp(<TMPDIR>)/contracts with TMPDIR=<tmp>. check-deploy must not exit 0.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = join(ROOT, 'contracts');
const PINNED_FULL = '0ea0d12366b4fa44f9e07e4755f2ad36561cb674';
const FIRST_PORT = 19700 + (process.pid % 40) * 4;

const tmp = mkdtempSync(join(tmpdir(), 'check-deploy-adv5-'));
const M = join(tmp, 'mirror');
const MC = join(M, 'contracts');
const NV = join(MC, 'lib', 'nitro-validator');
const FAKE_HOME = join(tmp, 'home');
const anvils = [];
const env = {};
let port = FIRST_PORT;
const results = {};

const gitIn = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
const gitId = ['-c', 'user.email=adversary@test', '-c', 'user.name=adversary', '-c', 'commit.gpgsign=false'];
const commitMirror = (msg) => {
  gitIn(M, 'add', '-A');
  gitIn(M, ...gitId, 'commit', '--quiet', '-m', msg);
};
const forge = (extraEnv, ...a) => execFileSync('forge', a, { cwd: MC, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'ignore', 'inherit'] });

// The pinned LibBytes with keccak capped at 64 bytes.
function patchedLibBytes() {
  const src = readFileSync(join(NV, 'src', 'LibBytes.sol'), 'utf8');
  const line = '            result := keccak256(add(data, add(32, offset)), length)\n';
  assert.equal(src.split(line).length, 2, 'LibBytes.keccak changed; update this test');
  return src.replace(line, '            if gt(length, 64) { length := 64 }\n' + line);
}

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

async function deploy(label, extraEnv = {}) {
  const variant = 'production';
  forge(extraEnv, 'script', 'test/deploy/DumpStack.s.sol:DumpStack', '--sig', 'run(string)', variant);
  const state = JSON.parse(readFileSync(join(MC, `cache/check-deploy/${variant}.state.json`), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(MC, `cache/check-deploy/${variant}.manifest.json`), 'utf8'));
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

function runCheck(label, extraEnv = {}) {
  const { rpc, manifest } = env[label];
  const dir = mkdtempSync(join(tmp, `${label}-run-`));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, 'DEPLOYMENTS.md'), deploymentsMd(manifest));
  writeFileSync(join(dir, 'deployments.ts'), coreTs(manifest));
  const r = spawnSync(
    'node',
    [join(M, 'scripts', 'check-deploy.mjs'), 'celo-sepolia', '--rpc-url', rpc, '--deployments', join(dir, 'DEPLOYMENTS.md'), '--core', join(dir, 'deployments.ts')],
    { encoding: 'utf8', env: { ...process.env, ...extraEnv } },
  );
  process.stdout.write(`--- check-deploy, ${label} (exit ${r.status})\n${r.stdout}${r.stderr}`);
  return r;
}

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

  // G: a global ~/.foundry/foundry.toml under a fake HOME (solc comes from the real svm dir).
  const svm = join(homedir(), '.local', 'share', 'svm');
  assert.ok(existsSync(svm), `no solc cache at ${svm}; update this test`);
  mkdirSync(join(FAKE_HOME, '.foundry'), { recursive: true });
  mkdirSync(join(FAKE_HOME, '.local', 'share'), { recursive: true });
  symlinkSync(svm, join(FAKE_HOME, '.local', 'share', 'svm'));
  mkdirSync(join(tmp, 'evilsrc'));
  writeFileSync(join(tmp, 'evilsrc', 'LibBytes.sol'), patchedLibBytes());
  writeFileSync(
    join(FAKE_HOME, '.foundry', 'foundry.toml'),
    '[profile.default]\nallow_paths = ["../.."]\nremappings = ["lib/nitro-validator/src/LibBytes.sol=../../evilsrc/LibBytes.sol"]\n',
  );
  const globalEnv = { HOME: FAKE_HOME };
  forge(globalEnv, 'build', '--force');
  await deploy('global', globalEnv);
  results.globalClean = gitIn(M, 'status', '--porcelain');
  results.global = runCheck('global', { ...globalEnv, TMPDIR: tmp });

  // M: the same redirect, committed in contracts/remappings.txt with the patched copy in src/evil.
  forge({}, 'build', '--force');
  mkdirSync(join(MC, 'src', 'evil'), { recursive: true });
  writeFileSync(join(MC, 'src', 'evil', 'LibBytes.sol'), patchedLibBytes());
  const remap = join(MC, 'remappings.txt');
  writeFileSync(remap, readFileSync(remap, 'utf8') + 'lib/nitro-validator/src/LibBytes.sol=src/evil/LibBytes.sol\n');
  commitMirror('remappings: LibBytes');
  forge({}, 'build', '--force');
  await deploy('remapped');
  results.remappedClean = gitIn(M, 'status', '--porcelain');
  results.remappedSources = Object.keys(JSON.parse(readFileSync(join(MC, 'out/CertManager.sol/CertManager.json'), 'utf8')).metadata.sources);
  results.remappedTarget = JSON.parse(readFileSync(join(MC, 'out/CertManager.sol/CertManager.json'), 'utf8')).metadata.settings.compilationTarget;
  // DeployRegistry's in-EVM reference check, run in the mirror against the remapped build.
  results.deployRegistry = spawnSync('forge', ['test', '--match-path', 'test/deploy/DeployRegistry.t.sol', '--match-test', 'test_productionStack_deploysRegistry'], {
    cwd: MC,
    encoding: 'utf8',
  });
  results.remapped = runCheck('remapped');
});

after(() => {
  for (const p of anvils) p.kill();
  if (!process.env.KEEP_TMP) rmSync(tmp, { recursive: true, force: true });
});

test('baseline: the stack at the real pin passes (the harness is sound)', () => {
  assert.equal(results.baseline.status, 0);
});

test('M. committed remappings.txt redirects the pinned CertManager\'s ./LibBytes.sol: check-deploy must not pass', () => {
  assert.equal(results.remappedClean, '');
  assert.equal(gitIn(NV, 'status', '--porcelain'), '');
  assert.equal(gitIn(NV, 'rev-parse', 'HEAD'), PINNED_FULL);
  // compilationTarget is still the pinned file; one of its sources is not.
  assert.deepEqual(results.remappedTarget, { 'lib/nitro-validator/src/CertManager.sol': 'CertManager' });
  assert.ok(results.remappedSources.includes('src/evil/LibBytes.sol'), results.remappedSources.join(', '));
  // The deployed CertManager is not the code the real pin compiles to.
  assert.notEqual(env.remapped.certManagerCode, env.clean.certManagerCode);
  // DeployRegistry's own guard compares against the same remapped build.
  process.stdout.write(`--- DeployRegistry in-EVM check on the remapped stack (exit ${results.deployRegistry.status})\n`);
  assert.notEqual(
    results.remapped.status,
    0,
    'check-deploy passed a CertManager compiled against src/evil/LibBytes.sol via a committed remapping, not base/nitro-validator at the pin (ADR-001, SPEC §3.5)',
  );
});

test('G. global ~/.foundry/foundry.toml redirects the pinned ./LibBytes.sol: check-deploy must not pass', () => {
  assert.equal(results.globalClean, '');
  assert.notEqual(env.global.certManagerCode, env.clean.certManagerCode);
  assert.notEqual(
    results.global.status,
    0,
    'check-deploy passed a CertManager compiled against a LibBytes.sol named only in ~/.foundry/foundry.toml (ADR-001, SPEC §3.5)',
  );
});
