// Attack tests for scripts/tagged-deploy.mjs (T30). Uses the real reference build (forge + solc 0.8.26).
// Drop into scripts/ of the T30 worktree (91b6942) and run:
//   flock /home/hr/.cache/attessa-heavy.lock node --test scripts/tagged-deploy.attack.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, check, createAddress, realDeps, PINNED } from './tagged-deploy.mjs';
import { attributionSuffix } from '../packages/core/src/attribution.ts';

const DEPLOYER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const ADMIN = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const TAG = 'celo_0123456789ab';
const real = realDeps('http://127.0.0.1:1');
const P = '0x' + '11'.repeat(20);
let ref;

before(() => {
  ref = real.loadReference(); // the real reference build, from HEAD's committed blobs
});

const zeroed = (art, code) => {
  let hex = code.replace(/^0x/, '');
  for (const refs of Object.values(art.deployedBytecode.immutableReferences ?? {})) {
    for (const { start, length } of refs) hex = hex.slice(0, start * 2) + '0'.repeat(length * 2) + hex.slice((start + length) * 2);
  }
  return real.keccak(hex);
};

test('sanity: the real reference build equals the whole-code pins', () => {
  for (const n of ['P384Verifier', 'CertManager', 'NitroValidator']) {
    assert.equal(zeroed(ref[n], ref[n].deployedBytecode.object), PINNED[n], n);
  }
});

function fakeDeps(over = {}) {
  return {
    rpc: async (method, params) => {
      if (method === 'eth_chainId') return '0xa4ec';
      if (method === 'eth_getCode') return over.code?.[params[0].toLowerCase()] ?? '0x';
      if (method === 'eth_estimateGas') return '0x' + (2_000_000).toString(16);
      if (method === 'eth_getTransactionCount') return '0x5';
      if (method === 'eth_getTransactionByHash') return over.tx;
      if (method === 'eth_getTransactionReceipt') return over.rc;
      throw new Error(`unexpected ${method}`);
    },
    gitStatus: () => '',
    loadReference: () => over.art ?? ref,
    keccak: real.keccak,
    tmp: () => over.tmp,
  };
}

