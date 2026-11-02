// Adversary round 14 on the site (5ff468a..0271566, newest fix 2fa3f16..0271566).
// Intended home: site/test/explorer-payto-not-one-endpoint.test.mjs
// Run from the repo root: node --test site/test/explorer-payto-not-one-endpoint.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// 0271566 has the explorer read a settlement tx (payer, payTo, amount, block) and then name "the endpoint
// registered to the address it paid" and list "that endpoint's approved builds and signers". The
// registry has no such endpoint to name. payTo is a field of an endpoint, not a key, and nothing makes it
// unique:
//
// - SPEC §3.2: `mapping(bytes32 => Endpoint) private _endpoints;` is keyed by originHash only; there is
//   no map from payTo to an endpoint.
// - SPEC §3.4 addEndpoint: "non-zero payTo and operator (`ZeroAddress`)" is the only payTo rule; INV-6
//   pins one endpoint per originHash, never one per payTo.
// - FLOWS.md §1: buy "resells 170 paid APIs under one payment address (`payTo`)"; FLOWS relationships:
//   an endpoint "receives 0..n (its payTo)", so one address can be the payTo of many endpoints.
// - KNOWN-LIMITS L17: ERC-8004 registration is permissionless, and THREAT-MODEL (Agent owner) "can add
//   endpoints with their own payTo". Nothing stops any stranger's agent adding an endpoint whose payTo is
//   a real seller's address, with the stranger's own approved builds and signers.
//
// So a payment to an address can't be pinned to one endpoint, and "that endpoint's approved builds" may
// be a stranger's builds. The registry can list every endpoint whose payTo is that address; the site must
// not present one of them as the endpoint that was paid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const explorer = readFileSync(join(src, 'pages', 'explorer.html'), 'utf8');
const js = readFileSync(join(src, 'static', 'assets', 'site.js'), 'utf8');
const text = h => h.replace(/\$\{[^}]*\}/g, ' X ').replace(/<[^>]*>/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ').replace(/\s+/g, ' ').trim();

// One endpoint named as the one a payment address belongs to.
const SINGULAR = [
  /\bthe endpoint (registered to|paid at|registered at|behind) (the|this|that) address\b/i,
  /\bthat endpoint('s)?\b/i,
  /\bthe endpoint it paid\b/i,
];

const lede = text(explorer.match(/<p class="lede"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '');
// The settled sample: the two on-Celo rows and the settled state, up to the next state.
const settledSrc = js.match(/const buildChain[\s\S]*?\n\s*tampered:/)?.[0] ?? '';
const settledStrings = [...settledSrc.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map(m => text(m[2])).filter(s => s.length > 30);

test('the explorer settled sample loads (precondition)', () => {
  assert.match(lede, /settlement transaction/);
  assert.ok(settledSrc.includes("chip('payTo')"), 'the settled sample no longer names payTo; re-point this test');
  assert.ok(settledStrings.length >= 3, 'the settled strings moved; re-point this test');
});

test('the explorer does not tie a paid address to one endpoint and its builds', () => {
  const bad = [];
  for (const [where, s] of [['explorer.html lede', lede], ...settledStrings.map(s => ['site.js settled sample', s])]) {
    for (const re of SINGULAR) {
      const m = s.match(re);
      if (m) bad.push(`${where}: "${m[0]}" in "${s}"`);
    }
  }
  assert.deepEqual(bad, [],
    'SPEC §3.2 keys endpoints by originHash only and §3.4 addEndpoint puts no uniqueness on payTo (FLOWS: buy sells 170 APIs under one payTo; L17: anyone can add an endpoint with any payTo), so a settlement names an address, not an endpoint');
});

test('the Recent calls feed, read from Celo events, does not give each settlement one endpoint', () => {
  const sec = explorer.match(/<section class="feed-sec"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.match(text(sec), /read from Celo events/, 'precondition: the feed says it reads Celo events');
  const perRow = (sec.match(/data-label="Endpoint">\[\[slot:endpointOrigin\]\]/g) ?? []).length;
  assert.equal(perRow, 0,
    `${perRow} feed rows show one endpoint origin per settlement read from Celo events; a settlement carries only payer, payTo, amount and nonce, and SPEC §3.2/§3.4 let many endpoints share a payTo`);
});
