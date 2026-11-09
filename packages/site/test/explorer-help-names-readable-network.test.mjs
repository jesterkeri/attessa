// Adversary probe (commit 3474dbd). With a Celo mainnet registry in the deploy record the footer offers a Celo mainnet
// radio, and site.js writes that network's label into every [data-network-name]. The explorer's help line is such a
// slot, so after the visitor picks mainnet it reads "It checks the payment on Celo mainnet." although explorer.js
// can only read Celo Sepolia (its check answers "Not on this network yet"). Every page a visitor can read must be true.
// Drop into packages/site/test/ to run in the repo; here SITE points at the checkout under test.
// Run: node explorer-help-names-readable-network.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(site, 'site.config.json'), 'utf8'));
const A = n => `0x${String(n).repeat(40)}`;
const MAINNET_RECORD = { celo: { enclaveRegistry: A(1), validatorStack: { p384Verifier: A(2), certManager: A(3), nitroValidator: A(4) } } };

test('registry but no seller: the explorer never names an offered network as readable unless explorer.js reads it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'site-help-'));
  const cfg = join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({ ...config, live: Object.fromEntries(['seller', 'verify', 'viaBuy', 'releaseVerify', 'statusVerdicts', 'recentCalls'].map(k => [k, false])) }));
  const out = join(dir, 'out');
  execFileSync('node', ['--import', './test/lib/test-record.mjs', 'build.mjs'], { cwd: site, stdio: 'pipe', env: { ...process.env, SITE_CONFIG: cfg, SITE_OUT: out, SITE_TEST_DEPLOYMENTS: JSON.stringify(MAINNET_RECORD) } });

  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(out, 'assets', 'config.js'), 'utf8'), sandbox);
  const offered = Object.entries(sandbox.window.ATTESSA_CONFIG.networks).filter(([, n]) => n.enabled).map(([key, n]) => ({ key, label: n.label }));
  assert.ok(offered.some(n => n.key === 'mainnet'), 'precondition: the footer offers mainnet');

  const explorer = { AbortController, setTimeout, clearTimeout, console };
  vm.createContext(explorer);
  vm.runInContext(readFileSync(join(out, 'assets', 'explorer.js'), 'utf8'), explorer);
  const readable = Object.keys(explorer.AttessaLive.NETWORKS);

  const html = readFileSync(join(out, 'explorer.html'), 'utf8');
  const help = html.match(/<p class="field-help" id="q-help">([\s\S]*?)<\/p>/)[1];
  for (const n of offered) {
    // What the visitor reads after picking this network in the footer: site.js sets each slot's text to the label.
    const shown = help.replace(/<span data-network-name>[^<]*<\/span>/g, n.label).replace(/<[^>]*>/g, '');
    if (new RegExp(`checks the payment on ${n.label}`).test(shown)) {
      assert.ok(readable.includes(n.key), `after picking ${n.label} the explorer help says: "${shown.trim()}" but explorer.js reads only ${readable.join(', ')}`);
    }
  }
});
