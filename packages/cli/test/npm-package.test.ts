import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey } from 'viem/accounts';
import { beforeAll, expect, it } from 'vitest';

const here = new URL('..', import.meta.url).pathname;
const out = join(here, 'npm', 'out');
const pkg = () => JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
const cwd = mkdtempSync(join(tmpdir(), 'attessa-npm-'));
// Run a copy outside the repo, so no node_modules up the tree can hide a missing dependency.
const installed = join(cwd, 'pkg');
// A setting on the build machine that changes how Node treats warnings must not change what these tests see.
const { ATTESSA_PRIVATE_KEY: _key, NODE_NO_WARNINGS: _nnw, NODE_OPTIONS: _no, ...cleanEnv } = process.env;
const run = (...args: string[]) => spawnSync('node', [join(installed, 'dist', 'attessa.mjs'), ...args], { encoding: 'utf8', cwd, env: { ...cleanEnv, HOME: cwd }, timeout: 30_000 });

beforeAll(() => {
  execFileSync('node', [join(here, 'npm', 'build.mjs')], { stdio: 'pipe' });
  cpSync(out, installed, { recursive: true });
}, 60_000);

it('is the public package named attessa, with both commands and no runtime dependencies', () => {
  const p = pkg();
  expect(p.name).toBe('attessa');
  expect(p.private).toBeUndefined();
  expect(p.bin).toEqual({ attessa: 'dist/attessa.mjs', attest: 'dist/attessa.mjs' });
  expect(p.dependencies).toBeUndefined();
  for (const f of ['dist/attessa.mjs', 'dist/bin.mjs', 'vendor/p384_hints.cjs', 'vendor/LICENSE.nitro-validator', 'README.md']) expect(existsSync(join(out, f)), f).toBe(true);
});

it('the bundle needs nothing outside itself', () => {
  const bundle = readFileSync(join(out, 'dist', 'bin.mjs'), 'utf8');
  const imports = [...bundle.matchAll(/^import\s[^;\n]*from\s+["']([^"']+)["']/gm), ...bundle.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!);
  expect(imports.length).toBeGreaterThan(0);
  expect(imports.filter((i) => !i.startsWith('node:'))).toEqual([]);
  expect(bundle).not.toMatch(/\/home\/|-----BEGIN [A-Z ]*PRIVATE KEY-----/);
});

it('runs from the package alone', () => {
  const r = run('seller', '--help');
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('Sell an API');
});

it('a command that opens the ledger prints no SQLite warning, and only because of the filter', () => {
  const key = generatePrivateKey(); // made here for this run; holds nothing
  const args = [join(installed, 'dist', 'attessa.mjs'), 'status', '--rpc', 'http://127.0.0.1:1'];
  const opts = { encoding: 'utf8' as const, cwd, env: { ...cleanEnv, HOME: cwd, ATTESSA_PRIVATE_KEY: key }, timeout: 30_000 };
  expect(spawnSync('node', args, opts).stderr).not.toMatch(/ExperimentalWarning/);
  // The same bundle without the entry point's filter does warn, so the line above can fail.
  args[0] = join(installed, 'dist', 'bin.mjs');
  expect(spawnSync('node', args, opts).stderr).toMatch(/ExperimentalWarning: SQLite/);
});

it('the filter drops only that one warning', () => {
  const dir = join(cwd, 'filter');
  mkdirSync(dir);
  cpSync(join(here, 'npm', 'attessa.mjs'), join(dir, 'attessa.mjs'));
  writeFileSync(join(dir, 'bin.mjs'), [
    "process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');",
    "process.emitWarning('something else went wrong');",
    "process.emitWarning('SQLite is an experimental feature: the database is corrupt', 'ExperimentalWarning');",
    "process.emitWarning('SQLite is an experimental feature and might change at any time', 'SomeOtherWarning');",
  ].join('\n'));
  const r = spawnSync('node', [join(dir, 'attessa.mjs')], { encoding: 'utf8', env: cleanEnv });
  expect(r.stderr).toContain('something else went wrong');
  expect(r.stderr).toContain('the database is corrupt'); // same opening words, a different warning
  expect(r.stderr).toContain('SomeOtherWarning: SQLite'); // same words, a different type
  expect(r.stderr).not.toContain('ExperimentalWarning: SQLite is an experimental feature and might change');
});

it('mainnet says there is no registry yet, rather than pretending', () => {
  const r = run('status', '--agent', '10061', '--network', 'mainnet');
  expect(r.status).not.toBe(0);
  expect(r.stdout + r.stderr).toContain('No EnclaveRegistry address is known for mainnet');
});

it('the parts left out say so and exit non-zero', () => {
  const r = run('gateway');
  expect(r.status).toBe(2);
  expect(r.stdout + r.stderr).toContain('not in the npm package');
});

it('the parts left out keep to one JSON object on stdout under --json', () => {
  const r = run('gateway', 'status', '--json');
  expect(r.status).toBe(2);
  expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: 'usage' });
  expect(r.stderr).toBe('');
});

// This and the mainnet test above fail on purpose once a mainnet registry is recorded: the README has to change that day.
it('the README claims nothing is live on mainnet', () => {
  const readme = readFileSync(join(out, 'README.md'), 'utf8');
  expect(readme).toContain('not live on Celo mainnet yet');
  expect(pkg().license).toBe('UNLICENSED');
});
