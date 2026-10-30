// Adversary test for T10 round 8: the pre-deploy check reads contracts/out, forge script does not
// have to.
//   flock /home/hr/.cache/attessa-heavy.lock node --test scripts/check-deploy.adversary8.test.mjs
// Needs forge, cast and git on PATH. No RPC, no transaction: forge in a scratch mirror only.
//
// docs/DEPLOYMENTS.md: before every simulation and broadcast, `node ../scripts/check-deploy.mjs
// --pre-deploy` "requires `contracts/out` to match [the reference build] byte for byte ... it must
// print `PASS`". scripts/check-deploy.mjs preDeploy() runs `forge build` in contracts/ with the
// committed config, then reads the hard-coded join(contracts, 'out'). forge build and forge script
// write and read the `out` directory the committed foundry.toml names.
//
// O. One commit:
//   - contracts/foundry.toml: `out = "artifacts"` instead of `out = "out"`;
//   - contracts/remappings.txt: `script/DeployBase.sol=src/evil/DeployBase.sol`, with
//     src/evil/DeployBase.sol a copy whose _requireProductionStack checks nothing (round 7 X);
//   - contracts/out/: the clean tree's own build output, force-added (or simply left over in the
//     checkout from building the previous, clean commit; out/ is gitignored, not removed by checkout).
// script/DeployBase.sol and script/DeployRegistry.s.sol are unchanged. The checkout has no cache/
// (gitignored, as in a fresh clone). The pre-deploy check builds into contracts/artifacts, compares
// the untouched contracts/out with the reference and prints PASS; forge script and forge test
// compile and run the remapped DeployBase from contracts/artifacts. The check must FAIL.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = join(ROOT, 'contracts');
const PINNED_FULL = '0ea0d12366b4fa44f9e07e4755f2ad36561cb674';
const REFUSALS = [
  'test_lookAlikeValidator_refused_viaEnv',
  'test_genuineValidatorOverDemoCertManager_refused',
  'test_validatorWithForeignP384_refused',
  'test_genuineStackOverAcceptAllP384_refused',
];

const tmp = mkdtempSync(join(tmpdir(), 'check-deploy-adv8-'));
const M = join(tmp, 'mirror');
const MC = join(M, 'contracts');
const NV = join(MC, 'lib', 'nitro-validator');
const results = {};

const gitIn = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
const gitId = ['-c', 'user.email=adversary@test', '-c', 'user.name=adversary', '-c', 'commit.gpgsign=false'];
const commitMirror = (msg) => {
  gitIn(M, 'add', '-A');
  gitIn(M, ...gitId, 'commit', '--quiet', '-m', msg);
};

function preDeploy(label) {
  const r = spawnSync('node', [join(M, 'scripts', 'check-deploy.mjs'), '--pre-deploy'], { cwd: MC, encoding: 'utf8' });
  process.stdout.write(`--- check-deploy --pre-deploy, ${label} (exit ${r.status})\n${r.stdout}${r.stderr}`);
  return { status: r.status, out: r.stdout + r.stderr };
}

