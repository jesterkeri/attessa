// Adversary round 7 on the site fixes (edbdaa0..b7ec2de, truth pass 5ff468a..b7ec2de).
// Intended home: packages/site/test/explorer-buy-unprotected.test.mjs
// Run from the repo root: node --test packages/site/test/explorer-buy-unprotected.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// The explorer's "Unattested" sample says of a buy purchase: "Paid ... through buy, ..., which takes
// payment before the service runs. With no proof, Attessa can't protect this payment."
// "With no proof" makes the missing proof the reason the payment is unprotected, so a buy service that
// does offer a proof would be protected. The spec says a buy payment is never protected, proof or not:
// - FLOWS §3 J5: "Payment protection is **none** here; the copy says so."
// - FLOWS §8 Places, `attessa call --via buy` helper: "buy settles before the service runs. This payment
//   isn't protected; the proof check only tells you what you got."
// - FLOWS §5 row 23: a buy call with a proof can end "Verified" or "Rejected" after payment.
// The site's own pages agree with the spec: use-cases ("Attessa can only record what came back, after
// the payment"), how-to ("you pay even if the answer fails it"), terms, security, explanation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const siteJs = readFileSync(join(src, 'static', 'assets', 'site.js'), 'utf8');
const m = siteJs.match(/(const chip = name =>[\s\S]*?\n {2}const STATES = \{[\s\S]*?\n {2}\};)/);
const { STATES } = m ? vm.runInNewContext(`${m[1]}\n({ STATES });`, { copySvg: '' }) : {};
const text = v => String(typeof v === 'function' ? v() : v ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

test('the unattested sample is a buy purchase (precondition)', () => {
  assert.ok(STATES?.unattested, 'no "unattested" sample in site.js');
  assert.match(text(STATES.unattested.rows[4].line), /through buy/);
});

test('the buy payment is unprotected because buy pays first, not because no proof was offered', () => {
  const line = text(STATES.unattested.rows[4].line);
  const sentences = line.split(/(?<=\.)\s+/);
  const bad = sentences.filter(s => /\bprotect/i.test(s) && /\bno proof|without (a )?proof/i.test(s));
  assert.deepEqual(bad, [], 'FLOWS J5: "Payment protection is none here"; a proof only tells you what you got, it never protects a buy payment');
});
