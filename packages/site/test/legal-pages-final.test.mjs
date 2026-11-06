// Codex site-finish r1 M2: Privacy and Terms are final copy: no Draft marker, no "before launch" promise, the contact is there,
// and the privacy page says what the explorer sends and to whom.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const page = n => readFileSync(join(src, 'pages', n), 'utf8');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

for (const n of ['privacy.html', 'terms.html']) {
  test(`${n} is final copy with a contact`, () => {
    const raw = page(n);
    assert.doesNotMatch(raw, /class="mode"/);
    assert.doesNotMatch(text(raw), /\bDraft\b|before launch|goes here|ahead of (the full|launch)/i);
    assert.match(raw, /mailto:attessa7@gmail\.com/);
    assert.match(text(raw), /Last updated 2026-11-06/);
  });
}

test('privacy: no cookies or analytics, GitHub Pages, and what the explorer sends and to whom', () => {
  const t = text(page('privacy.html'));
  assert.match(t, /sets no cookies/);
  assert.match(t, /no analytics/);
  assert.match(t, /GitHub Pages/);
  assert.match(t, /sends that hash straight to Celo Sepolia's public node \(forno\.celo-sepolia\.celo-testnet\.org\), which can see the hash and your IP address/);
  assert.match(t, /does not go to Attessa/);
});

test('terms: testnet, mainnet not live, as is, no financial advice', () => {
  const t = text(page('terms.html'));
  assert.match(t, /Celo Sepolia, which uses test money with no value/);
  assert.match(t, /not live on Celo mainnet/);
  assert.match(t, /without any warranty/);
  assert.match(t, /Not financial advice/);
});