function deployRegistryTests(label) {
  const r = spawnSync('forge', ['test', '--match-path', 'test/deploy/DeployRegistry.t.sol'], { cwd: MC, encoding: 'utf8', maxBuffer: 64 << 20 });
  const lines = r.stdout.split('\n').filter((l) => /^\[(PASS|FAIL)|Suite result/.test(l));
  process.stdout.write(`--- DeployRegistry.t.sol, ${label} (exit ${r.status})\n${lines.join('\n')}\n`);
  const names = (tag) => new Set(lines.filter((l) => l.startsWith(`[${tag}`)).map((l) => /(test_\w+)\(/.exec(l)?.[1]));
  return { status: r.status, passed: names('PASS'), failed: names('FAIL') };
}

before(() => {
  mkdirSync(join(M, 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'scripts', 'check-deploy.mjs'), join(M, 'scripts', 'check-deploy.mjs'));
  cpSync(join(ROOT, '.gitignore'), join(M, '.gitignore'));
  cpSync(CONTRACTS, MC, { recursive: true, filter: (p) => !['out', 'cache', 'broadcast', 'lib'].includes(basename(p)) || dirname(p) !== CONTRACTS });
  execFileSync('git', ['clone', '--quiet', '--no-checkout', join(CONTRACTS, 'lib', 'nitro-validator'), NV]);
  gitIn(NV, 'checkout', '--quiet', '--detach', PINNED_FULL);
  const FS = join(NV, 'lib', 'forge-std');
  execFileSync('git', ['clone', '--quiet', '--no-checkout', join(CONTRACTS, 'lib', 'nitro-validator', 'lib', 'forge-std'), FS]);
  gitIn(FS, 'checkout', '--quiet', '--detach', gitIn(NV, 'ls-tree', 'HEAD', 'lib/forge-std').split(/\s+/)[2]);
  gitIn(M, 'init', '--quiet');
  commitMirror('mirror at the real pin');

  // Control: the clean tree, as DEPLOYMENTS.md runs it (forge build, then the check).
  execFileSync('forge', ['build'], { cwd: MC, stdio: ['ignore', 'ignore', 'inherit'] });
  results.preDeployClean = preDeploy('clean tree');
  const cleanRegistry = JSON.parse(readFileSync(join(MC, 'out/DeployRegistry.s.sol/DeployRegistry.json'), 'utf8'));

  // O: the attack commit.
  const toml = readFileSync(join(MC, 'foundry.toml'), 'utf8');
  assert.equal(toml.split('\nout = "out"\n').length, 2, 'foundry.toml out line changed; update this test');
  writeFileSync(join(MC, 'foundry.toml'), toml.replace('\nout = "out"\n', '\nout = "artifacts"\n'));
  const src = readFileSync(join(MC, 'script', 'DeployBase.sol'), 'utf8');
  const head = '    function _requireProductionStack(address validator) internal returns (address certManager, address p384) {\n';
  const imp = 'import {EnclaveRegistry} from "../src/EnclaveRegistry.sol";\n';
  assert.equal(src.split(head).length, 2, '_requireProductionStack changed; update this test');
  assert.equal(src.split(imp).length, 2, 'DeployBase.sol imports changed; update this test');
  mkdirSync(join(MC, 'src', 'evil'), { recursive: true });
  writeFileSync(
    join(MC, 'src', 'evil', 'DeployBase.sol'),
    src
      .replace(imp, 'import {EnclaveRegistry} from "src/EnclaveRegistry.sol";\n')
      .replace(head, head + '        return (address(NitroValidator(validator).certManager()), address(NitroValidator(validator).p384Verifier()));\n'),
  );
  appendFileSync(join(MC, 'remappings.txt'), 'script/DeployBase.sol=src/evil/DeployBase.sol\n');
  gitIn(M, 'add', '-A');
  gitIn(M, 'add', '-f', 'contracts/out');
  gitIn(M, ...gitId, 'commit', '--quiet', '-m', 'build: artifacts dir');
  // A fresh clone has no cache/ (gitignored).
  rmSync(join(MC, 'cache'), { recursive: true, force: true });
  results.clean = gitIn(M, 'status', '--porcelain');
  results.scriptsUnchanged = ['script/DeployBase.sol', 'script/DeployRegistry.s.sol'].every(
    (p) => readFileSync(join(MC, p), 'utf8') === readFileSync(join(CONTRACTS, p), 'utf8'),
  );

  // As DEPLOYMENTS.md: forge build, then the check, then forge script (here: forge test, same build).
  execFileSync('forge', ['build'], { cwd: MC, stdio: ['ignore', 'ignore', 'inherit'] });
  results.preDeployO = preDeploy('out = "artifacts"');
  const used = join(MC, 'artifacts/DeployRegistry.s.sol/DeployRegistry.json');
  results.usedExists = existsSync(used);
  if (results.usedExists) {
    const art = JSON.parse(readFileSync(used, 'utf8'));
    results.usedSources = Object.keys(art.metadata.sources);
    results.usedDiffers = art.bytecode.object !== cleanRegistry.bytecode.object;
  }
  results.o = deployRegistryTests('out = "artifacts"');
});

after(() => {
  if (!process.env.KEEP_TMP) rmSync(tmp, { recursive: true, force: true });
});

test('control: at the clean tree the pre-deploy check PASSES', () => {
  assert.equal(results.preDeployClean.status, 0);
  assert.match(results.preDeployClean.out, /^PASS: /m);
});

test('O. committed `out = "artifacts"` with the clean build in contracts/out: the pre-deploy check must FAIL', () => {
  assert.equal(results.clean, '');
  assert.ok(results.scriptsUnchanged);
  // What forge script will run: DeployRegistry compiled against src/evil/DeployBase.sol, accepting look-alikes.
  assert.ok(results.usedExists, 'forge build wrote no contracts/artifacts');
  assert.ok(results.usedSources.includes('src/evil/DeployBase.sol'), results.usedSources.join(', '));
  assert.ok(results.usedDiffers);
  assert.deepEqual(REFUSALS.filter((t) => results.o.passed.has(t)), [], 'the remapped build still refuses look-alikes; the attack did not take');
  assert.notEqual(
    results.preDeployO.status,
    0,
    'the pre-deploy check PASSED contracts/out while forge script builds and runs contracts/artifacts, whose DeployRegistry skips every validator check (DEPLOYMENTS.md, ADR-001)',
  );
});
