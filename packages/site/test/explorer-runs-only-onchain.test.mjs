// Adversary round 11 on the site (5ff468a..fba61c1, newest fixes bca73cb..fba61c1).
// Intended home: packages/site/test/explorer-runs-only-onchain.test.mjs
// Run from the repo root: node --test packages/site/test/explorer-runs-only-onchain.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// The explorer takes a settlement transaction and reads public Celo data. From that, the spec gives it
// the payment and the registry, nothing that ties the settlement to a proof:
//
// - SPEC §3.3: no registry event carries a requestHash, responseHash, inputsHash or proof; the proof is
//   only ever an argument to the view `verifyProof`, never stored.
// - SPEC §6.1: the only route that returns a stored proof, `GET /v1/results/:requestId`, "requires
//   `X-Attest-Payer-Sig` (recovered == row payer)".
// - SPEC §7: `'verified'` is "settled + proof + inputs block checks pass", so a verdict of Verified needs
//   the proof checks the explorer cannot run.
//
// The site says so in two places: explorer.html "Planned: looking a call up by its request ID and
// checking its proof", and index.html "Planned: the rest of the five checks the buyer's agent ran".
// Yet explorer.html still lists "The five checks it runs", including "This exact request and answer
// (signed hashes)" and "Real Celo data (block read)", with no "Planned", and its "Recent calls" feed,
// "read from Celo events", labels each settlement "Verified".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const page = p => readFileSync(join(src, 'pages', p), 'utf8');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const planned = /\b(planned|coming|not yet|not built)\b/i;
const explorer = page('explorer.html');

test('the site says proof checks are Planned for the explorer (precondition)', () => {
  assert.match(text(explorer), /Planned: looking a call up by its request ID and checking its proof/);
  assert.match(text(page('index.html')), /Planned: the rest of the five checks the buyer's agent ran/);
});

test('the explorer does not list the proof checks as checks it runs today', () => {
  const block = explorer.match(/<p class="label">The five checks it runs<\/p>[\s\S]*?<\/ol>/);
  assert.ok(block, 'the "checks it runs" list moved; re-point this test');
  const t = text(block[0]);
  const proofChecks = ['This exact request and answer', 'Real Celo data'].filter(c => t.includes(c));
  assert.ok(proofChecks.length === 0 || planned.test(t),
    `explorer.html says "${t}" with no Planned label, but the same page and index.html call checking the proof Planned, and SPEC §3.3 puts no request, answer or inputs hash on Celo`);
});

test('the Recent calls feed, read from Celo events, does not label a settlement Verified', () => {
  const sec = explorer.match(/<section class="feed-sec"[\s\S]*?<\/section>/)[0];
  assert.match(text(sec), /read from Celo events/, 'precondition: the feed says it reads Celo events');
  const verified = (sec.match(/data-verdict="verified"/g) ?? []).length;
  assert.equal(verified, 0,
    `${verified} feed rows say Verified from Celo events alone; SPEC §7 "verified" needs the proof and inputs block checks, which SPEC §3.3 events cannot supply`);
});
