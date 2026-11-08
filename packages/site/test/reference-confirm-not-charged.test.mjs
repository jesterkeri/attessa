// Adversary round 4 on the site fixes (c952b6a..25e57a5). Intended home: packages/site/test/reference-confirm-not-charged.test.mjs
// Run from the repo root: node --test packages/site/test/reference-confirm-not-charged.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// 25e57a5 rewrote the reference's refusal intro and the gateway_busy and rate_limited rows to say
// "the SDK confirms on Celo that you weren't charged". That states the chain check's result before
// it has run, and SPEC lets it come out otherwise:
//
// - SPEC §7 "refused / uncertain -> final": if authorizationState is true and the tx is found with no
//   result, a refused call ends `settled_after_refusal` (SPEC §9 ext 11b "refused but settled").
// - SPEC §7 AttestConfig `waitForExpiry` (default true) and §8 `attessa call ... [--no-wait]`
//   ("waits to confirm not-charged unless --no-wait"): with --no-wait the SDK returns `refused` and
//   confirms nothing.
//
// The same page lists both `--no-wait` and `settled_after_refusal`, so it contradicts itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const text = h => h.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const ref = readFileSync(join(src, 'pages', 'docs', 'reference.html'), 'utf8');
const section = ref.slice(ref.indexOf('id="refusals"'));

function rows() {
  const out = new Map();
  for (const m of section.matchAll(/<tr><td>([\s\S]*?)<\/td><td>([\s\S]*?)<\/td>/g)) {
    for (const c of m[1].matchAll(/<code>([a-z_]+)<\/code>/g)) out.set(c[1], text(m[2]));
  }
  return out;
}

// A clause that reports "you weren't charged" as the result of the check, with no condition of its own.
const clauses = s => s.split(/(?<=\.)\s+/).flatMap(x => x.split(/,\s*|\band\b/));
const outcomeStated = s =>
  clauses(s).filter(c => /confirm\w*\b.*\byou (weren't|were not|are not|aren't) charged/i.test(c) && !/\b(if|whether|unless|when)\b/i.test(c));

test('the page itself lists --no-wait and settled_after_refusal (precondition)', () => {
  assert.match(ref, /--no-wait/);
  assert.ok(rows().has('settled_after_refusal'));
});

test('no refusal text promises the chain check will find you were not charged', () => {
  const intro = text(section.match(/<p>([\s\S]*?)<\/p>/)[1]);
  const r = rows();
  const found = [
    ['intro', intro],
    ['gateway_busy', r.get('gateway_busy') ?? ''],
    ['rate_limited', r.get('rate_limited') ?? ''],
  ].flatMap(([where, s]) => outcomeStated(s).map(c => `${where}: "${c.trim()}"`));
  assert.deepEqual(found, [], 'states the chain check\'s result in advance; --no-wait skips it and settled_after_refusal is a possible result');
});
