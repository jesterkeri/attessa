// Adversary round 2 on the site fixes (aad82a8..5ff468a). Intended home: site/test/home-checks-before-pay.test.mjs
// Run from the repo root: node --test site/test/home-checks-before-pay.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// 146ada0 puts "five" back into every homepage claim about the checks that pass BEFORE the gateway
// uses the payment permission. The site defines the five checks itself (explorer "The five checks it
// runs", tutorial "approved build, sealed machine, this exact request and answer, real Celo data, and
// payment"), and the fifth is Payment (settlement): the gateway using the permission. A check that is
// the payment cannot pass before the payment. FLOWS.md §7 keeps them apart too:
// "ProofChecking --> Settling: all checks pass; response persisted".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const num = s => WORDS[s.toLowerCase()] ?? Number(s);

// The site's own list of the checks, and how many of them can happen before anyone is paid.
const explorer = readFileSync(join(src, 'pages', 'explorer.html'), 'utf8');
const list = explorer.match(/checks it runs<\/p>\s*<ol>([\s\S]*?)<\/ol>/);
const items = list ? [...list[1].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => m[1].replace(/<[^>]+>/g, ' ').trim()) : [];
const prePay = items.filter(t => !/\b(payment|settlement)\b/i.test(t)).length;

const home = readFileSync(join(src, 'pages', 'index.html'), 'utf8');

test('the explorer lists the checks, and one of them is the payment itself', () => {
  assert.ok(items.length > 0, 'explorer.html no longer lists its checks');
  assert.ok(prePay < items.length, 'no check in the explorer list is the payment');
});

test('every homepage count of checks that pass before paying leaves out the payment check', () => {
  const claims = [
    ['story step', home.match(/only after all (\w+) checks pass/)],
    ['hero aria-label', home.match(/(\w+) checks run before a call is paid/)],
    ['limits "must all pass first"', home.match(/Checks that must all pass first<\/dt><dd>(\d+)/)],
  ].filter(([, m]) => m);
  assert.ok(claims.length > 0, 'the homepage no longer states how many checks pass before paying');
  const wrong = claims.filter(([, m]) => num(m[1]) !== prePay).map(([where, m]) => `${where} says ${m[1]}`);
  assert.deepEqual(wrong, [], `only ${prePay} of the explorer's checks (${items.join('; ')}) can pass before the payment, but the homepage's`);
});
