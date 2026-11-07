// Adversary round 36 on the site (5ff468a..7353516). Intended home: packages/site/test/home-tamper-gateway-can-settle.test.mjs
// Run from the repo root: node --test packages/site/test/home-tamper-gateway-can-settle.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src; THREAT-MODEL.md, GLOSSARY.md, KNOWN-LIMITS.md and SPEC.md are read from SITE_SRC/../..)
//
// 7353516 fixed the explanation threat row and the use-cases card so that an answer edited after
// signing is refused before settlement only when the edit is upstream of the gateway, and a gateway
// that makes the edit can still settle (paid_but_rejected). The home page's step list, which explains
// the product in general (not one demo run), still says without condition:
//   "The gateway won't settle a tampered answer."
//   "If the answer doesn't match what was signed, the gateway refuses to settle. The permission
//    expires unused, and once Celo shows that, you're not charged."
// The spec says the gateway is itself a party that can tamper, and that it settles before the SDK's
// own check runs:
//   THREAT-MODEL.md §3: "| TB1 | **T**ampering: the gateway alters the request or response |
//     requestHash and responseHash are inside the signed proof; the SDK recomputes both (V10) |"
//   SPEC.md §7 V9: "200 → V11 then V10", and V10 fails as `paid_but_rejected{check}`.
//   GLOSSARY.md: "| paid but rejected | charged but didn't check out | Settled, yet the SDK's
//     independent check failed: a gateway fault |"
//   KNOWN-LIMITS.md L1: "In the demo the gateway operator is also the seller".
// So "you're not charged" for every tampered answer promises a money outcome the design does not give.
// The demo-outcome card ("These are the three outcomes in the demo") describes one run and is out of scope.
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
const home = readFileSync(join(src, 'pages', 'index.html'), 'utf8');

const text = h => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim();

// Says the buyer's money stays put for a tampered answer.
const NO_SETTLE = /\bwon'?t settle\b|\brefuses to settle\b|\bdoesn'?t settle\b|\bnothing settles\b|\bnever settles\b|\bnot charged\b|\bexpires unused\b/i;
// Names the case where the gateway made the edit and still settled.
const GATEWAY_CASE = /\bpaid[ _]but[ _]rejected\b|\bgateway itself\b|\bif the gateway (edits|changes|alters|made|makes)\b|\bhonest gateway\b|\bsettled[ _]after[ _]refusal\b/i;

test('the spec says the gateway can alter a signed answer and still settle (precondition)', () => {
  assert.match(threat, /\*\*T\*\*ampering: the gateway alters the request or response \| requestHash and responseHash are inside the signed proof; the SDK recomputes both \(V10\)/);
  assert.match(spec, /200 → V11 then V10/);
  assert.match(glossary, /\| paid but rejected \| charged but didn't check out \| Settled, yet the SDK's independent check failed: a gateway fault \|/);
  assert.match(limits, /\| L1 \| In the demo the gateway operator is also the seller/);
});

test('home step about a tampered answer does not promise the buyer is never charged', () => {
  const steps = [...home.matchAll(/<li data-step>([\s\S]*?)<\/li>/g)].map(m => text(m[1]));
  const tamper = steps.filter(s => /\b(tamper\w*|edited|altered|changed)\b|doesn'?t match what was signed/i.test(s));
  assert.ok(tamper.length >= 1, 'no home step about a tampered answer (precondition)');
  const wrong = tamper.filter(s => NO_SETTLE.test(s) && !GATEWAY_CASE.test(s));
  assert.deepEqual(wrong, [],
    'THREAT-MODEL TB1: when the gateway alters the response, it can settle and the SDK reports paid_but_rejected');
});
