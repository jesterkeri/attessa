// Adversary probe (commit 3474dbd). Registry on Celo mainnet but no seller: docs/reference.html must not say
// "--network sepolia is the only network Attessa is deployed on today" (its block is notlive:seller, not notlive:mainnet).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(site, 'site.config.json'), 'utf8'));
const A = n => `0x${String(n).repeat(40)}`;
const MAINNET_RECORD = { celo: { enclaveRegistry: A(1), validatorStack: { p384Verifier: A(2), certManager: A(3), nitroValidator: A(4) } } };

test('registry but no seller: no page says Sepolia is the only network Attessa is deployed on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'site-ref-'));
  const cfg = join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({ ...config, live: Object.fromEntries(['seller', 'verify', 'viaBuy', 'releaseVerify', 'statusVerdicts', 'recentCalls'].map(k => [k, false])) }));
  const out = join(dir, 'out');
  execFileSync('node', ['--import', './test/lib/test-record.mjs', 'build.mjs'], { cwd: site, stdio: 'pipe', env: { ...process.env, SITE_CONFIG: cfg, SITE_OUT: out, SITE_TEST_DEPLOYMENTS: JSON.stringify(MAINNET_RECORD) } });
  const html = readFileSync(join(out, 'docs', 'reference.html'), 'utf8').replace(/<[^>]*>/g, '');
  assert.doesNotMatch(html, /is the only network Attessa is deployed on/);
});
