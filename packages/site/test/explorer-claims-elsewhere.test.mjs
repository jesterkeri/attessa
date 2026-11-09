// Started as adversary round 21 on the site, when the explorer page said "Nothing is read from Celo yet". The payment
// check is now real on Celo Sepolia, so other pages may say so. Rewritten 2026-11-09 on Joshua's instruction
// ("update the explorer test"). The rule stays: no page may say the explorer checks more than the payment.
// Run from the repo root: node --test packages/site/test/explorer-claims-elsewhere.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
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

const aboutMoreThanPayment = s => {
  const said = s.match(READS_CELO)[0].replace(/proof explorer/gi, 'explorer');
  return !/\b(payment|settlement|transaction)\b/i.test(said);
};

test('the privacy page says what the explorer sends, and to whom', () => {
  const raw = readFileSync(join(src, 'pages', 'privacy.html'), 'utf8');
  assert.match(raw, /your browser sends that hash straight to Celo Sepolia's public node/, 'the check really sends the pasted hash to a public node, and a visitor must be told');
  const today = raw.match(/<h2 id="today">[\s\S]*?<\/ul>/)?.[0] ?? '';
  assert.ok(today, 'precondition: the "What this site does today" list moved');
  assert.deepEqual(claimsIn(today).filter(s => /explorer/i.test(s) && READS_CELO.test(s) && !NOT_NOW.test(s) && aboutMoreThanPayment(s)), []);
});

test('no page outside the explorer says the explorer reads or checks more of Celo than the payment', () => {
  const claims = pages(join(src, 'pages'))
    .filter(f => !f.endsWith(join('pages', 'explorer.html')))
    .flatMap(f => claimsIn(readFileSync(f, 'utf8'))
      .filter(s => /explorer/i.test(s) && READS_CELO.test(s) && !NOT_NOW.test(s) && aboutMoreThanPayment(s))
      .map(s => `${relative(src, f)}: ${s}`));
  assert.deepEqual(claims, [], 'only the payment check is built; a wider claim presents an unbuilt check as available now');
});
