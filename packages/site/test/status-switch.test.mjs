// The launch switch: one list in site.config.json decides every "not live yet" label on the site.
// Off must keep every label. On must remove every one. And a flag can't be set true while its work isn't done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyStatus, readLive, FEATURES } from '../status.mjs';
import { config as siteNetworks } from '../config.mjs';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(site, '..', '..');
const config = JSON.parse(readFileSync(join(site, 'site.config.json'), 'utf8'));
const allOff = readLive({});
const everyFlag = Object.fromEntries(FEATURES.map(k => [k, true]));
const allOn = readLive({ live: everyFlag }, { mainnet: true });
const allButSeller = readLive({ live: { ...everyFlag, seller: false } });

// A stand-in deploy record for Celo mainnet, to build the state after Gate 5. Sepolia's real stack is a different record.
const A = n => `0x${String(n).repeat(40)}`;
const MAINNET_RECORD = { celo: { enclaveRegistry: A(1), validatorStack: { p384Verifier: A(2), certManager: A(3), nitroValidator: A(4) } } };

// Every file a visitor is served that can carry words: the pages and the scripts.
function build(live, record) {
  const dir = mkdtempSync(join(tmpdir(), 'site-switch-'));
  const cfg = join(dir, 'config.json');
  const { all: _all, mainnet: _mainnet, contractsOnly: _contractsOnly, ...flags } = live;
  writeFileSync(cfg, JSON.stringify({ ...config, live: flags }));
  const out = join(dir, 'out');
  execFileSync('node', ['build.mjs'], { cwd: site, env: { ...process.env, SITE_CONFIG: cfg, SITE_OUT: out, ...(record ? { SITE_TEST_DEPLOYMENTS: JSON.stringify(record) } : {}) }, stdio: 'pipe' });
  const pages = (d) => readdirSync(d, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? pages(join(d, e.name)) : /\.(html|js)$/.test(e.name) ? [join(d, e.name)] : []);
  return pages(out).map(f => ({ f: f.slice(out.length + 1), html: readFileSync(f, 'utf8') }));
}

test('a block is kept or dropped by its flag', () => {
  for (const s of ['<!--notlive:seller-->a<!--/notlive--><!--live:seller-->b<!--/live-->', '{{#notlive seller}}a{{/notlive}}{{#live seller}}b{{/live}}']) {
    assert.equal(applyStatus(s, allOff), 'a');
    assert.equal(applyStatus(s, allOn), 'b');
  }
});

test('a typo or a broken block stops the build instead of reaching a page', () => {
  assert.throws(() => applyStatus('<!--live:sellr-->x<!--/live-->', allOn), /unknown live feature/);
  assert.throws(() => applyStatus('{{#live sellr}}x{{/live}}', allOn), /unknown live feature/);
  assert.throws(() => applyStatus('<!--notlive:seller-->x', allOff), /unbalanced/);
  assert.throws(() => applyStatus('{{#notlive seller}}x', allOff), /unbalanced/);
  assert.throws(() => applyStatus('x<!--/live-->', allOff), /unbalanced/);
  assert.throws(() => applyStatus('<!--live:seller-->a<!--notlive:verify-->b<!--/notlive-->c<!--/live-->', allOn), /nested|unbalanced/);
  assert.throws(() => readLive({ live: { sellr: true } }), /not a known feature/);
  assert.throws(() => readLive({ live: { seller: 'yes' } }), /must be true or false/);
});

test('a feature missing from the list counts as not live, and `all` needs every feature', () => {
  assert.deepEqual(readLive({}), allOff);
  assert.equal(allOff.all, false);
  assert.equal(allOn.all, true);
  assert.equal(readLive({ live: { seller: true } }, { mainnet: true }).all, false);
});

