// Started as adversary round 20 on the site, when the page said "Nothing is read from Celo yet". assets/explorer.js
// has since made the payment check real, on Celo Sepolia, so that wording became false in the other direction.
// Rewritten 2026-11-09 on Joshua's instruction ("update the explorer test"). The rule stays: the site may not
// present anything not built as available now. What is built is the payment check, and nothing else.
// Run from the repo root: node --test packages/site/test/explorer-claims-payment-check-only.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyStatus, readLive } from '../status.mjs';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
// The page as the switch in site.config.json shows it now, so wording kept for after launch isn't read as a claim today.
const siteConfig = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'site.config.json'), 'utf8'));
const raw = applyStatus(readFileSync(join(src, 'pages', 'explorer.html'), 'utf8'), readLive(siteConfig));
const js = readFileSync(join(src, 'static', 'assets', 'site.js'), 'utf8');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const sentences = t => t.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);

// A sentence that says the explorer reads or checks Celo data, and words that put it in the future or a sample.
const READS_CELO = /\b(check|checks|checked|read|reads|reading)\b[^.]*\bCelo\b/i;
const NOT_NOW = /\b(when live|once live|planned|coming|not built|yet|until|will|would|preview|sample|samples)\b/i;

const PAYMENT = /\b(payment|settlement|transaction)\b/i;
const PLANNED_CHECK = /\b(build|signer|endpoint|request ID|proof)\b/i;

test('the page says only the payment check runs (precondition)', () => {
  assert.match(text(raw), /It runs the payment check\. The other four are planned\./, 'precondition: the index sentence moved');
  const live = readFileSync(join(src, 'static', 'assets', 'explorer.js'), 'utf8');
  assert.match(live, /eth_getTransactionReceipt/, 'precondition: explorer.js no longer reads Celo, so the page must stop saying it does');
  assert.match(live, /forno\.celo-sepolia\.celo-testnet\.org/, 'precondition: explorer.js no longer reads Celo Sepolia');
});

test('the page does not say the working payment check is unbuilt', () => {
  for (const stale of [/when live,? (it|the explorer) (runs|checks)/i, /Nothing is read from Celo yet/, /until the explorer reads Celo/, /once live/i]) {
    assert.doesNotMatch(text(raw), stale, 'explorer.js reads Celo Sepolia for a pasted transaction today');
  }
});

test('every sentence that says it reads or checks Celo now is about the payment, and only the payment', () => {
  const description = raw.match(/<!--\s*description:\s*(.*?)\s*-->/)?.[1] ?? '';
  // One block element at a time, so option labels and headings don't run into the next sentence.
  const blocks = raw.replace(/^<!--[\s\S]*?-->\s*$/gm, '').split(/<\/(?:p|h1|h2|label|option|li|th|td|button)>/);
  const claims = [...sentences(description), ...blocks.flatMap(b => sentences(text(b)))]
    .filter(s => READS_CELO.test(s) && !NOT_NOW.test(s));
  assert.ok(claims.length >= 1, 'precondition: the page no longer claims the payment check');
  const beyond = claims.filter(s => { const said = s.match(READS_CELO)[0]; return !PAYMENT.test(said) || PLANNED_CHECK.test(said); });
  assert.deepEqual(beyond, [], 'only the payment check reads Celo; a present-tense claim about the build, signer, endpoint or proof presents an unbuilt check as available now');
});

test('a pasted hash goes to the real check, and the picker\'s sample states do not claim a read', () => {
  assert.match(js, /lastQuery = v\.toLowerCase\(\);\s*run\(\);/, 'precondition: a pasted hash no longer runs');
  assert.match(js, /if \(lastQuery\) \{ checkLive\(focus\); return; \}/, 'a pasted hash must go to the real check, never to a sample state');
  // renderLoading and MESSAGES.notfound are reached from the picker only, and show samples.
  const loading = js.match(/function renderLoading\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
  const notfound = js.match(/notfound: \(\) => message\(([\s\S]*?)`\),/)?.[1] ?? '';
  assert.ok(loading && notfound, 'precondition: renderLoading or MESSAGES.notfound moved; re-point this test');
  const said = [
    ...[...loading.matchAll(/<p class="check-line[^"]*">([^<$]*Celo[^<$]*)<\/p>/g)].map(m => m[1]),
    ...[...notfound.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(m => text(m[1].replace(/\$\{[^}]*\}/g, '{x}'))).filter(s => /Celo|matches/.test(s)),
  ];
  assert.ok(said.length >= 2, `precondition: found ${said.length} Celo lines in the loading and not-found states`);
  assert.deepEqual(said.filter(s => !NOT_NOW.test(s)), [], 'a sample state presented as a real read of Celo');
});
