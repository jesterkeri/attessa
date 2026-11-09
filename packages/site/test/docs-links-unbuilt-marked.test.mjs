// Adversary round 26 on the site fixes (truth pass 5ff468a..80529e1).
// Intended home: packages/site/test/docs-links-unbuilt-marked.test.mjs
// Run from the repo root: node --test packages/site/test/docs-links-unbuilt-marked.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// TASKS.md: T21 (CLI: `attessa init`, `attessa call`, revoke, `attessa status`), T21b (MCP server) and
// T29 (`attessa call --via buy`, optional) are unticked. The target sections say so: how-to.html#revoke
// "Coming. These commands, and attessa status, aren't built yet.", how-to.html#mcp and
// reference.html#tools "Coming. The MCP server isn't built yet.", how-to.html#buy "Optional, not built
// yet.", tutorial.html "Coming. The buyer commands aren't built yet."
// r24 and r25 made the docs landing cards and the meta descriptions mark these. Two summaries of the
// same surfaces were left unmarked:
//   - the tutorial's closing card "Give it to your agent / Add the Attessa MCP server." (links to
//     how-to.html#mcp), an instruction to do something that isn't built; the home page marks the same
//     offer "Give it to your agent. Coming. ... It isn't built yet.";
//   - the docs menu shown on every docs page: "Pay-if-verified in 10 minutes", "Revoke a build or a
//     signer", "Use it from an MCP agent", "Use it with buy", "Agent tools", with no marker.
// Same rule as docs-index-unbuilt-marked.test.mjs and howto-summaries-unbuilt-marked.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = p => readFileSync(join(src, p), 'utf8');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const marked = /\b(coming|planned|preview|optional|not built|isn't built|aren't built|not yet built|not available yet|once live|when live)\b/i;

// The section of a docs page from <h2 id="id"> to the next <h2>.
const section = (page, id) => {
  const raw = read(join('pages', 'docs', page));
  const at = raw.indexOf(`id="${id}"`);
  assert.ok(at >= 0, `precondition: ${page}#${id} moved`);
  const rest = raw.slice(at);
  const end = rest.indexOf('<h2', 1);
  return text(end < 0 ? rest : rest.slice(0, end));
};

// T21 is ticked: how-to.html#revoke (release revoke, revoke signer, status) is built and no longer marked. The MCP server (T21b, packages/mcp, on staging)
// is built too, so how-to.html#mcp and reference.html#tools are no longer marked. Still unbuilt: buy (T29).
const UNBUILT = [
  ['how-to.html', 'buy', /Optional, not built yet\./],
];
const BUILT_MCP = [['how-to.html', 'mcp'], ['reference.html', 'tools']];

test('the target sections mark buy as not built; revoke, the tutorial and the MCP server are built (precondition)', () => {
  for (const [page, id, says] of UNBUILT) assert.match(section(page, id), says, `${page}#${id}`);
  for (const [page, id] of BUILT_MCP) assert.doesNotMatch(section(page, id), /MCP server isn't built|Coming\. The MCP/i, `${page}#${id}: the MCP server is built and must not be marked`);
  assert.match(section('how-to.html', 'mcp'), /packages\/mcp\/dist\/bin\.js/, 'the how-to names how to start the server');
  assert.doesNotMatch(section('how-to.html', 'revoke'), /aren't built yet|Coming/, 'revoke is built (T21) and must not be marked');
  assert.match(text(read('pages/docs/tutorial.html')), /attessa init and attessa call are built\./);
});

test('the tutorial closing card that offers the MCP server does not mark it as not built', () => {
  const card = [...read('pages/docs/tutorial.html').matchAll(/<a href="([^"]+)">([\s\S]*?)<\/a>/g)]
    .map(m => ({ href: m[1], t: text(m[2]) }))
    .find(c => c.href === 'how-to.html#mcp');
  assert.ok(card, 'no tutorial card links to how-to.html#mcp');
  assert.match(card.t, /MCP/, 'the card no longer offers the MCP server');
  assert.doesNotMatch(card.t, marked,
    `tutorial.html card "${card.t}" marks the MCP server as not built, but packages/mcp is built (T21b)`);
});

test('the docs menu marks each link whose target section is not built, and not the built MCP link', () => {
  const nav = read('partials/docs-nav.html');
  const links = [...nav.matchAll(/<a href="\{\{root\}\}docs\/([^"#]+)(?:#([^"]+))?"[^>]*>([\s\S]*?)<\/a>/g)]
    .map(m => ({ page: m[1], id: m[2] ?? '', label: text(m[3]) }));
  const targets = UNBUILT.map(([p, id]) => [p, id]);
  const unmarked = targets
    .map(([p, id]) => {
      const l = links.find(x => x.page === p && x.id === id);
      assert.ok(l, `precondition: the docs menu has no link to ${p}${id ? '#' + id : ''}`);
      return l;
    })
    .filter(l => !marked.test(l.label))
    .map(l => `${l.page}${l.id ? '#' + l.id : ''}: "${l.label}"`);
  assert.deepEqual(unmarked, [],
    'docs-nav.html (on every docs page) offers these as usable today, but each target says Coming / not built (TASKS.md T29 unticked)');
  const mcp = links.find(l => l.page === 'how-to.html' && l.id === 'mcp');
  assert.ok(mcp, 'the docs menu has no link to how-to.html#mcp');
  assert.doesNotMatch(mcp.label, marked, 'the MCP link is marked, but packages/mcp is built (T21b)');
});

test('the docs menu does not mark the built tutorial or the built revoke recipe as Coming', () => {
  const nav = read('partials/docs-nav.html');
  for (const target of ['docs/tutorial.html"', 'docs/how-to.html#revoke"']) {
    const li = nav.split('\n').find(l => l.includes(target));
    assert.ok(li, `precondition: the docs menu links ${target}`);
    assert.doesNotMatch(text(li), /\b(coming|not built)\b/i, `${target} is built (TASKS.md T21 ticked) but the menu marks it`);
  }
});
