// Adversary round 3 on the site fixes (5ff468a..c952b6a). Intended home: packages/site/test/built-state-consistent.test.mjs
// Run from the repo root: node --test packages/site/test/built-state-consistent.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// 9d425f3 marks the reference's CLI rows and the MCP server "Coming" (TASKS.md: T21 CLI in progress,
// T21a verify and T21b MCP not built). The other pages still offer the same things as working today:
// the home page's copy button (edited in c952b6a) and the how-to config run
// packages/mcp/dist/bin.js, which does not exist yet, and the tutorial walks through `attessa init`,
// `attessa call` and `attessa verify` with no word that they aren't built. One page says "isn't
// built yet", the others say "here is the command".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const page = p => readFileSync(join(src, 'pages', p), 'utf8');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
const marked = /\b(coming|not built|isn't built|aren't built|not yet built|not available yet)\b/i;

test('the reference still marks the MCP server and the buyer CLI as not built (precondition)', () => {
  const ref = text(page('docs/reference.html'));
  assert.match(ref, /MCP server isn't built yet/);
  assert.match(ref, /attessa verify <requestId> Re-checks/, 'the reference must offer verify as built');
});

for (const [p, offers] of [
  ['index.html', /packages\/mcp\/dist\/bin\.js/],
  ['docs/how-to.html', /packages\/mcp\/dist\/bin\.js/],
]) {
  test(`${p} offers what the reference calls not built, and says it isn't built`, () => {
    const t = text(page(p));
    assert.match(t, offers, `${p} no longer offers it`);
    assert.match(t, marked, `${p} offers ${offers} as usable today, but the reference marks it "Coming" / not built`);
  });
}
