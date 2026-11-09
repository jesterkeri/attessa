// Adversary round 10 on the site (5ff468a..bca73cb, newest fixes 10bac55..bca73cb).
// Intended home: packages/site/test/request-id-lookup-planned.test.mjs
// Run from the repo root: node --test packages/site/test/request-id-lookup-planned.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// Round 10 labels request-ID lookup "Planned" on the explorer, because no public source can answer it:
//
// - SPEC §3.3: no registry event carries a requestId, and SPEC §7 V8 makes the EIP-3009 nonce 32 random
//   bytes, so nothing on Celo links a request ID to a call.
// - SPEC §6.1: the only gateway route keyed by request ID, `GET /v1/results/:requestId`, "requires
//   `X-Attest-Payer-Sig` (recovered == row payer)" and serves only `settled`, `delivered`,
//   `delivery_failed` rows. A refused call (`exec_failed`, `proof_rejected`, `too_late`, `settle_failed`)
//   answers 404 even to its payer.
//
// Three places still send a visitor to look a call up by request ID today, with no "Planned" label:
// - index.html CTA: "Paste a request ID into the explorer, or wire the check into your agent."
// - explorer.html Recent calls: "A refused call usually has no settlement ...: paste its request ID above
//   instead." (the one call type that has neither a chain record by request ID nor a /v1/results row)
// - site.js "No call found": "Nothing on <network> matches <requestId> ... The gateway keeps results by
//   request ID for 24 hours", which says the explorer searched Celo and the gateway by request ID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\$\{[^}]*\}/g, 'X').replace(/\s+/g, ' ').trim();
const files = dir => readdirSync(dir).flatMap(n => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.(html|js)$/.test(p) ? [p] : [];
});
const sentences = f => text(readFileSync(f, 'utf8')).split(/(?<=[.:;!?])\s+/);
const planned = /\bplanned\b/i;

test('the explorer labels request-ID lookup Planned, and the spec route needs the payer (precondition)', () => {
  assert.match(text(readFileSync(join(src, 'pages', 'explorer.html'), 'utf8')), /Planned: looking a call up by its request ID/);
  const spec = readFileSync(join(src, '..', '..', '..', 'SPEC.md'), 'utf8');
  assert.match(spec, /`GET \/v1\/results\/:requestId` \| [^|]+\| requires `X-Attest-Payer-Sig` \(recovered == row payer\)\. Serves rows in `settled`, `delivered`, `delivery_failed`/);
});

test('no page tells a visitor to look a call up by request ID today', () => {
  // "Paste a request ID ..." / "paste its request ID ..." where the request ID is the thing to paste,
  // not one of two accepted inputs ("a request ID or a settlement transaction").
  const PASTE_ID = /\bpaste (a|its|the|your|a call's) request ID\b(?! or\b)/i;
  const found = files(src).flatMap(f => sentences(f)
    .filter(s => PASTE_ID.test(s) && !planned.test(s))
    .map(s => `${relative(src, f)}: ${s.slice(0, 140)}`));
  assert.deepEqual(found, [], 'explorer.html: request-ID lookup is "Planned"; SPEC §3.3 puts no requestId on Celo and SPEC §6.1 /v1/results needs the payer signature');
});

test('the explorer does not say it searched by request ID or the gateway serves it by request ID', () => {
  const GATEWAY_BY_ID = /\bgateway\b[^.;]{0,40}\b(keeps|stores|holds|serves)\b[^.;]{0,40}\bby request ID\b/i;
  const found = files(src).flatMap(f => sentences(f)
    .filter(s => GATEWAY_BY_ID.test(s) && !planned.test(s))
    .map(s => `${relative(src, f)}: ${s.slice(0, 140)}`));
  assert.deepEqual(found, [], 'SPEC §6.1: /v1/results serves a stored result only to the payer (X-Attest-Payer-Sig), never to the explorer');
});
