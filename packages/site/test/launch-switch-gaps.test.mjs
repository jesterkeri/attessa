// Adversary probes of the launch switch (commit 8f6b915). Spec: packages/site/site.config.json `live` flags are
// feature flags only; anything about Celo mainnet being deployed follows the deploy record (packages/core/src/deployments.ts
// `celo.enclaveRegistry`), never a flag; every script a visitor runs says the same as the pages; an unknown status
// block stops the build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, symlinkSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, cpSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const { applyStatus, readLive, FEATURES } = await import(join(site, 'status.mjs'));
const config = JSON.parse(readFileSync(join(site, 'site.config.json'), 'utf8'));
const A = n => `0x${String(n).repeat(40)}`;
const MAINNET_RECORD = { celo: { enclaveRegistry: A(1), validatorStack: { p384Verifier: A(2), certManager: A(3), nitroValidator: A(4) } } };

function build({ on, record, src, except = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'site-gap-'));
  const cfg = join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({ ...config, live: Object.fromEntries(FEATURES.map(k => [k, on && !except.includes(k)])) }));
  const out = join(dir, 'out');
  execFileSync('node', ['--import', './test/lib/test-record.mjs', 'build.mjs'], {
    cwd: site, stdio: 'pipe',
    env: { ...process.env, SITE_CONFIG: cfg, SITE_OUT: out, ...(src ? { SITE_SRC: src } : {}), ...(record ? { SITE_TEST_DEPLOYMENTS: JSON.stringify(record) } : {}) },
  });
  const files = d => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]);
  return Object.fromEntries(files(out).map(f => [f.slice(out.length + 1), readFileSync(f, 'utf8')]));
}

