// Adversary test for T10 round 6: DeployRegistry's pinned CBOR metadata trailers.
//   flock /home/hr/.cache/attessa-heavy.lock node --test scripts/check-deploy.adversary6.test.mjs
// Needs forge, anvil and git on PATH. No transaction is sent anywhere.
//
// ADR-001: base/nitro-validator, "pinned, unmodified ... Never modify it." DeployRegistry
// (contracts/script/DeployBase.sol, ValidatorStackChecker) says it refuses, before broadcasting, a
// validator stack that is not the pinned sources under the production settings: the in-EVM
// code-hash comparison against this build, plus each runtime code's last 53 bytes equal to a
// pinned CBOR metadata trailer.
//
// The trailer is only bytes at the end of the runtime code. With `cbor_metadata = false` and
// `bytecode_hash = "none"` solc emits no trailer at all, and a bytes literal longer than 128 bytes
// is stored as a data item appended after the code. Data items are ordered by hash, so a padding
// byte is ground until the literal comes last. A committed tree then has:
//   - foundry.toml: cbor_metadata = false, bytecode_hash = "none"
//   - remappings.txt: the pinned Asn1Decode, CborDecode, vendor/ECDSA384 and LibBytes redirected
//     to src/evil/ copies (as in round 5 M)
//   - each evil copy carries an unreachable-in-practice revert whose literal ends in the pinned
//     trailer of the contract that uses it (CertManager, NitroValidator, P384Verifier). LibBytes
//     also hashes at most 64 bytes, so CertManager's verified-certificate cache key is weakened.
//
// D. DeployRegistry's own test path (test_productionStack_deploysRegistry: the deploy scripts'
//    _deployValidatorStack, then DeployRegistry._run) on that build must refuse.
// C. The same stack deployed by DumpStack into anvil: check-deploy must not pass (the round-5 fix).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = join(ROOT, 'contracts');
const PINNED_FULL = '0ea0d12366b4fa44f9e07e4755f2ad36561cb674';
const FIRST_PORT = 19900 + (process.pid % 40) * 4;

// The trailers DeployBase.sol pins, read from it so the test follows the source.
const base = readFileSync(join(CONTRACTS, 'script', 'DeployBase.sol'), 'utf8');
const pinnedTrailer = (name) => {
  const m = new RegExp(`${name} =\\s*hex"([0-9a-f]+)"`).exec(base);
  assert.ok(m, `DeployBase.sol has no ${name}; update this test`);
  assert.equal(m[1].length, 106);
  return m[1];
};
const TRAILER = {
  CertManager: pinnedTrailer('CERT_MANAGER_METADATA'),
  NitroValidator: pinnedTrailer('NITRO_VALIDATOR_METADATA'),
  P384Verifier: pinnedTrailer('P384_VERIFIER_METADATA'),
};
// Padding bytes found by grinding (forge 1.8.1, solc 0.8.26): with these, each literal is the last
// data item of its contract. The test asserts the result rather than trusting these values.
const PAD = { CertManager: 0x01, NitroValidator: 0x01, P384Verifier: 0x18 };

const tmp = mkdtempSync(join(tmpdir(), 'check-deploy-adv6-'));
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

const hook = (lenExpr, contract) =>
  `        if (${lenExpr} == 0x5eed5eed) { bytes memory t = hex"${PAD[contract].toString(16).padStart(2, '0').repeat(120)}${TRAILER[contract]}"; assembly { revert(add(t, 32), mload(t)) } }\n`;

function writeEvil(rel, edit) {
  let s = readFileSync(join(NV, 'src', rel), 'utf8');
  s = edit(s);
  s = s.replaceAll('from "./vendor/', 'from "nitro-validator/vendor/').replaceAll('from "./', 'from "nitro-validator/');
  if (rel.startsWith('vendor/')) s = s.replace('from "nitro-validator/MemoryUtils.sol"', 'from "nitro-validator/vendor/MemoryUtils.sol"');
  const out = join(MC, 'src', 'evil', rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, s);
}
const insertAfter = (anchor, text) => (s) => {
  assert.equal(s.split(anchor).length, 2, `anchor changed: ${anchor.trim()}; update this test`);
  return s.replace(anchor, anchor + text);
};

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
  const codeOf = (a) => state[a.toLowerCase()]?.code ?? state[a]?.code;
  env[label] = { rpc, manifest, code: Object.fromEntries(['P384Verifier', 'CertManager', 'NitroValidator'].map((n) => [n, codeOf(manifest[n])])) };
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

