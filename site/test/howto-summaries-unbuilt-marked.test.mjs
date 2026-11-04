// Adversary round 25 on the site fixes (truth pass 5ff468a..f14ea5f).
// Intended home: site/test/howto-summaries-unbuilt-marked.test.mjs
// Run from the repo root: node --test site/test/howto-summaries-unbuilt-marked.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// TASKS.md: T21 (CLI: `attessa release revoke`, `attessa revoke signer`, `attessa status`), T21b (MCP
// server) and T29 (`attessa call --via buy`, optional) are unticked, and packages/cli/src/index.ts
// routes no revoke command. The how-to page body says so: "Coming. These commands, and attessa
// status, aren't built yet.", "Coming. The MCP server isn't built yet.", "Optional, not built yet."
// f14ea5f marked the tutorial's meta description and the docs landing cards, but:
//   - how-to.html's own meta description (built into <meta name="description">, used by search and
//     link previews) still offers "revoke a build or a signer, use Attessa from an MCP agent, and use
//     it with buy" with no marker at all;
//   - the docs landing card says "The MCP and buy guides are Coming." and leaves "revoke a build"
//     reading as usable today, though the target section marks it Coming.
// Same rule as docs-index-unbuilt-marked.test.mjs, applied to the how-to page's summaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const page = p => readFileSync(join(src, 'pages', p), 'utf8');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
const marked = /\b(coming|planned|preview|not built|isn't built|aren't built|not yet built|not available yet|once live|when live)\b/i;

test('the how-to body marks revoke, MCP and buy as not built (precondition)', () => {
  const t = text(page('docs/how-to.html'));
  assert.match(t, /Coming\. These commands, and attessa status ?, aren't built yet\./);
  assert.match(t, /Coming\. The MCP server isn't built yet\./);
  assert.match(t, /Optional, not built yet\./);
});

test('the how-to meta description marks the unbuilt recipes it offers', () => {
  const d = page('docs/how-to.html').match(/<!-- description: (.*?) -->/)?.[1] ?? '';
  assert.match(d, /revoke a build|MCP agent|with buy/, 'the description no longer offers them');
  assert.match(d, marked, `the how-to meta description "${d}" offers revoke, MCP and buy as usable; the page marks all three Coming / not built (TASKS.md T21, T21b, T29)`);
});

test('the docs landing card marks "revoke a build" as Coming, as its target section does', () => {
  const card = [...page('docs/index.html').matchAll(/<a href="([^"]+)">([\s\S]*?)<\/a>/g)]
    .map(m => ({ href: m[1], t: text(m[2]) }))
    .find(c => c.href === 'how-to.html');
  assert.ok(card, 'no card links to how-to.html');
  assert.match(card.t, /revoke a build/i, 'the card no longer offers revoke');
  const markedSentences = card.t.split(/(?<=\.)\s+/).filter(s => marked.test(s));
  assert.ok(
    markedSentences.some(s => /revok/i.test(s)),
    `docs/index.html card "${card.t.trim()}" marks only ${JSON.stringify(markedSentences)}; how-to.html#revoke says "Coming. These commands ... aren't built yet." (TASKS.md T21 unticked; no revoke route in packages/cli/src/index.ts)`,
  );
});
