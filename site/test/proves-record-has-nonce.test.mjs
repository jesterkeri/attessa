// Adversary round 14 on the site (5ff468a..0271566).
// Intended home: site/test/proves-record-has-nonce.test.mjs
// Run from the repo root: node --test site/test/proves-record-has-nonce.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// partials/proves.html (on the homepage and in docs/explanation.html) says of "your payment permission
// expired unused": "Anyone can read this on Celo, given the payer's address and the permission's nonce.
// Both are in your own record." The site defines "your record" as ~/.attessa/evidence.jsonl
// (privacy.html, tutorial.html, cli-call.html), and so does GLOSSARY.md: "evidence | record | The buyer's
// append-only JSONL of every call". SPEC §7 "Evidence row (append-only)" lists its fields, and neither
// `payer` nor `nonce` is one of them. They live in the pending ledger (`<dataDir>/pending.jsonl`), which
// GLOSSARY never calls the record. So a buyer told to take the nonce from their record finds none there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const root = join(src, '..', '..');
const proves = readFileSync(join(src, 'partials', 'proves.html'), 'utf8');
const privacy = readFileSync(join(src, 'pages', 'privacy.html'), 'utf8');
const spec = readFileSync(join(root, 'SPEC.md'), 'utf8');
const glossary = readFileSync(join(root, 'GLOSSARY.md'), 'utf8');
const text = h => h.replace(/<[^>]*>/g, '').replace(/\{\{[^}]*\}\}/g, '').replace(/\s+/g, ' ').trim();

const evidenceRow = spec.match(/### Evidence row \(append-only\)\s*```json\s*(\{[^\n]*\})/)?.[1] ?? '';
const evidenceFields = [...evidenceRow.matchAll(/"(\w+)"/g)].map(m => m[1]);

test('record means evidence.jsonl, and SPEC lists its fields (precondition)', () => {
  assert.match(text(privacy), /Your record of each call stays on your computer, in ~\/\.attessa\/evidence\.jsonl/);
  assert.match(glossary, /\| evidence \| record \| The buyer's append-only JSONL of every call \|/);
  assert.ok(evidenceFields.includes('requestId') && evidenceFields.includes('settlementTx'),
    'SPEC §7 evidence row moved; re-point this test');
});

test('proves.html does not say the payer and nonce are in your record unless the evidence row holds them', () => {
  const li = [...proves.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(m => text(m[1])).find(t => /expired unused/i.test(t));
  assert.ok(li, 'proves.html no longer has the "expired unused" claim');
  const claims = /\bnonce\b/i.test(li) && /\b(both|it|they) (are|is) in your (own )?record\b/i.test(li);
  const missing = ['payer', 'nonce'].filter(f => !evidenceFields.includes(f));
  assert.ok(!claims || missing.length === 0,
    `proves.html says "${li}", but SPEC §7 evidence row (GLOSSARY: record) has no ${missing.join(' or ')} field: ${evidenceRow}`);
});