// A build that is not the pinned build (different solc binary, forge default evm_version, ...) must not reach a
// printed command. The pins in DeployBase.sol exist for exactly that, but prepare() only applies them to
// contracts already on chain, never to the creation bytecode it is about to print.
test('prepare refuses a CertManager creation bytecode whose runtime differs from the whole-code pin', async () => {
  const flip = (hex, at) => hex.slice(0, at * 2) + (hex.slice(at * 2, at * 2 + 2) === 'ff' ? '00' : 'ff') + hex.slice(at * 2 + 2);
  const cm = structuredClone(ref.CertManager);
  const dep = cm.deployedBytecode.object.replace(/^0x/, '');
  const at = 100; // inside the code, not an immutable word, not metadata
  assert.ok(!Object.values(cm.deployedBytecode.immutableReferences).flat().some((r) => at >= r.start && at < r.start + r.length));
  const badDep = flip(dep, at);
  const bc = cm.bytecode.object.replace(/^0x/, '');
  const pos = bc.indexOf(dep.slice(0, 200));
  assert.ok(pos > 0, 'runtime is embedded in the creation bytecode');
  cm.deployedBytecode.object = '0x' + badDep;
  cm.bytecode.object = '0x' + bc.slice(0, pos) + badDep + bc.slice(pos + dep.length);
  const art = { ...ref, CertManager: cm };
  const out = mkdtempSync(join(tmpdir(), 'td-atk-'));
  try {
    const p384Code = ref.P384Verifier.deployedBytecode.object;
    const d = fakeDeps({ art, code: { [P]: p384Code } });
    const lines = [];
    let err = null;
    try {
      await prepare('certmanager', { positional: [], deployer: DEPLOYER, account: 'acct', rpcUrl: 'https://forno.celo.org', out, tx: null }, { LOOPS_ATTRIBUTION_TAG: TAG, ATTESSA_ADMIN: ADMIN, ATTESSA_P384_VERIFIER: P }, d, (l) => lines.push(l));
    } catch (e) {
      err = e;
    }
    assert.ok(err, `prepare printed a deploy command for a CertManager that is not the pinned build:\n${lines.filter((l) => l.startsWith('cast send') || l.startsWith('data length')).join('\n')}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// docs/DEPLOYMENTS.md: "with --tx the transaction is a creation from the deployer whose input ... equals the data file".
// check only compares the input when the data file happens to exist (default tmp dir, or --out passed again). With the
// file absent it silently skips, so a creation whose initcode is anything that ends in the suffix and leaves matching
// runtime code passes.
test('check --tx refuses a creation input that is not reference bytecode ++ args ++ suffix, even when the data file is gone', async () => {
  const suffix = attributionSuffix(TAG);
  const addr = createAddress(real, DEPLOYER, 7);
  const input = '0x6000600060006000' + 'ab'.repeat(40) + suffix.slice(2);
  const tx = { to: null, from: DEPLOYER, nonce: '0x7', input };
  const rc = { contractAddress: addr, status: '0x1' };
  const tmp = mkdtempSync(join(tmpdir(), 'td-atk-'));
  try {
    const d = fakeDeps({ art: ref, code: { [addr]: ref.P384Verifier.deployedBytecode.object }, tx, rc, tmp });
    const lines = [];
    let err = null;
    try {
      await check('p384', addr, { positional: [], deployer: DEPLOYER, account: null, rpcUrl: 'https://forno.celo.org', out: null, tx: '0x' + 'cd'.repeat(32) }, { LOOPS_ATTRIBUTION_TAG: TAG, ATTESSA_ADMIN: ADMIN }, d, (l) => lines.push(l));
    } catch (e) {
      err = e;
    }
    assert.ok(err, `check passed a creation whose input is not the reference initcode:\n${lines.join('\n')}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Positive controls and variants for the check --tx rebuild (T30 fix 2): a creation that IS reference
// bytecode ++ args ++ suffix passes with no data file anywhere; one changed byte, a wrong arg, a missing arg,
// or a wrong suffix position does not.
async function checkTx(step, input, { env: extraEnv = {}, values = {} } = {}) {
  const suffix = attributionSuffix(TAG);
  const art = ref[{ p384: 'P384Verifier', certmanager: 'CertManager' }[step]];
  const addr = createAddress(real, DEPLOYER, 7);
  const code = { [addr]: '0x' + art.deployedBytecode.object.replace(/^0x/, '') };
  if (step === 'certmanager') {
    // the deployed code has the p384 immutable spliced in
    const hex = art.deployedBytecode.object.replace(/^0x/, '');
    let h = hex;
    for (const refs of Object.values(art.deployedBytecode.immutableReferences)) for (const { start, length } of refs) h = h.slice(0, start * 2) + '0'.repeat(24) + P.slice(2) + h.slice((start + length) * 2);
    code[addr] = '0x' + h;
  }
  const tx = { to: null, from: DEPLOYER, nonce: '0x7', input };
  const rc = { contractAddress: addr, status: '0x1' };
  const d = fakeDeps({ art: ref, code, tx, rc, tmp: '/nonexistent/none' });
  const base = d.rpc;
  d.rpc = async (m, p) => {
    if (m === 'eth_call') {
      const sel = p[0].data;
      const w = (a) => '0x' + '0'.repeat(24) + a.slice(2);
      if (sel === '0x' + ref.CertManager.methodIdentifiers['p384Verifier()']) return w(P);
      if (sel === '0x' + ref.CertManager.methodIdentifiers['owner()'] || sel === '0x' + ref.CertManager.methodIdentifiers['revoker()']) return w(ADMIN);
    }
    return base(m, p);
  };
  const lines = [];
  await check(step, addr, { positional: [], deployer: DEPLOYER, account: null, rpcUrl: 'https://forno.celo.org', out: null, tx: '0x' + 'cd'.repeat(32) }, { LOOPS_ATTRIBUTION_TAG: TAG, ATTESSA_ADMIN: ADMIN, ATTESSA_P384_VERIFIER: P, ...extraEnv }, d, (l) => lines.push(l));
  return lines;
}
const word32 = (a) => '0'.repeat(24) + a.slice(2);

test('check --tx passes the exact reference bytecode ++ args ++ suffix with no data file (p384 and certmanager)', async () => {
  const sfx = attributionSuffix(TAG).slice(2);
  const lines = await checkTx('p384', ref.P384Verifier.bytecode.object + sfx);
  assert.ok(lines.some((l) => l.includes('creation input equals reference bytecode ++ constructor args ++ suffix')));
  await checkTx('certmanager', ref.CertManager.bytecode.object + word32(P) + word32(ADMIN) + word32(ADMIN) + sfx);
});

test('check --tx refuses one flipped byte in the initcode, a wrong or missing constructor arg, with the suffix intact', async () => {
  const sfx = attributionSuffix(TAG).slice(2);
  const bc = ref.CertManager.bytecode.object;
  const flipped = bc.slice(0, 40) + (bc[40] === '0' ? '1' : '0') + bc.slice(41);
  const good = word32(P) + word32(ADMIN) + word32(ADMIN);
  await assert.rejects(() => checkTx('certmanager', flipped + good + sfx), /first difference at byte/);
  await assert.rejects(() => checkTx('certmanager', bc + word32(P) + word32(P) + word32(ADMIN) + sfx), /first difference at byte/);
  await assert.rejects(() => checkTx('certmanager', bc + word32(P) + word32(ADMIN) + sfx), /not reference bytecode/);
  await assert.rejects(() => checkTx('p384', ref.P384Verifier.bytecode.object + '00' + sfx), /not reference bytecode/);
});
