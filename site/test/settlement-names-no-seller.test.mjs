// Adversary round 15 on the site (5ff468a..807708a, newest fix 0271566..807708a).
// Intended home: site/test/settlement-names-no-seller.test.mjs
// Run from the repo root: node --test site/test/settlement-names-no-seller.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// 807708a stops the explorer's settled sample from naming an endpoint, build or signer for a settlement:
// those two rows are now "Planned", because a settlement names only a pay-to address and many endpoints
// can share one (SPEC §3.2 keys endpoints by originHash only; §3.4 addEndpoint puts no uniqueness on
// payTo; KNOWN-LIMITS L17: anyone can add an endpoint with any payTo). Two places still claim it as
// available now:
//
// - index.html, the "Check any settlement" section: "Anyone can check a past call's payment, and the
//   seller's approved builds and signers, from public Celo data." Only the rest is marked Planned. A past
//   call's payment doesn't tell which seller was paid, so "the seller's approved builds and signers" for
//   that call can't be read from Celo.
// - explorer.html, "The five checks it runs": Approved build (registry) and Sealed machine (AWS
//   attestation) carry no "planned", while checks 3 and 4 do; the settled checklist in site.js now marks
//   1 and 2 Planned too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const home = readFileSync(join(src, 'pages', 'index.html'), 'utf8');
const explorer = readFileSync(join(src, 'pages', 'explorer.html'), 'utf8');
const js = readFileSync(join(src, 'static', 'assets', 'site.js'), 'utf8');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ').replace(/\s+/g, ' ').trim();

test('the home page settlement check claims no seller builds or signers before "Planned"', () => {
  const sec = home.match(/<h2 id="explore"[\s\S]*?<\/form>/)?.[0] ?? '';
  const lede = text(sec.match(/<p class="sec-lede"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '');
  assert.match(lede, /past call/, 'precondition: the home "Check any settlement" lede moved; re-point this test');
  const now = lede.split(/\bPlanned:/)[0];
  const m = now.match(/[^.]*\b(approved builds?|signers?|seller's)\b[^.]*\./i);
  assert.equal(m, null,
    `presented as available now: "${m?.[0].trim()}". A settlement names only a pay-to address, and SPEC §3.2/§3.4 and L17 let many endpoints, a stranger's included, share one; the explorer's own settled sample (site.js buildChain, machineChain) marks build and signer Planned`);
});

// how-it-works.html and how-to.html: "attessa agent register isn't built yet; the other five commands are."
// The other five are the seller commands each page walks through: enclave build, release approve, endpoint
// add, enclave start, signer register. TASKS.md T15 (the CLI for exactly these) is unchecked, and
// packages/cli/src/index.ts at 807708a is `export {};`, with no command at all.
test('no page says the seller commands are built while TASKS.md T15 is open', () => {
  const repo = join(src, '..', '..');
  const tasks = readFileSync(join(repo, 'TASKS.md'), 'utf8');
  const t15 = tasks.match(/^- \[( |x)\] T15 [^\n]*/m);
  assert.ok(t15 && /enclave build\|start`, `release approve`, `endpoint add`, `signer register/.test(t15[0]), 'precondition: TASKS.md T15 moved; re-point this test');
  const claimsBuilt = /the other five commands are\b(?! not| coming)/i;
  const bad = ['how-it-works.html', 'docs/how-to.html']
    .filter(p => claimsBuilt.test(text(readFileSync(join(src, 'pages', p), 'utf8'))));
  if (t15[1] === ' ') {
    assert.deepEqual(bad, [],
      `${bad.join(', ')} say the seller commands are built, but TASKS.md T15 ("CLI enclave build|start, release approve, endpoint add, signer register") is open and packages/cli/src/index.ts is ${JSON.stringify(readFileSync(join(repo, 'packages', 'cli', 'src', 'index.ts'), 'utf8').trim())}`);
  }
});

test('every check the explorer index says it runs is marked planned when the settled sample plans it', () => {
  const idx = explorer.match(/<div class="page-index"[\s\S]*?<\/ol>/)?.[0] ?? '';
  const items = [...idx.matchAll(/<li>([\s\S]*?)<span>([\s\S]*?)<\/span><\/li>/g)].map(m => ({ name: text(m[1]), tag: text(m[2]) }));
  const settled = js.match(/settled:\s*\{[\s\S]*?rows:\s*\[([\s\S]*?)\{\s*s:/)?.[1] ?? '';
  const ids = settled.split(',').map(s => s.trim()).filter(Boolean);
  assert.equal(items.length, 5, 'precondition: the explorer index no longer lists five checks');
  assert.ok(ids.length >= 4, 'precondition: the settled rows moved; re-point this test');
  const bad = [];
  ids.forEach((id, i) => {
    const w = js.match(new RegExp(`const ${id} = \\{[^\\n]*?\\bw: '([^']*)'`))?.[1];
    if (w === 'Planned' && !/planned/i.test(items[i].tag)) bad.push(`${i + 1}. ${items[i].name} (${items[i].tag}) is listed as run, but the settled sample row "${id}" is Planned`);
  });
  assert.deepEqual(bad, [], 'explorer.html "The five checks it runs" must match what a settlement check runs');
});
