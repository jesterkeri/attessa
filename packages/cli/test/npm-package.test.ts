import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';

const here = new URL('..', import.meta.url).pathname;
const out = join(here, 'npm', 'out');
const pkg = () => JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
const cwd = mkdtempSync(join(tmpdir(), 'attessa-npm-'));
// Run a copy outside the repo, so no node_modules up the tree can hide a missing dependency.
const installed = join(cwd, 'pkg');
const run = (...args: string[]) => {
  const { ATTESSA_PRIVATE_KEY: _k, ...env } = process.env;
  return spawnSync('node', [join(installed, 'dist', 'attessa.mjs'), ...args], { encoding: 'utf8', cwd, env: { ...env, HOME: cwd }, timeout: 30_000 });
};

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

it('runs from the package alone, and prints no experimental warning', () => {
  const r = run('seller', '--help');
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('Sell an API');
  expect(r.stderr).not.toMatch(/Warning/);
});

it('a real warning from elsewhere still prints', () => {
  const entry = readFileSync(join(here, 'npm', 'attessa.mjs'), 'utf8');
  expect(entry).toContain("startsWith('SQLite is an experimental feature')");
  expect(entry).toContain('emit.call(process, warning, ...rest)');
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

it('the README claims nothing is live on mainnet', () => {
  const readme = readFileSync(join(out, 'README.md'), 'utf8');
  expect(readme).toContain('not live on Celo mainnet yet');
  expect(pkg().license).toBe('UNLICENSED');
});
