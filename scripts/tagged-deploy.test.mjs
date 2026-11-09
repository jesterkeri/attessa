// Tests for scripts/tagged-deploy.mjs (T30): its refusals and the shape of the data file.
// Fake RPC and git; nothing is sent anywhere. Needs `cast` (keccak) on PATH.
//   node --test scripts/tagged-deploy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, symlinkSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { prepare, buildCreation, createAddress, realDeps, PINNED, STEPS, GAS_CAP, insideRepo, secureOutDir, verifyReference, CREATION_PINNED } from './tagged-deploy.mjs';
import { requireSolcPin, settingsProblems, SOLC_SHA256 } from './check-deploy.mjs';
import { attributionSuffix } from '../packages/core/src/attribution.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOYER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const ADMIN = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const TAG = 'celo_0123456789ab'; // synthetic, celo_ + 12 hex
const real = realDeps('http://127.0.0.1:1');
let refCache;
/** The real reference build (forge + the pinned solc), built once. */
const realRef = () => (refCache ??= real.loadReference());

/** Fake dependencies. The reference build must not be touched by a refusal that comes before it. */
function fakeDeps({ chain = 42220, dirty = '', code = {}, estimate = 2_000_000, art, out } = {}) {
  const calls = [];
  return {
    calls,
    rpc: async (method, params) => {
      calls.push(method);
      if (method === 'eth_chainId') return '0x' + chain.toString(16);
      if (method === 'eth_getCode') return code[params[0].toLowerCase()] ?? '0x';
      if (method === 'eth_estimateGas') return '0x' + estimate.toString(16);
      if (method === 'eth_getTransactionCount') return '0x0';
      throw new Error(`unexpected ${method}`);
    },
    gitStatus: () => dirty,
    loadReference: () => {
      calls.push('loadReference');
      if (!art) throw new Error('the reference build must not be reached');
      return art;
    },
    keccak: real.keccak,
    tmp: () => out ?? join(tmpdir(), 'td-test-unused-default'),
  };
}
const args = (o = {}) => ({ positional: [], deployer: DEPLOYER, account: 'acct', rpcUrl: 'https://forno.celo.org', out: null, tx: null, ...o });
const env = (o = {}) => ({ LOOPS_ATTRIBUTION_TAG: TAG, ATTESSA_ADMIN: ADMIN, ...o });
const refused = async (fn, re) => {
  let err;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected a refusal');
  assert.equal(err.constructor.name, 'Refuse', `expected Refuse, got ${err.stack}`);
  assert.match(err.message, re);
  return err;
};

test('no tag: refused before the RPC is asked anything', async () => {
  const d = fakeDeps();
  await refused(() => prepare('p384', args(), env({ LOOPS_ATTRIBUTION_TAG: undefined }), d, () => {}), /LOOPS_ATTRIBUTION_TAG is not set/);
  await refused(() => prepare('p384', args(), env({ LOOPS_ATTRIBUTION_TAG: '' }), d, () => {}), /LOOPS_ATTRIBUTION_TAG is not set/);
  assert.deepEqual(d.calls, []);
});

test('a bad tag is refused and its value is never echoed', async () => {
  for (const bad of ['Bad Tag SECRET!', 'UPPER', 'a'.repeat(33), 'has,comma', 'é']) {
    const d = fakeDeps();
    const err = await refused(() => prepare('p384', args(), env({ LOOPS_ATTRIBUTION_TAG: bad }), d, () => {}), /not a valid ERC-8021 code/);
    assert.ok(!err.message.includes(bad), `the message echoes ${bad}`);
    assert.ok(!err.message.includes('SECRET'));
    assert.deepEqual(d.calls, []);
  }
});

test('wrong chain id: refused', async () => {
  for (const chain of [1, 11142220, 31337]) {
    await refused(() => prepare('p384', args(), env(), fakeDeps({ chain }), () => {}), new RegExp(`chain ${chain}, not Celo mainnet 42220`));
  }
});

