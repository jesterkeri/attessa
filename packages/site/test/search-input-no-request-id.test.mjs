// Adversary round 16 on the site (5ff468a..c3bea29, newest fixes 807708a..c3bea29).
// Intended home: packages/site/test/search-input-no-request-id.test.mjs
// Run from the repo root: node --test packages/site/test/search-input-no-request-id.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// explorer.html labels request-ID lookup "Planned" ("Planned: looking a call up by its request ID ..."), because
// no public source can answer it: SPEC §3.3 puts no requestId in any registry event, SPEC §7 V8 makes the
// EIP-3009 nonce 32 random bytes, and SPEC §6.1 `GET /v1/results/:requestId` "requires `X-Attest-Payer-Sig`
// (recovered == row payer)". Round 16 changed the explorer placeholder to "Settlement tx" for that reason.
//
// The search boxes and their validation still ask for a request ID as an input that works today:
// - index.html home search (posts to explorer.html?q=): label "Request ID or settlement transaction",
//   placeholder "Request ID or settlement tx";
// - explorer.html label: "Paste a request ID or a settlement transaction";
// - site.js field error: "Paste a request ID or a settlement transaction first." and
//   "That isn't a request ID or a transaction hash".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const files = (dir, ext) => readdirSync(dir).flatMap(n => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p, ext) : p.endsWith(ext) ? [p] : [];
});
const REQ_ID = /\brequest ID\b/i;

test('precondition: the explorer labels request-ID lookup Planned', () => {
  const ex = readFileSync(join(src, 'pages', 'explorer.html'), 'utf8').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  assert.match(ex, /Planned: looking a call up by its request ID/);
});

test('no search box asks for a request ID (label or placeholder)', () => {
  const found = files(join(src, 'pages'), '.html').flatMap(f => {
    const h = readFileSync(f, 'utf8');
    return [...h.matchAll(/<form\b[^>]*role="search"[^>]*>([\s\S]*?)<\/form>/g)].flatMap(([, body]) => [
      ...[...body.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)].map(m => `label "${m[1].trim()}"`),
      ...[...body.matchAll(/\bplaceholder="([^"]*)"/g)].map(m => `placeholder "${m[1]}"`),
    ].filter(s => REQ_ID.test(s)).map(s => `${relative(src, f)}: ${s}`));
  });
  assert.deepEqual(found, [], 'explorer.html: request-ID lookup is "Planned"; SPEC §3.3 puts no requestId on Celo and SPEC §6.1 /v1/results needs the payer signature');
});

test('the explorer validation does not ask for a request ID', () => {
  const js = readFileSync(join(src, 'static', 'assets', 'site.js'), 'utf8');
  const found = [...js.matchAll(/["'`]([^"'`]*\b(?:paste|isn't) a request ID or [^"'`]*)["'`]/gi)].map(m => m[1]);
  assert.deepEqual(found, [], 'the explorer accepts only a settlement tx today; request-ID lookup is "Planned" (SPEC §3.3, §6.1)');
});
