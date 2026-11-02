// Adversary round 3 on the site fixes (5ff468a..c952b6a). Intended home: site/test/reference-busy-limited.test.mjs
// Run from the repo root: node --test site/test/reference-busy-limited.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// 89b2f97 split the reference's `gateway_busy, rate_limited` row in two. Each row now makes a flat
// claim about whether the buyer had signed, but SPEC lets both codes arrive before and after signing:
//
// - rate_limited, before signing: SPEC §6.1 limits unpaid POST /v1/evaluate to 120/min/IP and
//   POST /v1/liveness to 30/min/IP, both answered 429 rate_limited (SPEC §10 has no other 429 code).
//   The SDK hits those at V2 (quote) and V7 (liveness), before V8 signs (SPEC §7 payAndVerify).
// - rate_limited, after signing: SPEC §6.2 step 5, the per-payer unsettled limit on a paid request.
// - gateway_busy, after signing: SPEC §6.1 puts the in-flight cap of 16 on POST /v1/evaluate with
//   no paid/unpaid split, so the V9 paid POST can get 503 gateway_busy after V8 signed.
//
// And SPEC §9 extension 5c ends a rate_limited paid call in "refused -> not_charged": not charged
// is reached only after the chain check (§7 "refused / uncertain -> final"; §9 minimal guarantee).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const text = h => h.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

function refusalRows() {
  const ref = readFileSync(join(src, 'pages', 'docs', 'reference.html'), 'utf8');
  const section = ref.slice(ref.indexOf('id="refusals"'));
  const rows = new Map();
  for (const m of section.matchAll(/<tr><td>([\s\S]*?)<\/td><td>([\s\S]*?)<\/td>/g)) {
    for (const c of m[1].matchAll(/<code>([a-z_]+)<\/code>/g)) rows.set(c[1], text(m[2]));
  }
  return rows;
}

// A sentence that states the signing state as fact, with no condition on it.
const sentences = s => s.split(/(?<=\.)\s+/);
const conditional = /\b(if|when|whether|unless)\b/i;
const saysNothingSigned = s => sentences(s).some(x => /nothing was signed/i.test(x) && !conditional.test(x));
const saysSigned = s => sentences(s).some(x => /permission was signed/i.test(x) && !conditional.test(x));

test('rate_limited does not claim a signed permission: the per-IP limits answer it before signing', () => {
  const d = refusalRows().get('rate_limited');
  assert.ok(d, 'no rate_limited row in the reference');
  assert.ok(!saysSigned(d), `rate_limited row says, unconditionally, that a permission was signed: "${d}"`);
});

test('gateway_busy does not claim nothing was signed: the in-flight cap also answers the paid request', () => {
  const d = refusalRows().get('gateway_busy');
  assert.ok(d, 'no gateway_busy row in the reference');
  assert.ok(!saysNothingSigned(d), `gateway_busy row says, unconditionally, that nothing was signed: "${d}"`);
});

test('rate_limited does not say "not charged" before the chain confirms it', () => {
  const rows = refusalRows();
  const d = rows.get('rate_limited');
  assert.ok(d, 'no rate_limited row in the reference');
  // The page's own not_charged row reserves the phrase for the chain-confirmed state.
  assert.match(rows.get('not_charged') ?? '', /Confirmed on Celo/);
  const flat = sentences(d).some(x => /(you are|you're) not charged/i.test(x) && !/confirm/i.test(x));
  assert.ok(!flat, `rate_limited row tells a signed buyer they are not charged with no chain check: "${d}"`);
});
