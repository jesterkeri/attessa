// Adversary round 35 on the site (5ff468a..71564ac). Intended home: packages/site/test/tamper-after-signing-can-settle.test.mjs
// Run from the repo root: node --test packages/site/test/tamper-after-signing-can-settle.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src; THREAT-MODEL.md, GLOSSARY.md, KNOWN-LIMITS.md and SPEC.md are read from SITE_SRC/../..)
//
// The explanation page's threat table ("Who could cheat, and what stops them") answers
// "Edit an answer after signing" with "The call is rejected and nothing settles", and the use-cases
// payment-risk card says an answer "changed after the sealed machine signed it" is refused by the
// gateway "without using the agent's payment permission". That holds only when the edit happens
// before the gateway. The gateway itself sits after the signature and is the party that settles:
//   THREAT-MODEL.md §3: "| TB1 | **T**ampering: the gateway alters the request or response |
//     requestHash and responseHash are inside the signed proof; the SDK recomputes both (V10) |"
//   SPEC.md §7 V9: "200 → V11 then V10", so that recomputation runs after settlement, and fails as
//     `paid_but_rejected{check}`.
//   GLOSSARY.md: "| paid but rejected | charged but didn't check out | Settled, yet the SDK's
//     independent check failed: a gateway fault |"
//   KNOWN-LIMITS.md L1: "In the demo the gateway operator is also the seller".
// So an edit after signing by the gateway (in the demo, the seller) settles and the buyer is
// charged; "nothing settles" promises a money outcome the spec says the design does not give.
// A row or card that says nothing settles must also say what happens when the gateway made the edit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const repo = join(src, '..', '..', '..');
const threat = readFileSync(join(repo, 'THREAT-MODEL.md'), 'utf8');
const glossary = readFileSync(join(repo, 'GLOSSARY.md'), 'utf8');
const limits = readFileSync(join(repo, 'KNOWN-LIMITS.md'), 'utf8');
const spec = readFileSync(join(repo, 'SPEC.md'), 'utf8');

const text = h => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim();

// Says the buyer's money stays put: nothing settles, or the permission is not used.
const NO_SETTLE = /\bnothing (settles|is settled|was settled)\b|\bnever settles\b|\bwithout using\b[^.]*\bpermission\b|\bdoesn'?t settle\b|\bisn'?t settled\b/i;
// Names the case where the gateway made the edit and still settled.
const GATEWAY_CASE = /\bpaid[ _]but[ _]rejected\b|\bgateway itself\b|\bif the gateway (edits|changes|alters)\b|\bcharged\b|\bafter (it|the gateway) settles\b/i;

test('the spec says the gateway can alter a signed answer and still settle (precondition)', () => {
  assert.match(threat, /\*\*T\*\*ampering: the gateway alters the request or response \| requestHash and responseHash are inside the signed proof; the SDK recomputes both \(V10\)/);
  assert.match(spec, /200 → V11 then V10/);
  assert.match(glossary, /\| paid but rejected \| charged but didn't check out \| Settled, yet the SDK's independent check failed: a gateway fault \|/);
  assert.match(limits, /\| L1 \| In the demo the gateway operator is also the seller/);
});

test('explanation threat row for an edit after signing does not promise that nothing settles', () => {
  const page = readFileSync(join(src, 'pages', 'docs', 'explanation.html'), 'utf8');
  const rows = [...page.matchAll(/<tr><td>([\s\S]*?)<\/td><td>([\s\S]*?)<\/td><\/tr>/g)].map(m => ({ attack: text(m[1]), outcome: text(m[2]) }));
  const edit = rows.filter(r => /\b(edit|change|alter|tamper)\w*\b/i.test(r.attack) && /\banswer\b/i.test(r.attack));
  assert.equal(edit.length, 1, `expected one threat row about editing an answer, found ${edit.length}`);
  const wrong = edit.filter(r => NO_SETTLE.test(r.outcome) && !GATEWAY_CASE.test(r.outcome));
  assert.deepEqual(wrong.map(r => `${r.attack}: ${r.outcome}`), [],
    'THREAT-MODEL TB1: when the gateway alters the response, the SDK catches it after settlement (paid but rejected)');
});

test('use-cases card for an answer changed after signing does not promise the permission is unused', () => {
  const page = readFileSync(join(src, 'pages', 'use-cases.html'), 'utf8');
  const sentences = text(page).split(/(?<=[.!?])\s+/);
  const changed = sentences.filter(s => /\b(changed|edited|altered|tampered)\b[^.]*\bafter\b[^.]*\bsigned\b/i.test(s));
  assert.ok(changed.length >= 1, 'no use-cases sentence about an answer changed after signing (precondition)');
  const wrong = changed.filter(s => NO_SETTLE.test(s) && !GATEWAY_CASE.test(s));
  assert.deepEqual(wrong, [],
    'THREAT-MODEL TB1: when the gateway alters the response, the SDK catches it after settlement (paid but rejected)');
});
