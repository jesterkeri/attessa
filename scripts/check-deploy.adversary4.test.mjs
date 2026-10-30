// Adversary test for scripts/check-deploy.mjs (T10, round 4): a shadowing contract name, and
// git replace objects.
//   flock /home/hr/.cache/attessa-heavy.lock node --test scripts/check-deploy.adversary4.test.mjs
// Needs forge, anvil and git on PATH. No transaction is sent anywhere.
//
// ADR-001 and SPEC §3.5: the validator stack is base/nitro-validator at the pinned commit
// 0ea0d12366b4fa44f9e07e4755f2ad36561cb674, never modified. check-deploy reads the reference
// sources with `git ls-tree <pinned>` and `git cat-file blob` in the submodule. Both honour
// refs/replace/*: `git replace <pinned> <other>` makes every plain git command see <other>'s tree
// under the pinned id. A replace ref is local, never committed, and invisible to `git status`
// and `git submodule status`: the superproject still records the real pinned id and is clean.
//
// Setup, as in check-deploy.adversary3.test.mjs: a committed mirror of the repo at the real pin;
// DumpStack (the deploy scripts' own deploy code) deploys from it and the dumped state is loaded
// into anvil at chain 11142220. A baseline at the real pin must pass. Then, in the mirror's
// submodule only: commit CertManager._certificateExpired patched to always return false (accept
// expired certificates), `git replace <pinned> <that commit>`, check out <pinned>. The mirror is
// clean and HEAD still pins the full real id. check-deploy must not exit 0 for the patched stack.
//
// S. check-deploy reads the reference CertManager from out/CertManager.sol/CertManager.json. When
// contracts/src also has a file named CertManager.sol declaring `contract CertManager`, forge 1.8.1
// writes that one to out/CertManager.sol/ and moves the pinned one to out/src/CertManager.sol/. So
// a committed contracts/src/x/CertManager.sol (the pinned file with the expiry check patched out,
// imports pointed at nitro-validator/) becomes the reference. A forge script in the mirror deploys
// that shadow CertManager with the production constructor arguments; the rest of the stack is the
// pinned P384Verifier and NitroValidator and the committed EnclaveRegistry, as DeployBase wires
// them. check-deploy must not exit 0: the deployed CertManager is not base/nitro-validator's.

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
const FIRST_PORT = 19500 + (process.pid % 40) * 4;

// Deploys the stack with the shadow CertManager and the deploy scripts' registry wiring, then dumps
// the state, as DumpStack.s.sol does.
const DUMP_SHADOW = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {P384Verifier} from "nitro-validator/P384Verifier.sol";
import {NitroValidator} from "nitro-validator/NitroValidator.sol";
import {CertManager as ShadowCertManager} from "../../src/x/CertManager.sol";
import {EnclaveRegistry} from "../../src/EnclaveRegistry.sol";
import {RegistryDeployer} from "../../script/DeployBase.sol";

