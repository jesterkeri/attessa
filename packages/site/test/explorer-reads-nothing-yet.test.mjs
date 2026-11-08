// Adversary round 20 on the site (5ff468a..1c47424, newest fixes 8b120f0 and 1c47424).
// Intended home: packages/site/test/explorer-reads-nothing-yet.test.mjs
// Run from the repo root: node --test packages/site/test/explorer-reads-nothing-yet.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// 1c47424 changed the explorer index to "When live, it runs the payment check. The other four are planned.",
// and the preview bar says "Nothing is read from Celo yet". packages/site/README.md: the site "is not wired to Celo,
// the gateway or the SDK yet", and no TASKS.md entry builds a web explorer (T21a `attessa verify` is unticked).
// The rule for the site: it may not present anything not built as available now.
//
// The rest of the same page still says, in the present tense, that the explorer reads Celo now:
//   meta description "Check the on-chain part of any past Attessa call from public Celo data, ..."
//   lede "Paste a call's settlement transaction, and the explorer checks its on-chain part from public Celo data"
//   field help "Checks against Celo Sepolia."
//   noscript "The explorer needs JavaScript to read Celo."
//   Recent calls "The latest settlements, read from Celo events."
// And for a hash the visitor pastes (site.js run()), the loading state says "Reading the settlement from public
// Celo data…" about that real hash, and the "Not found" state says "Nothing on Celo Sepolia matches <that hash>",
// though nothing was read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const raw = readFileSync(join(src, 'pages', 'explorer.html'), 'utf8');
const js = readFileSync(join(src, 'static', 'assets', 'site.js'), 'utf8');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const sentences = t => t.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);

// A sentence that says the explorer reads or checks Celo data, and words that put it in the future or a sample.
const READS_CELO = /\b(check|checks|checked|read|reads|reading)\b[^.]*\bCelo\b/i;
const NOT_NOW = /\b(when live|once live|planned|coming|not built|yet|until|will|would|preview|sample|samples)\b/i;

test('the explorer page says it reads nothing from Celo yet (precondition)', () => {
  assert.match(text(raw), /When live, it runs the payment check\. The other four are planned\./, 'precondition: 1c47424 sentence moved');
  assert.match(text(raw), /Nothing is read from Celo yet/, 'precondition: preview bar moved');
});

test('no sentence on the explorer page says it reads Celo now', () => {
  const description = raw.match(/<!--\s*description:\s*(.*?)\s*-->/)?.[1] ?? '';
  // One block element at a time, so option labels and headings don't run into the next sentence.
  const blocks = raw.replace(/^<!--[\s\S]*?-->\s*$/gm, '').split(/<\/(?:p|h1|h2|label|option|li|th|td|button)>/);
  const claims = [...sentences(description), ...blocks.flatMap(b => sentences(text(b)))]
    .filter(s => READS_CELO.test(s) && !NOT_NOW.test(s));
  assert.deepEqual(claims, [],
    'explorer.html says "When live, it runs the payment check" and "Nothing is read from Celo yet", so a present-tense claim that it checks or reads Celo presents an unbuilt explorer as available now');
});

test('a hash the visitor pastes is not described as read from Celo', () => {
  // run() always shows renderLoading first, then the chosen state, with the pasted hash as lastQuery.
  const loading = js.match(/function renderLoading\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
  const notfound = js.match(/notfound: \(\) => message\(([\s\S]*?)`\),/)?.[1] ?? '';
  assert.ok(loading && notfound, 'precondition: renderLoading or MESSAGES.notfound moved; re-point this test');
  assert.match(js, /lastQuery = v\.toLowerCase\(\);\s*run\(\);/, 'precondition: a pasted hash no longer runs the preview');
  const said = [
    ...[...loading.matchAll(/<p class="check-line[^"]*">([^<$]*Celo[^<$]*)<\/p>/g)].map(m => m[1]),
    ...[...notfound.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(m => text(m[1].replace(/\$\{[^}]*\}/g, '{x}'))).filter(s => /Celo|matches/.test(s)),
  ];
  assert.ok(said.length >= 2, `precondition: found ${said.length} Celo lines in the loading and not-found states`);
  const live = said.filter(s => !NOT_NOW.test(s));
  assert.deepEqual(live, [],
    'for a hash the visitor pasted, the page claims a Celo read ("Reading ... from public Celo data", "Nothing on ... matches") that it never makes');
});
