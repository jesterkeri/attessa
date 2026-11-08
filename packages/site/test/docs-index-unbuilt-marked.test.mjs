// Adversary round 24 on the site fixes (truth pass 5ff468a..cac30d0).
// Intended home: packages/site/test/docs-index-unbuilt-marked.test.mjs
// Run from the repo root: node --test packages/site/test/docs-index-unbuilt-marked.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// TASKS.md: T21 (CLI `attessa init`, `attessa call`), T21a (`attessa verify`), T21b (MCP server),
// T29 (`attessa call --via buy`, optional) and T16/T37 (a Sepolia seller to call) are unticked. The
// tutorial and the how-tos say so ("Coming. The buyer commands aren't built yet.", "Coming. The MCP
// server isn't built yet.", "Optional, not built yet."). The docs landing page offers the same
// surfaces as ready today, with no marker anywhere on it:
//   Tutorial: "Make your first pay-if-verified call on Celo Sepolia, in about 10 minutes."
//   How-tos:  "Run a seller, revoke a build, use Attessa from an MCP agent or with buy."
// The tutorial's own meta description (search and link previews) makes the same offer unmarked.
// Same rule as built-state-consistent.test.mjs and unbuilt-commands-marked.test.mjs, which leave
// docs/index.html out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const page = p => readFileSync(join(src, 'pages', p), 'utf8');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
const marked = /\b(coming|planned|preview|not built|isn't built|aren't built|not yet built|not available yet|once live|when live)\b/i;
// The docs landing page's cards, one per <a>.
const cards = () => [...page('docs/index.html').matchAll(/<a href="([^"]+)">([\s\S]*?)<\/a>/g)].map(m => ({ href: m[1], t: text(m[2]) }));

// The buyer CLI is built, verify included: the tutorial says so. The how-to still marks the MCP server (T21b), and the demo service is not live.
test('the tutorial says init, call and verify are built; the how-to marks the MCP server not built (precondition)', () => {
  const t = text(page('docs/tutorial.html'));
  assert.match(t, /attessa init , attessa call and attessa verify are built\./);
  assert.doesNotMatch(t, /attessa verify isn't built/);
  assert.doesNotMatch(t, /buyer commands aren't built yet/, 'the tutorial still calls the built buyer commands unbuilt');
  assert.match(text(page('docs/how-to.html')), /Coming\. The MCP server isn't built yet\./);
});

for (const [href, offers] of [
  ['tutorial.html', /Make your first pay-if-verified call on Celo Sepolia/],
  ['how-to.html', /use Attessa from an MCP agent/],
]) {
  test(`docs/index.html card for ${href} offers an unbuilt surface, and says it isn't built`, () => {
    const card = cards().find(c => c.href === href);
    assert.ok(card, `no card links to ${href}`);
    assert.match(card.t, offers, `the ${href} card no longer offers it`);
    assert.match(card.t, marked, `docs/index.html offers "${card.t.trim()}" as usable today, but the target page marks it Coming / not built (TASKS.md T21, T21b unticked)`);
  });
}

test('the tutorial meta description says the demo service is not available yet', () => {
  const d = page('docs/tutorial.html').match(/<!-- description: (.*?) -->/)?.[1] ?? '';
  assert.match(d, /Make your first pay-if-verified call on Celo Sepolia/, 'the description no longer offers it');
  assert.match(d, marked, `the tutorial's meta description "${d}" offers a call with no word that the demo service isn't live (T16, T37)`);
});