test('no mainnet deploy record: every flag but seller claims no mainnet, and seller stops the build', () => {
  const p = build({ on: true, except: ['seller'] });
  assert.doesNotMatch(p['terms.html'], /Attessa runs on Celo mainnet/, 'terms.html claims mainnet from a flag');
  assert.doesNotMatch(p['index.html'], /USA&#x20AE; on Celo mainnet\./, 'index.html claims mainnet settlement from a flag');
  assert.throws(() => build({ on: true }), /needs a Celo mainnet registry/);
});

test('a mainnet deploy record with every feature flag off: no page says mainnet is not live or that Sepolia is the only network', () => {
  const p = build({ on: false, record: MAINNET_RECORD });
  assert.doesNotMatch(p['terms.html'], /not live on Celo mainnet/, 'terms.html says mainnet is not live although the record has a registry');
  assert.doesNotMatch(p['index.html'], /on mainnet after launch/, 'index.html says mainnet comes after launch although the record has a registry');
  assert.doesNotMatch(p['privacy.html'], /Celo Sepolia is the only network you can pick/, 'privacy.html says Sepolia is the only network while the footer offers mainnet');
  // Contracts on mainnet are not a live seller: the pages keep saying so.
  assert.match(p['terms.html'], /no public seller is live there, and nothing on this site moves real money/);
  assert.match(p['index.html'], /No public seller is live yet/);
});

test('privacy.html still says Sepolia is the only network while no registry is deployed', () => {
  assert.match(build({ on: true, except: ['seller'] })['privacy.html'], /Celo Sepolia is the only network you can pick/);
});

test('a status block in a script outside the top level of assets, or in a bundled script, is resolved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'site-gap-src-'));
  const src = join(dir, 'src');
  cpSync(join(site, 'src'), src, { recursive: true });
  const line = "var gap = '{{#notlive seller}}GAP-NOT-LIVE{{/notlive}}';\n";
  mkdirSync(join(src, 'static', 'assets', 'vendor'), { recursive: true });
  writeFileSync(join(src, 'static', 'assets', 'vendor', 'x.js'), line);
  writeFileSync(join(src, 'static', 'assets', 'y.mjs'), line);
  writeFileSync(join(src, 'static', 'z.js'), line);
  appendFileSync(join(src, 'static', 'assets', 'motion.js'), `\nwindow.__gap = '{{#notlive seller}}GAP-NOT-LIVE{{/notlive}}';\n`);
  const p = build({ on: true, record: MAINNET_RECORD, src });
  const leaked = Object.entries(p).filter(([, t]) => /GAP-NOT-LIVE|\{\{[#/](?:not)?live/.test(t)).map(([f]) => f);
  assert.deepEqual(leaked, []);
});

test('a block named for an inherited object property is an unknown feature, not a silent drop', () => {
  const off = readLive({});
  for (const k of ['constructor', 'toString', 'hasOwnProperty']) {
    assert.throws(() => applyStatus(`<!--live:${k}-->x<!--/live-->`, off), /unknown live feature/, k);
  }
});

test('the test deploy record is no input to a build: with or without an output directory the build refuses it', () => {
  const { SITE_OUT: _unset, ...env } = process.env;
  const dir = mkdtempSync(join(tmpdir(), 'site-no-record-'));
  const out = join(dir, 'out');
  const record = JSON.stringify(MAINNET_RECORD);
  for (const e of [{ ...env, SITE_TEST_DEPLOYMENTS: record }, { ...env, SITE_TEST_DEPLOYMENTS: record, SITE_OUT: out }]) {
    assert.throws(() => execFileSync('node', ['build.mjs'], { cwd: site, stdio: 'pipe', env: e }), /not a build input/);
  }
  assert.equal(existsSync(out), false, 'nothing was written');
  assert.doesNotMatch(readFileSync(join(site, 'config.mjs'), 'utf8'), /SITE_TEST_DEPLOYMENTS|process\.env/);
});

test('the test hook cannot reach a build through NODE_OPTIONS, nor write outside the temp directory (adversary r14)', () => {
  const record = JSON.stringify(MAINNET_RECORD);
  const out = mkdtempSync(join(tmpdir(), 'site-no-hook-'));
  const hook = join(site, 'test', 'lib', 'test-record.mjs');
  const { NODE_OPTIONS: _n, SITE_OUT: _o, ...env } = process.env;
  assert.throws(() => execFileSync('node', ['build.mjs'], { cwd: site, stdio: 'pipe', env: { ...env, SITE_OUT: out, NODE_OPTIONS: `--import ${hook}`, SITE_TEST_DEPLOYMENTS: record } }), /must be named on the node command line/);
  assert.equal(existsSync(join(out, 'security.html')), false);
  for (const e of [{ ...env, SITE_TEST_DEPLOYMENTS: record }, { ...env, SITE_OUT: join(site, 'dist'), SITE_TEST_DEPLOYMENTS: record }]) {
    assert.throws(() => execFileSync('node', ['--import', './test/lib/test-record.mjs', 'build.mjs'], { cwd: site, stdio: 'pipe', env: e }), /only into the temp directory/);
  }
});

test('the test hook refuses every way of pointing it at the real output (adversary r15)', () => {
  const record = JSON.stringify(MAINNET_RECORD);
  const { NODE_OPTIONS: _n, SITE_OUT: _o, TMPDIR: _t, ...env } = process.env;
  const dir = mkdtempSync(join(tmpdir(), 'site-hook-'));
  const hook = join(site, 'test', 'lib', 'test-record.mjs');
  const build = join(site, 'build.mjs');
  const refused = (cwd, e) => assert.throws(() => execFileSync('node', ['--import', hook, build], { cwd, stdio: 'pipe', env: { ...env, SITE_TEST_DEPLOYMENTS: record, ...e } }), /only into the temp directory/);
  refused(dir, {}); // no SITE_OUT: the build writes dist whatever the cwd
  refused(site, { TMPDIR: site, SITE_OUT: join(site, 'dist') });
  symlinkSync(join(site, 'dist'), join(dir, 'link'));
  refused(dir, { SITE_OUT: join(dir, 'link') });
  refused(dir, { SITE_OUT: join(dir, 'link', 'deeper') });
});

test('a spaced status comment stops the build', () => {
  assert.throws(() => applyStatus('<!--  live:seller-->x<!--/live-->', readLive({})), /unbalanced/);
});