test('admin equal to the deployer (any letter case) or zero: refused', async () => {
  await refused(() => prepare('p384', args(), env({ ATTESSA_ADMIN: DEPLOYER.toLowerCase() }), fakeDeps(), () => {}), /not the deployer/);
  await refused(() => prepare('p384', args(), env({ ATTESSA_ADMIN: DEPLOYER.toUpperCase().replace('0X', '0x') }), fakeDeps(), () => {}), /not the deployer/);
  await refused(() => prepare('p384', args(), env({ ATTESSA_ADMIN: '0x' + '0'.repeat(40) }), fakeDeps(), () => {}), /zero address/);
  await refused(() => prepare('p384', args(), env({ ATTESSA_ADMIN: undefined }), fakeDeps(), () => {}), /ATTESSA_ADMIN is not set/);
});

test('dirty git tree: refused, and the reference build is not started', async () => {
  const d = fakeDeps({ dirty: ' M contracts/src/EnclaveRegistry.sol\n' });
  await refused(() => prepare('p384', args(), env(), d, () => {}), /git tree is not clean/);
  assert.ok(!d.calls.includes('loadReference'));
});

test('a prior-step address with no code: refused (certmanager, nitro, registry)', async () => {
  const P = '0x' + '11'.repeat(20);
  const C = '0x' + '22'.repeat(20);
  await refused(() => prepare('certmanager', args(), env({ ATTESSA_P384_VERIFIER: P }), fakeDeps({ art: {} }), () => {}), /ATTESSA_P384_VERIFIER 0x1111.* has no code/);
  await refused(() => prepare('certmanager', args(), env(), fakeDeps({ art: {} }), () => {}), /ATTESSA_P384_VERIFIER is not set/);
  await refused(() => prepare('nitro', args(), env({ ATTESSA_P384_VERIFIER: P, ATTESSA_CERT_MANAGER: C }), fakeDeps({ art: {} }), () => {}), /has no code/);
  await refused(() => prepare('registry', args(), env({ ATTESSA_NITRO_VALIDATOR: P }), fakeDeps({ art: {} }), () => {}), /ATTESSA_NITRO_VALIDATOR 0x1111.* has no code/);
});

test('a prior-step address whose code is not the reference: refused', async () => {
  const P = '0x' + '11'.repeat(20);
  const art = { P384Verifier: { deployedBytecode: { object: '0x6001600155', immutableReferences: {} } } };
  await refused(() => prepare('certmanager', args(), env({ ATTESSA_P384_VERIFIER: P }), fakeDeps({ art, code: { [P]: '0x600160025500' } }), () => {}), /not the production P384Verifier/);
});

test('unknown step, and --out inside the repository: refused', async () => {
  await refused(() => prepare('everything', args(), env(), fakeDeps(), () => {}), /unknown step/);
  const art = { P384Verifier: { bytecode: { object: '0x6001' } } };
  await refused(() => prepare('p384', args({ out: join(ROOT, 'scripts') }), env(), fakeDeps({ art }), () => {}), /inside the repository/);
});

