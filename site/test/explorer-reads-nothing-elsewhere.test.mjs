// Adversary round 21 on the site (5ff468a..4f787bb, newest fix 4f787bb).
// Intended home: site/test/explorer-reads-nothing-elsewhere.test.mjs
// Run from the repo root: node --test site/test/explorer-reads-nothing-elsewhere.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// 4f787bb made every Celo read on the explorer page "when live", and the page says "Nothing is read from
// Celo yet". site/README.md: the site "is not wired to Celo, the gateway or the SDK yet", and no TASKS.md
// entry builds a web explorer (T21a `attessa verify` is unticked). The rule for the site: it may not
// present anything not built as available now.
//
// Other pages still say, in the present tense, that the explorer reads Celo now:
//   privacy.html, under "What this site does today":
//     "The proof explorer reads public Celo data for the transaction you paste."
//   use-cases.html: "... and anyone can check the call's payment on Celo later in the proof explorer."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const sentences = t => t.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);

// Same wording as explorer-reads-nothing-yet.test.mjs (r20): a read or check of Celo, and words that
// put it in the future or a sample.
const READS_CELO = /\b(check|checks|checked|read|reads|reading)\b[^.]*\bCelo\b/i;
const NOT_NOW = /\b(when live|once live|planned|coming|not built|yet|until|will|would|preview|sample|samples)\b/i;

const pages = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? pages(join(dir, e.name)) : e.name.endsWith('.html') ? [join(dir, e.name)] : []);

// Sentences, one block element at a time, plus the meta description.
const claimsIn = raw => {
  const description = raw.match(/<!--\s*description:\s*(.*?)\s*-->/)?.[1] ?? '';
  const blocks = raw.replace(/^<!--[\s\S]*?-->\s*$/gm, '').split(/<\/(?:p|h1|h2|h3|label|option|li|th|td|dd|button|a)>/);
  return [...sentences(description), ...blocks.flatMap(b => sentences(text(b)))];
};

test('the explorer page says it reads nothing from Celo yet (precondition)', () => {
  const raw = readFileSync(join(src, 'pages', 'explorer.html'), 'utf8');
  assert.match(text(raw), /Nothing is read from Celo yet/, 'precondition: preview bar moved');
});

test('the privacy page does not list a Celo read by the explorer as what the site does today', () => {
  const raw = readFileSync(join(src, 'pages', 'privacy.html'), 'utf8');
  const today = raw.match(/<h2 id="today">[\s\S]*?<\/ul>/)?.[0] ?? '';
  assert.ok(today, 'precondition: the "What this site does today" list moved');
  const claims = claimsIn(today).filter(s => /explorer/i.test(s) && READS_CELO.test(s) && !NOT_NOW.test(s));
  assert.deepEqual(claims, [],
    'privacy.html says, under "What this site does today", that the explorer reads Celo, but explorer.html says "Nothing is read from Celo yet"');
});

test('no page outside the explorer says the explorer reads or checks Celo now', () => {
  const claims = pages(join(src, 'pages'))
    .filter(f => !f.endsWith(join('pages', 'explorer.html')))
    .flatMap(f => claimsIn(readFileSync(f, 'utf8'))
      .filter(s => /explorer/i.test(s) && READS_CELO.test(s) && !NOT_NOW.test(s))
      .map(s => `${relative(src, f)}: ${s}`));
  assert.deepEqual(claims, [],
    'explorer.html says "Nothing is read from Celo yet", so another page that says the explorer reads or checks Celo presents an unbuilt explorer as available now');
});
