// Adversary round 9 on the site (5ff468a..10bac55). Intended home: site/test/public-proof-not-published.test.mjs
// Run from the repo root: node --test site/test/public-proof-not-published.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// The site says anyone can re-check a call, with no wallet, from "the proof its gateway publishes for
// that request ID". The spec gives the gateway no such route:
//
// - SPEC §6.1, the gateway's full route table: the only route that returns a stored proof is
//   `GET /v1/results/:requestId`, which "requires `X-Attest-Payer-Sig` (recovered == row payer)" and
//   answers 404 `result_not_found` "after the 24 h retention nulls `response`".
// - SPEC §2.5: `X-Attest-Payer-Sig` is an EIP-191 personal_sign by the payer, so it needs the payer's key.
// - FLOWS §5 row 12: `/v1/results/{id}` precondition "same payer (`X-Attest-Payer-Sig`)".
// - INVARIANTS INV-10: a body is released "directly, or via `/v1/results` with a valid payer signature".
//
// So a stranger with no wallet can't get a proof from the gateway at all, and the payer can get it only
// for 24 h. A page may say the proof comes from the buyer's own record, or that re-checking needs the
// payer; it may not say the gateway publishes it to anyone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const files = dir => readdirSync(dir).flatMap(n => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : p.endsWith('.html') ? [p] : [];
});

// "the proof (the service's / its) gateway publishes" or "the proof the gateway published".
const GATEWAY_PUBLISHES = /\bproof\b[^.]{0,40}\bgateway\s+publish(es|ed)\b/i;

test('the spec route that serves proofs needs the payer (precondition)', () => {
  const spec = readFileSync(join(src, '..', '..', 'SPEC.md'), 'utf8');
  assert.match(spec, /`GET \/v1\/results\/:requestId` \| [^|]+\| requires `X-Attest-Payer-Sig` \(recovered == row payer\)/);
});

test('no page says the gateway publishes the proof for anyone to fetch', () => {
  const found = files(src).flatMap(f => {
    const raw = readFileSync(f, 'utf8');
    const meta = [...raw.matchAll(/<!--\s*description:([^>]*)-->/g)].map(m => m[1]);
    return [...meta, text(raw)].join(' ').split(/(?<=[.:])\s+/)
      .filter(s => GATEWAY_PUBLISHES.test(s))
      .map(s => `${relative(src, f)}: ${s.slice(0, 120)}`);
  });
  assert.deepEqual(found, [], 'SPEC §6.1: /v1/results needs the payer signature and keeps results 24 h; the gateway publishes no proof');
});
