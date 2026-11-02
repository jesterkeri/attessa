// Adversary test for T10 round 9: a committed contracts/.env points svm at a committed solc.
//   flock /home/hr/.cache/attessa-heavy.lock node --test scripts/check-deploy.adversary9.test.mjs
// Needs forge, cast, git and node on PATH, solc 0.8.26 installed by svm, and no ~/.svm (svm then
// uses $XDG_DATA_HOME/svm). No RPC, no transaction: forge in a scratch mirror only.
//
// scripts/check-deploy.mjs preDeploy(): "stops before building on any difference that could change
// which compiler runs, so a committed solc path never executes", comparing `forge config --json`.
// DEPLOYMENTS.md: `--pre-deploy` must print PASS before every `forge script`.
//
// forge loads contracts/.env into its own environment (dotenv, no override). svm-rs finds
// installed compilers under $XDG_DATA_HOME/svm when ~/.svm does not exist; the `dirs` crate wants
// an absolute path, and /proc/self/cwd/... is one that needs no knowledge of the checkout's
// location. So one committed (force-added; .env is gitignored) line,
//   XDG_DATA_HOME=/proc/self/cwd/.data
// plus a committed executable contracts/.data/svm/0.8.26/solc-0.8.26 makes every forge compile in
// contracts/ run committed code, while `forge config --json` still says solc "0.8.26".
//
// E. The committed "solc" forwards to the real solc. Under `forge build` (the pre-deploy check's
//    build) it changes nothing, so the artifacts equal the reference, and it schedules the removal of
//    cache/solidity-files-cache.json a few seconds later. The next compile (forge script; here forge
//    test, the same compile pipeline) finds no cache, recompiles, and the committed "solc" rewrites
//    script/DeployBase.sol in solc's input so _requireProductionStack checks nothing (round 7 X).
//    script/*.sol on disk never change. The pre-deploy check must not PASS this tree, and must not
//    execute committed code.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
const REAL_SOLC = [join(homedir(), '.svm'), process.env.XDG_DATA_HOME && join(process.env.XDG_DATA_HOME, 'svm'), join(homedir(), '.local', 'share', 'svm')]
  .filter(Boolean)
  .map((d) => join(d, '0.8.26', 'solc-0.8.26'))
  .find((p) => existsSync(p));

const tmp = mkdtempSync(join(tmpdir(), 'check-deploy-adv9-'));
const M = join(tmp, 'mirror');
const MC = join(M, 'contracts');
const NV = join(MC, 'lib', 'nitro-validator');
const LOG = join(tmp, 'solc-calls.log');
const results = {};

const gitIn = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
const gitId = ['-c', 'user.email=adversary@test', '-c', 'user.name=adversary', '-c', 'commit.gpgsign=false'];
const commitMirror = (msg) => {
  gitIn(M, 'add', '-A');
  gitIn(M, ...gitId, 'commit', '--quiet', '-m', msg);
};
const calls = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : []);

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

// The committed "solc". The real solc path is embedded as an attacker would find it.
const HEAD = '    function _requireProductionStack(address validator) internal returns (address certManager, address p384) {\n';
const RET = '        return (address(NitroValidator(validator).certManager()), address(NitroValidator(validator).p384Verifier()));\n';
const wrapper = () => `#!/usr/bin/env node
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const args = process.argv.slice(2);
let sub = '?';
try { sub = fs.readFileSync('/proc/' + process.ppid + '/cmdline', 'utf8').split('\\0')[1]; } catch {}
fs.appendFileSync(${JSON.stringify(LOG)}, sub + ' ' + args.join(' ') + '\\n');
if (!args.includes('--standard-json')) {
  const r = spawnSync(${JSON.stringify(REAL_SOLC)}, args, { stdio: 'inherit' });
  process.exit(r.status);
}
let input = fs.readFileSync(0, 'utf8');
if (sub === 'build') {
  const c = 'cache/solidity-files-cache.json';
  spawn('sh', ['-c', 'i=0; while [ ! -f ' + c + ' ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done; sleep 2; rm -f ' + c], { detached: true, stdio: 'ignore' }).unref();
} else {
  const j = JSON.parse(input);
  const k = 'script/DeployBase.sol';
  if (j.sources[k] && j.sources[k].content) j.sources[k].content = j.sources[k].content.replace(${JSON.stringify(HEAD)}, ${JSON.stringify(HEAD + RET)});
  input = JSON.stringify(j);
}
const r = spawnSync(${JSON.stringify(REAL_SOLC)}, args, { input, maxBuffer: 1 << 30 });
// Synchronous writes: process.exit would cut an asynchronous pipe write short.
const put = (fd, b) => { for (let o = 0; o < b.length; ) o += fs.writeSync(fd, b, o, b.length - o); };
put(1, r.stdout);
put(2, r.stderr);
process.exit(r.status);
`;

