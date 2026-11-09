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
const allOn = readLive({ live: Object.fromEntries(FEATURES.map(k => [k, true])) });

function build(live) {
  const dir = mkdtempSync(join(tmpdir(), 'site-switch-'));
  const cfg = join(dir, 'config.json');
  const { all: _derived, ...flags } = live;
  writeFileSync(cfg, JSON.stringify({ ...config, live: flags }));
  const out = join(dir, 'out');
  execFileSync('node', ['build.mjs'], { cwd: site, env: { ...process.env, SITE_CONFIG: cfg, SITE_OUT: out }, stdio: 'pipe' });
  const pages = (d) => readdirSync(d, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? pages(join(d, e.name)) : e.name.endsWith('.html') ? [join(d, e.name)] : []);
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
  assert.equal(readLive({ live: { seller: true } }).all, false);
});

test('with everything off, every label a visitor relies on is on the page', () => {
  const pages = build(allOff);
  const all = pages.map(p => p.html).join('\n');
  assert.match(all, /No public seller is live yet/);
  assert.match(all, /<span class="muted">Coming/);
  assert.match(all, /Optional, not built yet/);
  assert.doesNotMatch(all, /\{\{[#/](live|notlive)|<!--\/?(live|notlive)/);
});

test('with everything on, no not-live label survives on any page, in any meta tag or nav', () => {
  const left = build(allOn).flatMap(({ f, html }) =>
    [...html.matchAll(/No public seller|isn't built yet|not built yet|<span class="muted">Coming|Coming:|mainnet comes after launch|Tutorial preview|class="muted">Preview|once a public seller|which is coming|\(coming\)|not live on Celo mainnet|fill in once deployed|only network Attessa is deployed|\{\{[#/](?:live|notlive)|<!--\/?(?:live|notlive)/g)]
      .map(m => `${f}: ${m[0]}`));
  assert.deepEqual(left, []);
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
  const live = readLive(config);
  const bad = [];
  for (const [k, need] of Object.entries(NEEDS)) {
    if (!live[k]) continue;
    for (const t of need.tasks ?? []) {
      if (!new RegExp(`^- \\[x\\] ${t} `, 'm').test(tasks)) bad.push(`${k} is live but ${t} is not ticked in TASKS.md`);
    }
    if (need.cli && !need.cli.test(cli)) bad.push(`${k} is live but the CLI has no such command`);
  }
  // The footer's network switch follows the deploy record, not this list: "After launch" goes only when mainnet is deployed.
  if (live.seller && !siteNetworks.networks.mainnet.enabled) bad.push('seller is live but the deploy record has no mainnet registry');
  assert.deepEqual(bad, []);
});

test('in every state the tutorial says the working payment check works', () => {
  for (const flags of [allOff, allOn]) {
    const page = build(flags).find(p => p.f.endsWith('tutorial.html')).html;
    assert.doesNotMatch(page, /explorer<\/a> is live/);
    assert.match(page, /into the <a href="\.\.\/explorer\.html">proof explorer<\/a> to check its payment/);
  }
});