contract DumpShadow is Script, RegistryDeployer {
    string internal constant DIR = "cache/check-deploy/";

    function run(string calldata variant) external {
        vm.chainId(CELO_SEPOLIA);
        address admin = address(uint160(uint256(keccak256("attessa check-deploy test admin"))));
        P384Verifier p = new P384Verifier();
        ShadowCertManager c = new ShadowCertManager(p, admin, admin);
        NitroValidator n = new NitroValidator(c, p);
        EnclaveRegistry registry = _deployRegistry(address(n));
        string memory k = "manifest";
        vm.serializeAddress(k, "Admin", admin);
        vm.serializeAddress(k, "P384Verifier", address(p));
        vm.serializeAddress(k, "CertManager", address(c));
        vm.serializeAddress(k, "NitroValidator", address(n));
        string memory json = vm.serializeAddress(k, "EnclaveRegistry", address(registry));
        vm.createDir(DIR, true);
        vm.writeJson(json, string.concat(DIR, variant, ".manifest.json"));
        vm.dumpState(string.concat(DIR, variant, ".state.json"));
    }
}
`;

const tmp = mkdtempSync(join(tmpdir(), 'check-deploy-adv4-'));
const M = join(tmp, 'mirror');
const MC = join(M, 'contracts');
const NV = join(MC, 'lib', 'nitro-validator');
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

async function deploy(label, script = 'test/deploy/DumpStack.s.sol:DumpStack', variant = 'production') {
  forge('script', script, '--sig', 'run(string)', variant);
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

  // S: a committed contracts/src/x/CertManager.sol shadows the pinned one in the reference build.
  const pinnedSrc = readFileSync(join(NV, 'src', 'CertManager.sol'), 'utf8');
  const expiry = '        return notAfter < block.timestamp;\n';
  assert.equal(pinnedSrc.split(expiry).length, 2, 'CertManager._certificateExpired changed; update this test');
  mkdirSync(join(MC, 'src', 'x'), { recursive: true });
  writeFileSync(
    join(MC, 'src', 'x', 'CertManager.sol'),
    pinnedSrc.replaceAll('from "./', 'from "nitro-validator/').replace(expiry, '        notAfter;\n        return false;\n'),
  );
  writeFileSync(join(MC, 'test', 'deploy', 'DumpShadow.s.sol'), DUMP_SHADOW);
  commitMirror('add src/x/CertManager.sol');
  forge('build', '--force');
  await deploy('shadow', 'test/deploy/DumpShadow.s.sol:DumpShadow', 'shadow');
  results.shadowLayout = {
    short: JSON.parse(readFileSync(join(MC, 'out/CertManager.sol/CertManager.json'), 'utf8')).metadata.settings.compilationTarget,
  };
  results.shadow = runCheck('shadow');
  results.shadowClean = gitIn(M, 'status', '--porcelain');
  gitIn(M, 'rm', '--quiet', '-r', 'contracts/src/x', 'contracts/test/deploy/DumpShadow.s.sol');
  commitMirror('drop the shadow');

  // R: patch the expiry check in a new submodule commit, then make the pinned id resolve to it.
  const cm = join(NV, 'src', 'CertManager.sol');
  const src = readFileSync(cm, 'utf8');
  const orig = '        return notAfter < block.timestamp;\n';
  assert.equal(src.split(orig).length, 2, 'CertManager._certificateExpired changed; update this test');
  writeFileSync(cm, src.replace(orig, '        notAfter;\n        return false;\n'));
  gitIn(NV, 'add', 'src/CertManager.sol');
  gitIn(NV, ...gitId, 'commit', '--quiet', '-m', 'CertManager: tidy expiry check');
  const patched = gitIn(NV, 'rev-parse', 'HEAD');
  gitIn(NV, 'replace', PINNED_FULL, patched);
  gitIn(NV, 'checkout', '--quiet', '--detach', PINNED_FULL);
  forge('build', '--force');
  await deploy('replaced');
});

after(() => {
  for (const p of anvils) p.kill();
  if (!process.env.KEEP_TMP) rmSync(tmp, { recursive: true, force: true });
});

test('baseline: the stack at the real pin passes (the harness is sound)', () => {
  assert.equal(results.baseline.status, 0);
});

test('S. committed src/x/CertManager.sol shadows the pinned one, deployed CertManager backdoored: check-deploy must not pass', () => {
  assert.equal(results.shadowClean, '');
  // forge put the shadow, not lib/nitro-validator's file, at the path check-deploy reads.
  assert.deepEqual(results.shadowLayout.short, { 'src/x/CertManager.sol': 'CertManager' });
  // The deployed CertManager is not the code the real pin compiles to.
  assert.notEqual(env.shadow.certManagerCode, env.clean.certManagerCode);
  assert.notEqual(results.shadow.status, 0, 'check-deploy passed a CertManager compiled from contracts/src/x/CertManager.sol, not base/nitro-validator (ADR-001, SPEC §3.5)');
});

test('R. pinned id replaced locally with a backdoored CertManager commit: check-deploy must not pass', () => {
  // The superproject is committed, clean, and records the full real pin; so is the submodule.
  assert.equal(gitIn(M, 'status', '--porcelain'), '');
  assert.equal(gitIn(NV, 'status', '--porcelain'), '');
  assert.equal(gitIn(M, 'ls-tree', 'HEAD', 'contracts/lib/nitro-validator').split(/\s+/)[2], PINNED_FULL);
  assert.equal(gitIn(NV, 'rev-parse', 'HEAD'), PINNED_FULL);
  // Without replace objects, git still has the real pinned tree; its CertManager is the original.
  const real = execFileSync('git', ['--no-replace-objects', '-C', NV, 'show', `${PINNED_FULL}:src/CertManager.sol`], { encoding: 'utf8' });
  assert.ok(real.includes('        return notAfter < block.timestamp;\n'));
  // The deployed CertManager is not the code the real pin compiles to.
  assert.notEqual(env.replaced.certManagerCode, env.clean.certManagerCode);
  const r = runCheck('replaced');
  assert.notEqual(r.status, 0, `check-deploy passed a CertManager that accepts expired certificates; ${PINNED_FULL} is replaced by a local refs/replace object (ADR-001)`);
});
