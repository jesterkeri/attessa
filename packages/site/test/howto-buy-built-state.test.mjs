// Adversary round 4 on the site fixes (c952b6a..25e57a5). Intended home: packages/site/test/howto-buy-built-state.test.mjs
// Run from the repo root: node --test packages/site/test/howto-buy-built-state.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// 25e57a5 marked the how-to's seller, revoke and MCP sections "Coming", but left "Use it with buy"
// unmarked: it shows `attessa call --via buy` with example output and says "Attessa still records what
// you got", as working today. SPEC §8 lists `attessa call --via buy` under "Optional (post-Nov 2)", the
// reference marks it "Optional, not built yet", and staging's CLI (origin/staging
// packages/cli/src/index.ts COMMANDS) has no `call` command at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const page = p => readFileSync(join(src, 'pages', p), 'utf8');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
const marked = /\b(coming|optional|not built|isn't built|aren't built|not yet built|not available yet)\b/i;

test('the reference marks `attessa call --via buy` as not built (precondition)', () => {
  assert.match(text(page('docs/reference.html')), /attessa call --via buy <url> Optional, not built yet/);
});

test('the how-to buy section, which offers `attessa call --via buy`, says it is not built', () => {
  const h = page('docs/how-to.html');
  const buy = text(h.slice(h.indexOf('id="buy"'), h.indexOf('</article>')));
  assert.match(buy, /attessa call --via buy/, 'the how-to no longer offers it');
  assert.match(buy, marked, `how-to #buy offers \`attessa call --via buy\` as usable today: "${buy.slice(0, 200).trim()}..."`);
});