test('an estimate x 1.3 over the 16,777,216 cap is refused and nothing is written', async () => {
  const out = mkdtempSync(join(tmpdir(), 'td-test-'));
  try {
    const art = realRef();
    await refused(() => prepare('p384', args({ out }), env(), fakeDeps({ art, estimate: Math.floor(GAS_CAP / 1.3) + 1000 }), () => {}), /exceeds Celo's per-transaction cap 16777216/);
    assert.deepEqual(readdirSync(out), []);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the data file ends with the suffix, and minus the suffix is bytecode + args', async () => {
  const out = mkdtempSync(join(tmpdir(), 'td-test-'));
  try {
    const art = realRef();
    const lines = [];
    const r = await prepare('p384', args({ out }), env(), fakeDeps({ art, estimate: 1_000_000 }), (l) => lines.push(l));
    const data = readFileSync(r.file, 'utf8').trim();
    const suffix = attributionSuffix(TAG);
    assert.ok(data.endsWith(suffix.slice(2)));
    assert.equal(data.slice(0, data.length - (suffix.length - 2)), art.P384Verifier.bytecode.object); // no constructor args for P384Verifier
    assert.equal(r.gasLimit, 1_300_000);
    const cmd = lines.find((l) => l.startsWith('cast send'));
    assert.match(cmd, /^cast send --account 'acct' --from 0x[0-9a-f]{40} --rpc-url 'https:\/\/forno\.celo\.org' --gas-limit 1300000 --create "\$\(cat '.*p384\.creation\.hex'\)"$/);
    assert.ok(!/private-key|mnemonic|interactive/.test(lines.join('\n')));
    assert.ok(lines.some((l) => l.includes('Nothing was signed or sent')));
    assert.equal(r.expected, createAddress(fakeDeps(), DEPLOYER.toLowerCase(), 0));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('constructor arguments are ABI-encoded words, in SPEC §3.5 order, and the suffix comes last', () => {
  const a = '0x' + 'aa'.repeat(20);
  const b = '0x' + 'bb'.repeat(20);
  const c = buildCreation('certmanager', { bytecode: { object: '0xdead' } }, [a, b, b], '0xabcd');
  assert.equal(c.args, '000000000000000000000000' + 'aa'.repeat(20) + ('000000000000000000000000' + 'bb'.repeat(20)).repeat(2));
  assert.equal(c.data, '0xdead' + c.args + 'abcd');
  const r = buildCreation('registry', { bytecode: { object: '0x' } }, [a, b, a, false], '0xabcd');
  assert.equal(r.args.length, 4 * 64);
  assert.equal(r.args.slice(-64), '0'.repeat(64));
});

test('createAddress matches the known CREATE vectors', () => {
  const sender = '0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0';
  assert.equal(createAddress(real, sender, 0), '0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d');
  assert.equal(createAddress(real, sender, 1), '0x343c43a37d37dff08ae8c4a11544c718abb4fcf8');
});

test('the pinned whole-code hashes equal the constants in DeployBase.sol', () => {
  const sol = readFileSync(join(ROOT, 'contracts/script/DeployBase.sol'), 'utf8');
  const get = (n) => new RegExp(`${n}\\s*=\\s*(0x[0-9a-f]{64})`).exec(sol)[1];
  assert.equal(PINNED.P384Verifier, get('P384_VERIFIER_CODEHASH'));
  assert.equal(PINNED.CertManager, get('CERT_MANAGER_CODE'));
  assert.equal(PINNED.NitroValidator, get('NITRO_VALIDATOR_CODE'));
});

test('the steps run in the order SPEC §3.5 gives', () => {
  assert.deepEqual(STEPS, ['p384', 'certmanager', 'nitro', 'registry']);
});

test('the script holds no key path and sends nothing: no signing or send calls in its source', () => {
  for (const f of ['tagged-deploy.mjs']) {
    const src = readFileSync(join(ROOT, 'scripts', f), 'utf8');
    assert.ok(!/eth_sendRawTransaction|eth_sendTransaction|PRIVATE_KEY|--private-key|keystore\.|readFileSync\([^)]*\.env/.test(src), `${f} has a send or key path`);
  }
});

test('CLI: with no tag it exits 1, names the variable, and writes no file', () => {
  const out = mkdtempSync(join(tmpdir(), 'td-cli-'));
  try {
    const r = spawnSync('node', [join(ROOT, 'scripts/tagged-deploy.mjs'), 'p384', '--deployer', DEPLOYER, '--account', 'a', '--out', out, '--rpc-url', 'http://127.0.0.1:1'], {
      env: { PATH: process.env.PATH, ATTESSA_ADMIN: ADMIN },
      encoding: 'utf8',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /LOOPS_ATTRIBUTION_TAG is not set/);
    assert.deepEqual(readdirSync(out), []);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('importing check-deploy.mjs does not run it (tagged-deploy imports the reference build from it)', () => {
  const r = spawnSync('node', ['-e', `import('${join(ROOT, 'scripts/check-deploy.mjs')}').then(m => console.log(typeof m.referenceBuild))`], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'function');
});

// ---- T30 fixes: pins, output directory, repo test ----

test('verifyReference accepts the real reference build and refuses a changed creation bytecode or runtime', () => {
  const ref = realRef();
  verifyReference(ref, real);
  for (const name of ['P384Verifier', 'CertManager', 'NitroValidator', 'EnclaveRegistry']) {
    // a byte flipped in the constructor part: the creation pin catches it (the runtime is untouched)
    const c = structuredClone(ref);
    const bc = c[name].bytecode.object.replace(/^0x/, '');
    c[name].bytecode.object = '0x' + (bc[0] === '6' ? '7' : '6') + bc.slice(1);
    assert.throws(() => verifyReference(c, real), /(does not embed|creation pin|whole-code pin)/, name);
    // a byte flipped in the runtime that is embedded: the whole-code pin catches it
    const r = structuredClone(ref);
    const dep = r[name].deployedBytecode.object.replace(/^0x/, '');
    const flipped = dep.slice(0, 200) + (dep[200] === '0' ? '1' : '0') + dep.slice(201);
    r[name].bytecode.object = '0x' + bc.replace(dep, flipped);
    r[name].deployedBytecode.object = '0x' + flipped;
    assert.throws(() => verifyReference(r, real), /whole-code pin/, name);
  }
});

test('EnclaveRegistry is pinned too (whole creation bytecode and zeroed runtime), and has no DeployBase constant', () => {
  assert.match(PINNED.EnclaveRegistry, /^0x[0-9a-f]{64}$/);
  assert.equal(Object.keys(CREATION_PINNED).length, 4);
});

test('a changed EnclaveRegistry reference is refused (it has no on-chain pin to fall back on)', () => {
  const ref = structuredClone(realRef());
  const a = ref.EnclaveRegistry;
  const dep = a.deployedBytecode.object.replace(/^0x/, '');
  const flipped = dep.slice(0, 300) + (dep[300] === '0' ? '1' : '0') + dep.slice(301);
  a.bytecode.object = '0x' + a.bytecode.object.replace(/^0x/, '').replace(dep, flipped);
  a.deployedBytecode.object = '0x' + flipped;
  assert.throws(() => verifyReference(ref, real), /EnclaveRegistry is not the pinned build/);
});

test('prepare prints no command for a reference that is not the pinned build (CertManager, via prepare)', async () => {
  const out = mkdtempSync(join(tmpdir(), 'td-test-'));
  try {
    const ref = structuredClone(realRef());
    const a = ref.CertManager;
    const dep = a.deployedBytecode.object.replace(/^0x/, '');
    const flipped = dep.slice(0, 200) + (dep[200] === '0' ? '1' : '0') + dep.slice(201);
    a.bytecode.object = '0x' + a.bytecode.object.replace(/^0x/, '').replace(dep, flipped);
    a.deployedBytecode.object = '0x' + flipped;
    const P = '0x' + '11'.repeat(20);
    const lines = [];
    await refused(() => prepare('certmanager', args({ out }), env({ ATTESSA_P384_VERIFIER: P }), fakeDeps({ art: ref, code: { [P]: realRef().P384Verifier.deployedBytecode.object }, out }), (l) => lines.push(l)), /not the pinned build/);
    assert.deepEqual(lines, []);
    assert.deepEqual(readdirSync(out), []);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('solc: only the pinned binary hash is accepted, and an unknown platform refuses', () => {
  const fake = '/nonexistent/solc';
  assert.equal(requireSolcPin(fake, 'linux-x64', () => SOLC_SHA256['linux-x64']), fake);
  assert.throws(() => requireSolcPin(fake, 'linux-x64', () => 'ab'.repeat(32)), /not the pinned solc 0\.8\.26/);
  assert.throws(() => requireSolcPin(fake, 'plan9-mips', () => SOLC_SHA256['linux-x64']), /no pinned solc/);
});

test('compiler settings: a different evm_version, solc or optimizer in the metadata is a problem', () => {
  const m = (over = {}) => ({ X: { metadata: { compiler: { version: '0.8.26+commit.8a97fa7a' }, settings: { evmVersion: 'cancun', optimizer: { enabled: true, runs: 10000 }, ...over } } } });
  assert.deepEqual(settingsProblems(m(), ['X']), []);
  assert.match(settingsProblems(m({ evmVersion: 'prague' }), ['X'])[0], /evm_version prague, not cancun/);
  assert.match(settingsProblems(m({ optimizer: { enabled: true, runs: 200 } }), ['X'])[0], /optimizer/);
  const bad = m();
  bad.X.metadata.compiler.version = '0.8.27+commit.40a35a09';
  assert.match(settingsProblems(bad, ['X'])[0], /solc 0\.8\.27/);
});

test('the real reference artifacts record cancun, solc 0.8.26 and optimizer 10000', () => {
  assert.deepEqual(settingsProblems(realRef(), ['P384Verifier', 'CertManager', 'NitroValidator', 'EnclaveRegistry']), []);
});

test('insideRepo: a directory named "..x" inside the repository is inside; the parent is outside', () => {
  assert.equal(insideRepo(join(ROOT, '..x')), true);
  assert.equal(insideRepo(join(ROOT, '..x', 'deeper')), true);
  assert.equal(insideRepo(join(ROOT, 'scripts')), true);
  assert.equal(insideRepo(ROOT), true);
  assert.equal(insideRepo(join(ROOT, '..')), false);
  assert.equal(insideRepo(join(tmpdir(), 'td-elsewhere')), false);
});

test('insideRepo: a new directory below a symlink that points into the repository is inside', () => {
  const base = mkdtempSync(join(tmpdir(), 'td-link-'));
  try {
    symlinkSync(join(ROOT, 'scripts'), join(base, 'link'));
    assert.equal(insideRepo(join(base, 'link', 'newdir')), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('prepare refuses --out named "..x" inside the repository', async () => {
  await refused(() => prepare('p384', args({ out: join(ROOT, '..x') }), env(), fakeDeps({ art: {} }), () => {}), /inside the repository/);
  assert.equal(existsSync(join(ROOT, '..x')), false);
});

test('secureOutDir: creates 0700, refuses a symlink, a file, and a directory others can write', () => {
  const base = mkdtempSync(join(tmpdir(), 'td-dir-'));
  try {
    const fresh = join(base, 'a', 'b');
    secureOutDir(fresh);
    assert.equal(statSync(fresh).mode & 0o777, 0o700);
    secureOutDir(fresh); // again: fine

    const target = join(base, 'target');
    mkdirSync(target, { mode: 0o700 });
    const link = join(base, 'link');
    symlinkSync(target, link);
    assert.throws(() => secureOutDir(link), /is a symlink/);

    const file = join(base, 'file');
    writeFileSync(file, 'x');
    assert.throws(() => secureOutDir(file), /not a directory/);

    const open = join(base, 'open');
    mkdirSync(open);
    chmodSync(open, 0o777);
    assert.throws(() => secureOutDir(open), /writable by other users/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('secureOutDir: a directory owned by someone else is refused (/ is owned by root)', { skip: process.getuid?.() === 0 }, () => {
  assert.throws(() => secureOutDir('/'), /owned by uid 0, not you|writable by other users/);
});

test('prepare: the default directory from deps.tmp() being a symlink is refused and nothing is written through it', async () => {
  const base = mkdtempSync(join(tmpdir(), 'td-def-'));
  try {
    const victim = join(base, 'victim');
    mkdirSync(victim, { mode: 0o700 });
    const dflt = join(base, 'attessa-tagged-deploy');
    symlinkSync(victim, dflt);
    await refused(() => prepare('p384', args(), env(), fakeDeps({ art: realRef(), out: dflt }), () => {}), /is a symlink/);
    assert.deepEqual(readdirSync(victim), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the default output directory is per user, and a real prepare creates it mode 0700', async () => {
  const dflt = real.tmp();
  assert.match(dflt, /attessa-tagged-deploy-/);
  const base = mkdtempSync(join(tmpdir(), 'td-mode-'));
  try {
    const out = join(base, 'fresh');
    const r = await prepare('p384', args({ out }), env(), fakeDeps({ art: realRef() }), () => {});
    assert.equal(statSync(out).mode & 0o777, 0o700);
    assert.equal(statSync(r.file).mode & 0o777, 0o600);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the tag: the source does not claim the suffix is never echoed, and the output prints it', async () => {
  const src = readFileSync(join(ROOT, 'scripts/tagged-deploy.mjs'), 'utf8');
  assert.ok(!/\(never echoed\)/.test(src), 'the header still says the tag is never echoed');
  const base = mkdtempSync(join(tmpdir(), 'td-sfx-'));
  try {
    const lines = [];
    await prepare('p384', args({ out: join(base, 'o') }), env(), fakeDeps({ art: realRef() }), (l) => lines.push(l));
    assert.ok(lines.some((l) => l === `suffix        ${attributionSuffix(TAG)}`));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
