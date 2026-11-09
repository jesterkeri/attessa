// Adversary probe (commit 7674bfd). Spec: the explorer's live check reads Celo Sepolia only, in all three launch states
// (no registry; registry, no seller; registry and seller), and every page a visitor can read must be true.
// 1. index.html: "Anyone can check a past call's payment from public Celo data." sits beside the form that posts a
//    hash to the explorer. Its "reads Celo Sepolia today" qualifier is notlive:mainnet, so once the deploy record has a
//    mainnet registry (and the footer offers mainnet) the page promises mainnet payments can be checked, and the
//    explorer answers "Not on this network yet". r11 gave explorer.html a live:mainnet replacement; index.html got none.
// 2. site.js: the message for a pasted non-hash says "It is the payment's transaction on Celoscan." on the default
//    network, Celo Sepolia, whose block explorer in networks.json (and explorer.js) is Blockscout.
// Run: node launch-wording-r12.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..');
const config = JSON.parse(readFileSync(join(site, 'site.config.json'), 'utf8'));
const FLAGS = ['seller', 'verify', 'viaBuy', 'releaseVerify', 'statusVerdicts', 'recentCalls'];
const A = n => `0x${String(n).repeat(40)}`;
const MAINNET_RECORD = { celo: { enclaveRegistry: A(1), validatorStack: { p384Verifier: A(2), certManager: A(3), nitroValidator: A(4) } } };

function build({ on, record }) {
  const dir = mkdtempSync(join(tmpdir(), 'site-wording-'));
  const cfg = join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({ ...config, live: Object.fromEntries(FLAGS.map(k => [k, on])) }));
  const out = join(dir, 'out');
  execFileSync('node', ['build.mjs'], { cwd: site, stdio: 'pipe', env: { ...process.env, SITE_CONFIG: cfg, SITE_OUT: out, ...(record ? { SITE_TEST_DEPLOYMENTS: JSON.stringify(record) } : {}) } });
  return out;
}
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const states = [
  ['no registry', () => build({ on: false })],
  ['registry, no seller', () => build({ on: false, record: MAINNET_RECORD })],
  ['registry and seller', () => build({ on: true, record: MAINNET_RECORD })],
];

for (const [name, mk] of states) {
  test(`${name}: the homepage's "check a past call's payment" line says the check reads Celo Sepolia only`, () => {
    const out = mk();
    const section = text(readFileSync(join(out, 'index.html'), 'utf8')).match(/Anyone can check a past call's payment from public Celo data\.[^?]*?Settlement transaction/)?.[0];
    assert.ok(section, 'precondition: the homepage has the explore line');
    assert.match(section, /Sepolia/, `index.html says "${section.slice(0, 120)}" with no word that the check reads Celo Sepolia only, but explorer.js reads only Sepolia`);
  });
}

test('the invalid-hash message does not send a Celo Sepolia reader to Celoscan', () => {
  const out = build({ on: false });
  const js = readFileSync(join(out, 'assets', 'site.js'), 'utf8');
  const cfgJs = readFileSync(join(out, 'assets', 'config.js'), 'utf8');
  const sepoliaExplorer = JSON.parse(cfgJs.match(/Object\.freeze\((.*)\);/)[1]).networks.sepolia.explorer.name;
  assert.equal(sepoliaExplorer, 'Blockscout', 'precondition: the default network\'s explorer');
  const said = js.match(/transaction on (\w+)\./)?.[1];
  assert.notEqual(said, 'Celoscan', `the message names ${said} for a Celo Sepolia transaction; the site's own config says ${sepoliaExplorer}`);
});