before(async () => {
  assert.ok(REAL_SOLC, 'no svm solc 0.8.26 installed');
  assert.ok(!existsSync(join(homedir(), '.svm')), 'svm uses ~/.svm here, not $XDG_DATA_HOME/svm; this test needs no ~/.svm');
  assert.equal(process.env.XDG_DATA_HOME, undefined, 'XDG_DATA_HOME is set in this shell; dotenv would not override it');
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

  // Control: the clean tree.
  execFileSync('forge', ['build'], { cwd: MC, stdio: ['ignore', 'ignore', 'inherit'] });
  results.preDeployClean = preDeploy('clean tree');

  // E: the attack commit. script/*.sol, foundry.toml and remappings.txt are untouched.
  const src = readFileSync(join(MC, 'script', 'DeployBase.sol'), 'utf8');
  assert.equal(src.split(HEAD).length, 2, '_requireProductionStack changed; update this test');
  writeFileSync(join(MC, '.env'), 'XDG_DATA_HOME=/proc/self/cwd/.data\n');
  const solc = join(MC, '.data', 'svm', '0.8.26', 'solc-0.8.26');
  mkdirSync(dirname(solc), { recursive: true });
  writeFileSync(solc, wrapper());
  chmodSync(solc, 0o755);
  gitIn(M, 'add', '-A');
  gitIn(M, 'add', '-f', 'contracts/.env');
  gitIn(M, ...gitId, 'commit', '--quiet', '-m', 'tooling: data dir');
  results.committed = gitIn(M, 'ls-files', 'contracts/.env', 'contracts/.data').split('\n');
  results.cleanTree = gitIn(M, 'status', '--porcelain');

  const cfg = JSON.parse(execFileSync('forge', ['config', '--json'], { cwd: MC, encoding: 'utf8' }));
  results.configSolc = cfg.solc;
  // As DEPLOYMENTS.md: forge build, the check, then forge script (here forge test: the same compile).
  execFileSync('forge', ['build'], { cwd: MC, stdio: ['ignore', 'ignore', 'inherit'] });
  rmSync(LOG, { force: true });
  results.preDeployE = preDeploy('committed .env + .data/svm');
  results.callsDuringCheck = calls();
  for (let i = 0; i < 100 && existsSync(join(MC, 'cache', 'solidity-files-cache.json')); i++) await new Promise((r) => setTimeout(r, 200));
  results.e = deployRegistryTests('after PASS');
  results.callsAll = calls();
});

after(() => {
  if (!process.env.KEEP_TMP) rmSync(tmp, { recursive: true, force: true });
});

test('control: at the clean tree the pre-deploy check PASSES', () => {
  assert.equal(results.preDeployClean.status, 0);
  assert.match(results.preDeployClean.out, /^PASS: /m);
});

test('E1. committed contracts/.env + .data/svm/0.8.26/solc-0.8.26: the pre-deploy check must not run committed code', () => {
  assert.deepEqual(results.committed.sort(), ['contracts/.data/svm/0.8.26/solc-0.8.26', 'contracts/.env']);
  assert.equal(results.cleanTree, '');
  assert.equal(results.configSolc, '0.8.26');
  assert.deepEqual(
    results.callsDuringCheck.filter((l) => l.startsWith('build ')),
    [],
    `the committed contracts/.data/svm/0.8.26/solc-0.8.26 ran during --pre-deploy (exit ${results.preDeployE.status}): ${results.callsDuringCheck.length} calls`,
  );
});

// E2 rewritten per Joshua's decision 2026-10-31: asserted through the check's own exit code and FAIL line.
test('E2. the same tree: the pre-deploy check must refuse a tree whose committed .env runs a committed solc', () => {
  assert.equal(results.preDeployE.status, 1, 'the pre-deploy check did not FAIL a tree whose committed .env runs a committed solc (DEPLOYMENTS.md, ADR-001)');
  assert.match(results.preDeployE.out, /^FAIL {2}contracts\/\.env is committed/m);
  assert.match(results.preDeployE.out, /^FAIL: /m);
});
