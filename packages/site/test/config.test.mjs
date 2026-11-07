// T42: the network config. Every address the site renders comes from @attessa/core DEPLOYMENTS; the footer switch
// offers a network only when its registry is deployed; ?network= beats local storage; a [[slot: the deploy record
// has a value for fails the build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { DEPLOYMENTS } from '@attessa/core';
import { loadLive } from './lib/live.mjs';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(join(tmpdir(), 'attessa-site-config-'));
execFileSync(process.execPath, [join(pkg, 'build.mjs')], { cwd: pkg, stdio: 'pipe', env: { ...process.env, SITE_OUT: out } });
test.after(() => rmSync(out, { recursive: true, force: true }));

const walk = d => readdirSync(d).flatMap(n => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const loadConfig = () => {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(out, 'assets', 'config.js'), 'utf8'), sandbox);
  return JSON.parse(JSON.stringify(sandbox.window.ATTESSA_CONFIG));
};
const pickWith = (config, search, stored) => {
  const sandbox = { URLSearchParams };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(pkg, 'src', 'static', 'assets', 'network.js'), 'utf8'), sandbox);
  return sandbox.AttessaNetwork.pick(config, search, stored);
};

test('config: every network address and chain id equals DEPLOYMENTS', () => {
  const c = loadConfig();
  for (const [siteKey, coreKey] of [['sepolia', 'celo-sepolia'], ['mainnet', 'celo']]) {
    const d = DEPLOYMENTS[coreKey], n = c.networks[siteKey];
    assert.equal(n.chainId, d.chainId);
    assert.equal(n.contracts.enclaveRegistry, d.enclaveRegistry);
    assert.equal(n.contracts.identityRegistry, d.identityRegistry);
    assert.equal(n.contracts.selfRegistry, d.selfRegistry);
    for (const k of ['p384Verifier', 'certManager', 'nitroValidator']) assert.equal(n.contracts[k], d.validatorStack?.[k]);
    assert.deepEqual(n.tokens.map(t => [t.key, t.address]), Object.entries(d.assets).map(([k, a]) => [k, a.address]));
  }
});

test('config: every address any built page or script renders is one DEPLOYMENTS records', () => {
  const known = new Set();
  for (const d of Object.values(DEPLOYMENTS)) {
    for (const a of [d.enclaveRegistry, d.identityRegistry, d.selfRegistry, ...Object.values(d.validatorStack ?? {}), ...Object.values(d.assets).map(x => x.address)]) if (a) known.add(a.toLowerCase());
  }
  const files = walk(out).filter(f => /\.(html|js|css|txt)$/.test(f) && !/assets[\\/]scene\.js$|assets[\\/]motion\.js$/.test(f));
  let seen = 0;
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)) {
      seen++;
      assert.ok(known.has(m[0].toLowerCase()), `${f}: ${m[0]} is not in DEPLOYMENTS`);
    }
  }
  assert.ok(seen >= 10, `only ${seen} addresses found`);
});

test('config: explorer.js pins the same Sepolia network as the config', () => {
  const c = loadConfig().networks.sepolia, e = JSON.parse(JSON.stringify(loadLive().NETWORKS.sepolia));
  assert.equal(e.chainId, c.chainId);
  assert.equal(e.rpc, c.rpc);
  assert.equal(e.explorer.tx, c.explorer.tx);
  assert.deepEqual(e.tokens.map(t => [t.address, t.symbol, t.decimals]), c.tokens.map(t => [t.address, t.symbol, t.decimals]));
});

test('config: mainnet is disabled while enclaveRegistry is null, in the config and in the footer', () => {
  assert.equal(DEPLOYMENTS.celo.enclaveRegistry, null, 'this test describes the state before Gate 5');
  const c = loadConfig();
  assert.equal(c.networks.mainnet.enabled, false);
  assert.equal(c.networks.sepolia.enabled, true);
  const page = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(page, /<input type="radio" name="network" value="mainnet" disabled> Celo mainnet <span class="muted">After launch<\/span>/);
  assert.match(page, /<input type="radio" name="network" value="sepolia" checked>/);
});

test('config: ?network= wins over a stored network, and a disabled network is never picked', () => {
  const both = { networks: { sepolia: { enabled: true }, mainnet: { enabled: true } } };
  assert.equal(pickWith(both, '?network=sepolia', 'mainnet'), 'sepolia');
  assert.equal(pickWith(both, '?network=mainnet', null), 'mainnet');
  assert.equal(pickWith(both, '', 'mainnet'), 'mainnet');
  assert.equal(pickWith(both, '?network=nonsense', 'mainnet'), 'mainnet');
  const real = loadConfig();
  assert.equal(pickWith(real, '?network=mainnet', null), 'sepolia');
  assert.equal(pickWith(real, '', 'mainnet'), 'sepolia');
  assert.equal(pickWith(real, '?network=sepolia', 'mainnet'), 'sepolia');
  assert.equal(pickWith(real, '?network=__proto__', null), 'sepolia');
  assert.equal(pickWith(real, '', null), 'sepolia');
});

test('config: the build fails on a [[slot: whose value the deploy record has, and accepts [[chain:', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'attessa-site-slot-'));
  try {
    const src = join(tmp, 'src');
    cpSync(join(pkg, 'src'), src, { recursive: true });
    const page = join(src, 'pages', 'privacy.html');
    const base = readFileSync(page, 'utf8');
    const run = () => spawnSync(process.execPath, [join(pkg, 'build.mjs')], { cwd: pkg, encoding: 'utf8', env: { ...process.env, SITE_SRC: src, SITE_OUT: join(tmp, 'out') } });
    writeFileSync(page, `${base}\n<p>[[slot:enclaveRegistry]]</p>\n`);
    const bad = run();
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /enclaveRegistry.*deploy record has a value/s);
    writeFileSync(page, `${base}\n<p>[[chain:celo-sepolia.enclaveRegistry]]</p>\n`);
    assert.equal(run().status, 0);
    writeFileSync(page, `${base}\n<p>[[chain:celo.enclaveRegistry]]</p>\n`);
    const none = run();
    assert.notEqual(none.status, 0, 'a [[chain: with no deployed value fails the build');
    mkdirSync(join(tmp, 'x'), { recursive: true });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
