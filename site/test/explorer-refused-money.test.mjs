// Adversary round 5 on the site fixes (25e57a5..1c05ae5, truth pass 5ff468a..1c05ae5).
// Intended home: site/test/explorer-refused-money.test.mjs
// Run from the repo root: node --test site/test/explorer-refused-money.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// The truth pass added to the explorer's "Recent calls" lede: "A refused call moves no money and
// leaves no event". SPEC lets a refused call move money and leave the settlement events:
//
// - SPEC §7 Outcome: 'settled_after_refusal' // the gateway refused, yet the authorization was settled
// - SPEC §7 "refused / uncertain -> final": authorizationState true, tx found (AuthorizationUsed +
//   Transfer to payTo), no result, call was refused -> settled_after_refusal.
// - SPEC §9 ext 11b "refused but settled" -> settled_after_refusal.
// - SPEC §1 trust table: the gateway operator is trusted only "for settling only after verification".
//
// reference.html lists settled_after_refusal ("The service refused, but your permission was used
// anyway"), so the site contradicts itself, and the explorer's feed of settlement events would list
// exactly such a refused call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const read = p => readFileSync(join(src, ...p.split('/')), 'utf8');

const sentences = s => text(s).split(/(?<=[.:;])\s+/);
// A sentence that says a refusal moves no money or leaves no on-chain trace, with no condition of its own.
const QUALIFIED = /\b(if|unless|when|should|shouldn't|normally|usually|honest|settled_after_refusal)\b/i;
const absolute = s => /\brefus/i.test(s) && /\b(no money|no event|no transaction|never (settles|moves|used))\b/i.test(s) && !QUALIFIED.test(s);

test('the site itself lists settled_after_refusal (precondition)', () => {
  assert.match(read('pages/docs/reference.html'), /<code>settled_after_refusal<\/code><\/td><td>The service refused, but your permission was used anyway/);
});

test('the explorer does not say a refused call never moves money or leaves an event', () => {
  const found = sentences(read('pages/explorer.html')).filter(absolute);
  assert.deepEqual(found, [], 'a refused call can still be settled (settled_after_refusal, SPEC §7, §9 ext 11b)');
});
