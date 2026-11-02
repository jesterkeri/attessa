// Adversary round 13 on the site (5ff468a..2fa3f16, newest fix 34ef3e4..2fa3f16).
// Intended home: site/test/home-verified-not-on-celo.test.mjs
// Run from the repo root: node --test site/test/home-verified-not-on-celo.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// Round 12 stopped the explorer calling a pasted settlement "Verified": Celo shows the payment, and a
// payment alone can't tell a verified call from one whose check failed. The explorer now says so:
// "That isn't a verified call". The homepage's "Three ways a call can end" still says the opposite.
// Its lede says "Two of them you can check on Celo yourself", and the two it means are the beats with
// a Celo record: "Verified and paid" ("Its record is the settlement transaction on Celo", with a
// Celoscan link) and "Tampered and refused". So it offers the verified outcome as one you can check on
// Celo yourself.
//
// - SPEC §7 Outcome: `'verified' // settled + proof + inputs block checks pass`, while
//   `'paid_but_rejected' // settled (chain-confirmed) but a check failed` and `settled_after_refusal`
//   settle the same way, so the settlement transaction is the same for all three.
// - GLOSSARY.md: "verified | checks out | A proof passed every check against the registry".
// - GLOSSARY.md: "evidence | record | The buyer's append-only JSONL of every call". A verified call's
//   record is the buyer's evidence row (SPEC §7 Evidence row; SPEC §9 "Every outcome is in evidence"),
//   not the settlement transaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const home = readFileSync(join(src, 'pages', 'index.html'), 'utf8');
const text = s => s.replace(/<[^>]*>/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ').replace(/\s+/g, ' ').trim();
const WORDS = { one: 1, two: 2, three: 3 };

const sec = home.match(/<section[^>]*data-scene-sec="outcomes"[\s\S]*?<\/section>/)?.[0] ?? '';
const lede = text(sec.match(/<p class="sec-lede"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '');
const beats = [...sec.matchAll(/<li class="beat[^"]*" data-beat>([\s\S]*?)<\/li>/g)].map(m => ({
  title: text(m[1].match(/<h3>([\s\S]*?)<\/h3>/)?.[1] ?? ''),
  body: text(m[1]),
}));

test('the homepage outcomes section loads (precondition)', () => {
  assert.ok(sec, 'the outcomes section moved; re-point this test');
  assert.equal(beats.length, 3);
  assert.ok(beats.some(b => /verified/i.test(b.title)), 'no "Verified" outcome beat');
});

test('the homepage does not offer the verified outcome as one you can check on Celo yourself', () => {
  const said = lede.match(/\b(\w+) of them you can check on Celo/i);
  // The beats that point at Celo for their outcome, leaving out the one that says it leaves no record there.
  const onCelo = beats.filter(b => /\bon Celo\b/.test(b.body) && !/no record on Celo/.test(b.body));
  const bad = [];
  if (said && WORDS[said[1].toLowerCase()] === onCelo.length) {
    onCelo.filter(b => /verified/i.test(b.title)).forEach(b =>
      bad.push(`lede "${said[0]}" counts "${b.title}": ${b.body}`));
  }
  beats.filter(b => /verified/i.test(b.title)).forEach(b => {
    if (/record is the settlement transaction/i.test(b.body)) bad.push(`"${b.title}" says its record is the settlement transaction`);
  });
  assert.deepEqual(bad, [],
    "SPEC §7: verified = settled + proof + inputs block checks pass, and paid_but_rejected settles too, so Celo alone can't show a call was verified (the explorer itself says \"That isn't a verified call\"); GLOSSARY: record = the buyer's evidence JSONL");
});
