// Adversary round 4 on the site fixes (c952b6a..25e57a5). Intended home: site/test/proves-nonce-source.test.mjs
// Run from the repo root: node --test site/test/proves-nonce-source.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// 25e57a5 says, of "your payment permission expired unused", that "the nonce is also in the proof the
// gateway publishes". A permission that expires unused belongs to a refused call, and a refused call
// has no stored proof to publish: SPEC §6.2 stores `proof_header` only at step 11 (state `settling`);
// step 5 `rate_limited` writes no row; step 9 `proof_rejected` never settles. Staging's gateway matches
// (packages/gateway/src/db.ts sets proof_header only in the UPDATE to 'settling'). And the public route
// that would publish a proof (OPEN-QUESTIONS D1, T43) is not built; `/v1/results` needs the payer's
// signature (SPEC §6.1). So a third party cannot get the nonce of an unused permission that way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const proves = readFileSync(join(src, 'partials', 'proves.html'), 'utf8');
const text = h => h.replace(/<[^>]*>/g, '').replace(/\{\{[^}]*\}\}/g, '').replace(/\s+/g, ' ').trim();

test('the "expired unused" claim does not name a published proof as the source of the nonce for every call', () => {
  const li = [...proves.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(m => text(m[1])).find(t => /expired unused/i.test(t));
  assert.ok(li, 'proves.html no longer has the "expired unused" claim');
  const bad = li.split(/(?<=\.)\s+/).filter(s => /nonce/i.test(s) && /proof/i.test(s) && /publish/i.test(s))
    .filter(s => !/\b(settled|paid|if|when|once|will)\b/i.test(s));
  assert.deepEqual(bad, [], 'a permission that expired unused belongs to a refused call, which has no published proof');
});
