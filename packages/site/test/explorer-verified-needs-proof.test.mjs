// Adversary round 12 on the site (5ff468a..34ef3e4, newest fix 34ef3e4).
// Intended home: packages/site/test/explorer-verified-needs-proof.test.mjs
// Run from the repo root: node --test packages/site/test/explorer-verified-needs-proof.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// 34ef3e4 marks the explorer's two proof checks "Planned" for a pasted settlement transaction, yet keeps
// that result's verdict as `verified` (lime-check seal) with the word "Verified on chain". The spec
// reserves "verified" for a proof that passed every check:
//
// - GLOSSARY.md: "verified | checks out | A proof passed every check against the registry".
// - SPEC §7 Outcome: `'verified' // settled + proof + inputs block checks pass`.
// - FLOWS §9 Consistency: "'Verified', 'Refused', 'Unattested', 'Settled', 'Not charged' mean the same
//   everywhere."
//
// A settlement alone cannot tell a verified call from a failed one: SPEC §7 `paid_but_rejected`
// ("settled (chain-confirmed) but a check failed") and `settled_after_refusal` both settle with the same
// AuthorizationUsed + Transfer to the registered payTo, and the registry state is the same, so the
// explorer would show "Verified on chain" for a call the buyer's SDK recorded as not checking out.
// The docs word list (docs/index.html) defines Verified as "A check passed", which is what lets it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const siteJs = readFileSync(join(src, 'static', 'assets', 'site.js'), 'utf8');
const m = siteJs.match(/(const chip = name =>[\s\S]*?\n {2}const STATES = \{[\s\S]*?\n {2}\};)/);
const { NAMES, STATES } = m ? vm.runInNewContext(`${m[1]}\n({ NAMES, STATES });`, { copySvg: '' }) : {};
const text = v => String(typeof v === 'function' ? v() : v ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

test('the explorer samples load from site.js (precondition)', () => {
  assert.ok(STATES, 'could not read STATES from site.js');
  assert.equal(NAMES.length, 5);
});

test('no explorer result says Verified unless every check, proof included, passed', () => {
  const bad = [];
  for (const [key, st] of Object.entries(STATES)) {
    if (st.verdict !== 'verified' && !/\bverified\b/i.test(st.word)) continue;
    st.rows.forEach((r, i) => {
      if (r.s !== 'pass') bad.push(`${key} ("${st.word}", data-verdict="${st.verdict}"): "${NAMES[i]}" is ${r.w ?? r.s}: ${text(r.line)}`);
    });
  }
  assert.deepEqual(bad, [],
    'GLOSSARY "verified": "A proof passed every check against the registry"; SPEC §7 verified = settled + proof + inputs block checks pass');
});

test('the docs word list defines Verified as a proof passing every check, not "a check passed"', () => {
  const docs = readFileSync(join(src, 'pages', 'docs', 'index.html'), 'utf8');
  const row = docs.match(/<tr><td>Verified<\/td><td>([\s\S]*?)<\/td><\/tr>/);
  assert.ok(row, 'the Verified row moved; re-point this test');
  const t = text(row[1]);
  assert.ok(/\bproof\b/i.test(t) && /\b(every|all)\b/i.test(t),
    `docs/index.html defines Verified as "${t}"; GLOSSARY: "A proof passed every check against the registry"`);
});
