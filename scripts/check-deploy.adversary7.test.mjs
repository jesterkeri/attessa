// Adversary test for T10 round 7: a committed remapping swaps out DeployBase.sol itself.
//   flock /home/hr/.cache/attessa-heavy.lock node --test scripts/check-deploy.adversary7.test.mjs
// Needs forge, cast and git on PATH. No RPC, no transaction: forge in a scratch mirror only.
//
// ADR-001 ("pinned, unmodified ... Never modify it") and the claim in
// contracts/script/DeployBase.sol: DeployRegistry refuses, before broadcasting, any validator that
// is not the pinned nitro-validator build ("Any other byte, length or immutable value is refused").
//
// The guard lives in script/DeployBase.sol, which DeployRegistry.s.sol imports as "./DeployBase.sol".
// solc applies remappings to the source unit name a relative import resolves to (round 5 M), so one
// committed line in contracts/remappings.txt,
//   script/DeployBase.sol=src/evil/DeployBase.sol
// makes DeployRegistry.s.sol inherit a copy of DeployBase whose _requireProductionStack returns the
// validator's getters and checks nothing. script/DeployBase.sol and script/DeployRegistry.s.sol stay
// byte-identical to the commit under review; the pinned constants are still there, unused.
//
// The repo's own DeployRegistry tests (test/deploy/DeployRegistry.t.sol) run in the mirror. They
// import "../../script/DeployBase.sol", which the same remapping redirects, so they exercise exactly
// what `forge script script/DeployRegistry.s.sol` would. At the real tree they all pass; with the
// remapping committed, every refusal case (look-alike validator from Codex r1 M2, demo CertManager,
// foreign or accept-all P384Verifier) must still be refused.
//
// X rewritten per Joshua's decision 2026-10-30: no in-script guard can stop a committed tree that
// replaces the guard (rounds 5, 6, 7), so X now targets the pre-deploy check Joshua runs before
// every simulation and broadcast (`node scripts/check-deploy.mjs --pre-deploy`): on the X tree it
// must FAIL; on the clean tree it must PASS (control).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
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

const tmp = mkdtempSync(join(tmpdir(), 'check-deploy-adv7-'));
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

/** check-deploy --pre-deploy in the mirror: { status, out }. */
function preDeploy(label) {
  const r = spawnSync('node', [join(M, 'scripts', 'check-deploy.mjs'), '--pre-deploy'], { encoding: 'utf8' });
  process.stdout.write(`--- check-deploy --pre-deploy, ${label} (exit ${r.status})\n${r.stdout}${r.stderr}`);
  return { status: r.status, out: r.stdout + r.stderr };
}

/** forge test over test/deploy/DeployRegistry.t.sol in the mirror: { status, passed: Set, failed: Set }. */
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
  // A clone, not a copy: the pre-deploy check reads forge-std's committed blobs.
  const FS = join(NV, 'lib', 'forge-std');
  execFileSync('git', ['clone', '--quiet', '--no-checkout', join(CONTRACTS, 'lib', 'nitro-validator', 'lib', 'forge-std'), FS]);
  gitIn(FS, 'checkout', '--quiet', '--detach', gitIn(NV, 'ls-tree', 'HEAD', 'lib/forge-std').split(/\s+/)[2]);
  gitIn(M, 'init', '--quiet');
  commitMirror('mirror at the real pin');
  results.baseline = deployRegistryTests('real tree');
  results.preDeployClean = preDeploy('real tree');

  // The copy: DeployBase.sol with one early return in _requireProductionStack.
  const src = readFileSync(join(MC, 'script', 'DeployBase.sol'), 'utf8');
  const head = '    function _requireProductionStack(address validator) internal returns (address certManager, address p384) {\n';
  const imp = 'import {EnclaveRegistry} from "../src/EnclaveRegistry.sol";\n';
  assert.equal(src.split(head).length, 2, '_requireProductionStack changed; update this test');
  assert.equal(src.split(imp).length, 2, 'DeployBase.sol imports changed; update this test');
  const evil = src
    .replace(imp, 'import {EnclaveRegistry} from "src/EnclaveRegistry.sol";\n')
    .replace(head, head + '        return (address(NitroValidator(validator).certManager()), address(NitroValidator(validator).p384Verifier()));\n');
  mkdirSync(join(MC, 'src', 'evil'), { recursive: true });
  writeFileSync(join(MC, 'src', 'evil', 'DeployBase.sol'), evil);
  appendFileSync(join(MC, 'remappings.txt'), 'script/DeployBase.sol=src/evil/DeployBase.sol\n');
  commitMirror('remappings: script helpers');
  results.clean = gitIn(M, 'status', '--porcelain');
  results.scriptsUnchanged = ['script/DeployBase.sol', 'script/DeployRegistry.s.sol'].every(
    (p) => readFileSync(join(MC, p), 'utf8') === readFileSync(join(CONTRACTS, p), 'utf8'),
  );
  // forge 1.8.1's cache does not notice a remappings.txt change; a fresh clone (where Joshua runs
  // `forge script`) has no cache, so rebuild from scratch as it would.
  execFileSync('forge', ['build', '--force'], { cwd: MC, stdio: ['ignore', 'ignore', 'inherit'] });
  results.remapped = deployRegistryTests('remapped DeployBase');
  results.preDeployX = preDeploy('remapped DeployBase');
});

after(() => {
  if (!process.env.KEEP_TMP) rmSync(tmp, { recursive: true, force: true });
});

test('baseline: at the real tree every DeployRegistry refusal test passes (the harness is sound)', () => {
  for (const t of REFUSALS) assert.ok(results.baseline.passed.has(t), `${t} did not pass at the real tree`);
  assert.equal(results.baseline.status, 0);
});

test('control: at the real tree the pre-deploy check PASSES', () => {
  assert.equal(results.preDeployClean.status, 0);
  assert.match(results.preDeployClean.out, /^PASS: /m);
});

test('X. committed remapping replaces DeployBase.sol under the unchanged deploy scripts: the pre-deploy check must FAIL', () => {
  assert.equal(results.clean, '');
  assert.ok(results.scriptsUnchanged, 'script/DeployBase.sol or script/DeployRegistry.s.sol differs from the commit under review');
  assert.equal(results.preDeployX.status, 1, 'the pre-deploy check did not FAIL a tree whose remapping swaps out script/DeployBase.sol (ADR-001)');
  assert.match(results.preDeployX.out, /^FAIL: /m);
  assert.match(results.preDeployX.out, /DeployRegistry local artifact compiled src\/evil\/DeployBase\.sol/);
});
