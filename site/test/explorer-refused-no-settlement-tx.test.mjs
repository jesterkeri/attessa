// Adversary round 17 on the site (5ff468a..23d3c93, newest fixes c3bea29..23d3c93).
// Intended home: site/test/explorer-refused-no-settlement-tx.test.mjs
// Run from the repo root: node --test site/test/explorer-refused-no-settlement-tx.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// c3bea29..23d3c93 makes every explorer result header read "Settlement tx {settlementTx}". head() is shared by
// renderChecklist for all four checklist samples, so the two rejected samples carry it too:
//
// - tampered: "Not charged: the payment permission expired unused ... so no money moved.",
//   "EIP-3009 authorization {authorizationNonce}, never settled";
// - unapproved: "Not charged: Celo shows the payment permission expired unused.", "no settlement for this request".
//
// SPEC §7 Outcome: `'not_charged' // chain-confirmed: authorization unused (or cancelled) after validBefore`.
// An unused authorization has no settlement transaction, so the header names a slot Celo can never fill for these
// calls, and tells a visitor a rejected, not-charged call is found from its settlement tx. The page itself says
// "A refused call usually has no settlement" (explorer.html, Recent calls).
//
// Second, renderLoading (the "Loading" preview, and the state every check passes through) shows "Checking against
// the registry" with all five checks "Checking ... Reading public Celo data", while explorer.html says "Today it
// runs the payment check. The other four are planned." and the settled sample marks those four Planned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const js = readFileSync(join(src, 'static', 'assets', 'site.js'), 'utf8');
const explorer = readFileSync(join(src, 'pages', 'explorer.html'), 'utf8').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

// The body of one STATES entry, from "key: {" to its closing "},".
const stateBody = key => js.match(new RegExp(`\\n    ${key}: \\{([\\s\\S]*?)\\n    \\},`))?.[1] ?? '';
const NOT_SETTLED = /\bnever settled\b|\bno settlement\b|\bexpired unused\b/i;

test('the rejected samples are calls that never settled (precondition)', () => {
  for (const k of ['tampered', 'unapproved']) {
    const body = stateBody(k);
    assert.ok(body, `precondition: STATES.${k} moved; re-point this test`);
    assert.match(body, /Not charged/, `precondition: STATES.${k} is no longer a not-charged sample`);
    assert.match(body, NOT_SETTLED, `precondition: STATES.${k} no longer says it never settled`);
  }
  assert.match(js, /function renderChecklist\(key\)[\s\S]*?\$\{head\(/, 'precondition: renderChecklist no longer uses head()');
});

test('a sample that never settled is not headed by a settlement transaction', () => {
  const headTpl = js.match(/const head = \([^)]*\) => `([\s\S]*?)`;/)?.[1] ?? '';
  assert.ok(headTpl, 'precondition: head() moved; re-point this test');
  const bad = ['tampered', 'unapproved']
    .filter(k => /Settlement tx/i.test(headTpl) || /Settlement tx/i.test(stateBody(k).match(/\b(?:ref|idLabel|label)\s*:\s*'([^']*)'/)?.[1] ?? ''))
    .map(k => `${k}: header "Settlement tx {settlementTx}" over rows that say "${stateBody(k).match(NOT_SETTLED)[0]}"`);
  assert.deepEqual(bad, [],
    'SPEC §7: not_charged means the authorization was never used, so there is no settlement tx to show or to look the call up by');
});

test('the loading state does not show the four planned checks as running', () => {
  assert.match(explorer, /When live, it runs the payment check\. The other four are planned\./, 'precondition: explorer.html index moved');
  const loading = js.match(/function renderLoading\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
  assert.ok(loading, 'precondition: renderLoading moved; re-point this test');
  const allFiveChecking = /\$\{NAMES\.map\(/.test(loading) && /Checking/.test(loading) && !/planned/i.test(loading);
  assert.equal(allFiveChecking, false,
    'renderLoading marks all five NAMES "Checking" against "the registry", but explorer.html says only the payment check runs today and the settled sample marks the other four Planned');
});
