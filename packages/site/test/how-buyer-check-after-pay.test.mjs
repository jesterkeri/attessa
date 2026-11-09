// Adversary round 22 on the site (5ff468a..a485812). Intended home: packages/site/test/how-buyer-check-after-pay.test.mjs
// Run from the repo root: node --test packages/site/test/how-buyer-check-after-pay.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src; SPEC.md and FLOWS.md are read from SITE_SRC/../..)
//
// The how-it-works buyer step 05 is headed "The proof is checked twice, then you pay", and its body
// names the two checks: the gateway's, then "Attessa on your side, the CLI or the SDK, checks the same
// proof again on its own". Only the first one comes before the payment. The buyer's own check runs on
// the answer the gateway returns after it has settled:
//   SPEC.md §7 payAndVerify V9: "Paid POST. 200 → V11 then V10" (V11 = settlement confirmed on chain,
//   V10 = verifyPaidResponse, on failure `paid_but_rejected{check}`), and §6.2 step 12: "`settled` → 200".
//   FLOWS.md §3 J1 tasks: "10. gateway settles", "11. response + proof + settlement returned",
//   "12. buyer verifies independently"; §7: "Verifying --> PaidButRejected: a check fails after settlement".
// So the second check cannot stop the payment; a heading that puts both before "you pay" overstates
// what protects the buyer's money.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const repo = join(src, '..', '..', '..');
const spec = readFileSync(process.env.SPEC_MD ?? join(repo, 'SPEC.md'), 'utf8');
const flows = readFileSync(process.env.FLOWS_MD ?? join(repo, 'FLOWS.md'), 'utf8');

const text = h => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const how = readFileSync(join(src, 'pages', 'how-it-works.html'), 'utf8');
const buyer = how.slice(how.indexOf('id="panel-buyer"'), how.indexOf('id="panel-seller"'));
const steps = [...buyer.matchAll(/<li class="walk-step[^"]*" data-walk-step>([\s\S]*?)<\/li>/g)].map(m => ({
  heading: text((m[1].match(/<h3>([\s\S]*?)<\/h3>/) ?? [, ''])[1]),
  copy: text((m[1].match(/<div class="walk-copy">([\s\S]*?)<\/div>/) ?? [, ''])[1]),
}));
// The step whose copy has the buyer's own CLI or SDK check the proof again.
const reCheck = steps.filter(s => /\b(CLI|SDK)\b[^.]*\bchecks the same proof again\b/.test(s.copy));

const files = dir => readdirSync(dir, { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.html') ? [join(dir, e.name)] : []));
// "checked twice, then you pay", "checks it twice before paying" and the like.
const TWICE_THEN_PAY = /\b(checked|checks?|verified|verifies)\b[^.!?]*\btwice\b[^.!?]*\b(then|before)\b[^.!?]*\b(you )?pa(y|ys|id|ying)\b/i;

test('the SDK re-check runs after settlement in SPEC and FLOWS, and the buyer step names it (precondition)', () => {
  assert.match(spec, /200 → V11 then V10/, 'SPEC §7 V9 no longer orders V11 (settlement) before V10 (the buyer check)');
  assert.match(flows, /PaidButRejected: a check fails after settlement/, 'FLOWS §7 no longer has a check that fails after settlement');
  assert.ok(steps.length >= 5, `only ${steps.length} buyer steps parsed from how-it-works.html`);
  assert.equal(reCheck.length, 1, 'no buyer step says the CLI or SDK checks the same proof again');
});

test('the buyer step with the SDK re-check does not say both checks come before you pay', () => {
  const wrong = reCheck.filter(s => TWICE_THEN_PAY.test(s.heading) || TWICE_THEN_PAY.test(s.copy));
  assert.deepEqual(wrong.map(s => s.heading), [], 'the SDK checks the proof after the gateway settled (SPEC §7 V9: "200 → V11 then V10")');
});

test('no page says a proof is checked twice before the buyer pays', () => {
  // Each block of text on its own (a heading, a paragraph), so a match never runs across two blocks.
  const hits = files(src).flatMap(f => readFileSync(f, 'utf8')
    .split(/<\/?(?:h[1-6]|p|li|div|td|th|dt|dd|figcaption|pre)\b[^>]*>/)
    .map(text)
    .filter(t => TWICE_THEN_PAY.test(t))
    .map(t => `${f.slice(src.length + 1)}: ${JSON.stringify(t)}`));
  assert.deepEqual(hits, []);
});