const deployRegistryTest = () => {
  const r = spawnSync('forge', ['test', '--match-path', 'test/deploy/DeployRegistry.t.sol', '--match-test', 'test_productionStack_deploysRegistry'], { cwd: MC, encoding: 'utf8' });
  process.stdout.write(`--- DeployRegistry in-EVM check (exit ${r.status})\n${r.stdout.split('\n').filter((l) => /PASS|FAIL|Suite result/.test(l)).join('\n')}\n`);
  return r;
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
  mkdirSync(join(MC, 'cache', 'check-deploy'), { recursive: true });

  forge('build', '--force');
  results.baselineDeployRegistry = deployRegistryTest();
  await deploy('clean');
  results.baseline = runCheck('clean');

  writeEvil('Asn1Decode.sol', insertAfter('    function root(bytes memory der) internal pure returns (Asn1Ptr) {\n', hook('der.length', 'CertManager')));
  writeEvil('CborDecode.sol', insertAfter('    function keccak(bytes memory cbor, CborElement ptr) internal pure returns (bytes32) {\n', hook('cbor.length', 'NitroValidator')));
  writeEvil(
    'vendor/ECDSA384.sol',
    insertAfter('        require(consumed_ == inverseHints_.length, "unused inverse hints");\n', hook('signature_.length', 'P384Verifier')),
  );
  const keccakLine = '            result := keccak256(add(data, add(32, offset)), length)\n';
  writeEvil('LibBytes.sol', (s) => {
    assert.equal(s.split(keccakLine).length, 2, 'LibBytes.keccak changed; update this test');
    return s.replace(keccakLine, '            if gt(length, 64) { length := 64 }\n' + keccakLine);
  });
  // foundry.toml has only [profile.default], so appended keys land in it.
  appendFileSync(join(MC, 'foundry.toml'), 'cbor_metadata = false\nbytecode_hash = "none"\n');
  appendFileSync(
    join(MC, 'remappings.txt'),
    [
      'lib/nitro-validator/src/Asn1Decode.sol=src/evil/Asn1Decode.sol',
      'lib/nitro-validator/src/CborDecode.sol=src/evil/CborDecode.sol',
      'lib/nitro-validator/src/vendor/ECDSA384.sol=src/evil/vendor/ECDSA384.sol',
      'lib/nitro-validator/src/LibBytes.sol=src/evil/LibBytes.sol',
      'nitro-validator/CborDecode.sol=src/evil/CborDecode.sol',
      'nitro-validator/LibBytes.sol=src/evil/LibBytes.sol',
      '',
    ].join('\n'),
  );
  commitMirror('validator stack: tidy imports');
  forge('build', '--force');
  results.artifacts = Object.fromEntries(
    ['P384Verifier', 'CertManager', 'NitroValidator'].map((n) => [n, JSON.parse(readFileSync(join(MC, `out/${n}.sol/${n}.json`), 'utf8'))]),
  );
  results.evilDeployRegistry = deployRegistryTest();
  await deploy('evil');
  results.evilClean = gitIn(M, 'status', '--porcelain');
  results.evil = runCheck('evil');
});

after(() => {
  for (const p of anvils) p.kill();
  if (!process.env.KEEP_TMP) rmSync(tmp, { recursive: true, force: true });
});

test('baseline: at the real pin DeployRegistry accepts and check-deploy passes (the harness is sound)', () => {
  assert.equal(results.baselineDeployRegistry.status, 0);
  assert.equal(results.baseline.status, 0);
});

test('D. modified validator stack whose runtime codes end in the pinned trailers: DeployRegistry must refuse', () => {
  assert.equal(results.evilClean, '');
  assert.equal(gitIn(NV, 'status', '--porcelain'), '');
  assert.equal(gitIn(NV, 'rev-parse', 'HEAD'), PINNED_FULL);
  for (const n of ['P384Verifier', 'CertManager', 'NitroValidator']) {
    const art = results.artifacts[n];
    // Compiled against an src/evil copy, not only pinned sources.
    assert.ok(Object.keys(art.metadata.sources).some((s) => s.startsWith('src/evil/')), `${n} sources: ${Object.keys(art.metadata.sources).join(', ')}`);
    // The deployed code differs from the code at the real pin, yet ends in the pinned trailer.
    assert.notEqual(env.evil.code[n], env.clean.code[n]);
    assert.ok(env.evil.code[n].toLowerCase().endsWith(TRAILER[n]), `${n} does not end in the pinned trailer; re-grind PAD`);
  }
  assert.notEqual(
    results.evilDeployRegistry.status,
    0,
    'DeployRegistry accepted a validator stack compiled from src/evil copies whose runtime codes end in the pinned metadata trailers (ADR-001)',
  );
});

test('C. the same stack deployed: check-deploy must not pass', () => {
  assert.notEqual(results.evil.status, 0);
});