test('with everything off, every label a visitor relies on is on the page', () => {
  const pages = build(allOff);
  const all = pages.map(p => p.html).join('\n');
  assert.match(all, /No public seller is live yet/);
  assert.match(all, /<span class="muted">Coming/);
  assert.match(all, /Optional, not built yet/);
  assert.doesNotMatch(all, /\{\{[#/](live|notlive)|<!--\/?(live|notlive)/);
});

const NOT_LIVE = /No public seller|isn't built yet|not built yet|<span class="muted">Coming|Coming:|mainnet comes after launch|After launch|Tutorial preview|class="muted">Preview|once a public seller|which is coming|\(coming\)|not live on Celo mainnet|fill in once deployed|only network Attessa is deployed|\{\{[#/](?:live|notlive)|<!--\/?(?:live|notlive)/g;
const labels = files => files.flatMap(({ f, html }) => [...html.matchAll(NOT_LIVE)].map(m => `${f}: ${m[0]}`));

test('with every feature on and mainnet deployed, no not-live label survives in any page or script', () => {
  assert.deepEqual(labels(build(allOn, MAINNET_RECORD)), []);
});

test('a mainnet deployment shows the addresses and opens the switch', () => {
  const files = build(allOff, MAINNET_RECORD);
  const security = files.find(p => p.f === 'security.html').html;
  for (const n of [1, 2, 3, 4]) assert.ok(security.includes(A(n)), `mainnet address ${A(n)} is missing`);
  assert.doesNotMatch(security, /After launch/);
  assert.match(files.find(p => p.f === 'index.html').html, /<label><input type="radio" name="network" value="mainnet"> Celo mainnet<\/label>/);
  assert.doesNotMatch(files.find(p => p.f === 'assets/explorer.js').html, /comes after launch/);
  assert.match(files.find(p => p.f === 'assets/explorer.js').html, /The live check reads Celo Sepolia only\./);
  // The deployment says nothing about the seller.
  assert.match(files.find(p => p.f === 'index.html').html, /No public seller is live yet/);
});

test('the seller flag is refused without a mainnet registry, so a flag alone can never claim mainnet', () => {
  assert.throws(() => readLive({ live: { seller: true } }), /needs a Celo mainnet registry/);
  assert.throws(() => build({ seller: true }), /needs a Celo mainnet registry/);
});

test('no other flag stands in for a mainnet deployment: every one on and no registry keeps the mainnet labels', () => {
  const files = build(allButSeller);
  const of = name => files.find(p => p.f === name).html;
  assert.match(of('security.html'), /<td class="muted">After launch<\/td>/);
  assert.match(of('security.html'), /fill in once deployed/);
  assert.match(of('explorer.html'), /Celo mainnet comes after launch/);
  assert.match(of('index.html'), /value="mainnet" disabled> Celo mainnet <span class="muted">After launch/);
  assert.match(of('assets/explorer.js'), /Celo mainnet comes after launch/);
});

test('the deploy record, not the list, decides mainnet', () => {
  assert.throws(() => readLive({ live: { mainnet: true } }), /not a known feature/);
  assert.equal(readLive({}).mainnet, false);
  assert.equal(readLive({}, { mainnet: true }).mainnet, true);
  assert.equal(allButSeller.mainnet, false);
  assert.equal(allOn.all, true, '`all` is the features only');
});

test('the explorer scripts follow viaBuy, and nothing else moves them', () => {
  const site = flags => build(readLive({ live: flags }, { mainnet: true }), MAINNET_RECORD).find(p => p.f === 'assets/site.js').html;
  const off = site({});
  assert.match(off, /Once buying through buy is built/);
  assert.match(off, /Optional, not built yet:/);
  const on = site({ viaBuy: true });
  assert.doesNotMatch(on, /not built yet|Once buying through buy is built/);
  assert.match(on, /When a call is bought through buy/);
  assert.match(on, /A sample of what the buyer's SDK shows for a purchase through buy/);
  const others = site(Object.fromEntries(FEATURES.filter(k => k !== 'viaBuy').map(k => [k, true])));
  assert.match(others, /Optional, not built yet:/);
});

// Every block in the source, read back against a build with only its own flag on.
const blocksIn = d => readdirSync(d, { withFileTypes: true }).flatMap(e => {
  if (e.isDirectory()) return blocksIn(join(d, e.name));
  if (!/\.(html|js)$/.test(e.name)) return [];
  return [...readFileSync(join(d, e.name), 'utf8').matchAll(/<!--(live|notlive):(\w+)-->([\s\S]*?)<!--\/\1-->|\{\{#(live|notlive) (\w+)\}\}([\s\S]*?)\{\{\/\4\}\}/g)]
    .map(m => ({ file: e.name, kind: m[1] ?? m[4], key: m[2] ?? m[5], body: m[3] ?? m[6] }));
});

test('each feature flag alone changes exactly its own blocks, in pages and scripts', () => {
  const blocks = blocksIn(join(site, 'src')).filter(b => !/\{\{|\[\[/.test(b.body) && !['all', 'mainnet', 'contractsOnly'].includes(b.key));
  for (const key of [...FEATURES]) {
    const text = build(readLive({ live: { [key]: true } }, { mainnet: key === 'seller' }), key === 'seller' ? MAINNET_RECORD : undefined).map(p => p.html).join('\n');
    for (const b of blocks) {
      const on = b.key === key;
      const expected = (b.kind === 'live') === on;
      if (expected) assert.ok(text.includes(b.body), `${key} on: ${b.file} ${b.kind}:${b.key} should be shown: ${b.body.slice(0, 70)}`);
      // Absence is asserted only for a wording long enough to be its own (" preview" occurs in ordinary copy) that no
      // block with another answer also holds ("Coming." also opens a statusVerdicts line).
      else if (b.body.length >= 25 && blocks.every(o => !o.body.includes(b.body) || (o.key === b.key && o.kind === b.kind))) {
        assert.ok(!text.includes(b.body), `${key} on: ${b.file} ${b.kind}:${b.key} should be gone: ${b.body.slice(0, 70)}`);
      }
    }
  }
});

// What must be true before a flag may be set. A ticked TASKS.md task, or the command existing in the CLI where no
// task exists for it. TASKS.md is ticked only with real output in DONE.md, so this ties a flip to the real work.
const NEEDS = {
  seller: { tasks: ['T32', 'T37'] }, // real paid calls on mainnet, and the Sepolia seller the tutorial uses
  verify: { tasks: ['T21a'] },
  viaBuy: { tasks: ['T29'] },
  releaseVerify: { cli: /release verify/ },
  statusVerdicts: { cli: /Recent verdicts/i },
  recentCalls: { tasks: ['T45'] },
};

test('every feature says what must be true before it can be flipped', () => {
  assert.deepEqual(Object.keys(NEEDS).sort(), [...FEATURES].sort());
});

test('no flag is on while its work is unfinished', () => {
  const tasks = readFileSync(join(repo, 'TASKS.md'), 'utf8');
  const cliDir = join(repo, 'packages', 'cli', 'src');
  const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
  const cli = walk(cliDir).map(f => readFileSync(f, 'utf8')).join('\n');
  const live = readLive(config, { mainnet: siteNetworks.networks.mainnet.enabled });
  const bad = [];
  for (const [k, need] of Object.entries(NEEDS)) {
    if (!live[k]) continue;
    for (const t of need.tasks ?? []) {
      if (!new RegExp(`^- \\[x\\] ${t} `, 'm').test(tasks)) bad.push(`${k} is live but ${t} is not ticked in TASKS.md`);
    }
    if (need.cli && !need.cli.test(cli)) bad.push(`${k} is live but the CLI has no such command`);
  }
  assert.deepEqual(bad, []);
});

test('in every state the tutorial says the working payment check works', () => {
  for (const [flags, record] of [[allOff], [allOn, MAINNET_RECORD]]) {
    const page = build(flags, record).find(p => p.f.endsWith('tutorial.html')).html;
    assert.doesNotMatch(page, /explorer<\/a> is live/);
    assert.match(page, /into the <a href="\.\.\/explorer\.html">proof explorer<\/a> to check its payment/);
  }
});
