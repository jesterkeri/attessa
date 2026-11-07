// Adversary round 37 on the site (5ff468a..5b8e32e). Intended home: packages/site/test/explanation-swap-owner-can-approve.test.mjs
// Run from the repo root: node --test packages/site/test/explanation-swap-owner-can-approve.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src; SPEC.md and THREAT-MODEL.md are read from SITE_SRC/../..)
//
// The explanation page's threat table ("Who could cheat, and what stops them.") answers
//   "Swap in different code" with
//   "The sealed machine's measurements no longer match the approved build, so its key can't be
//    registered and its proofs are rejected."
// with no exception. The spec says the agent's owner (the seller, or whoever holds the owner key)
// can approve any build, so a swap the owner approves is registered and its proofs pass:
//   SPEC.md §1 trust table: "| Agent owner key | approving releases and endpoints | can approve any
//     build and claim any `sourceRef` ..."
//   THREAT-MODEL.md §2, Agent owner: "Can approve a malicious build and add endpoints with their own
//     payTo/operator."
// The buyer pins no release (SPEC §7 has no release option; V7 and V10 accept any approved release
// of the endpoint's agent), so the row promises a protection the design does not give against the owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const repo = join(src, '..', '..', '..');
const spec = readFileSync(join(repo, 'SPEC.md'), 'utf8');
const threat = readFileSync(join(repo, 'THREAT-MODEL.md'), 'utf8');
const page = readFileSync(join(src, 'pages', 'docs', 'explanation.html'), 'utf8');

const text = h => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim();

test('premise: the spec lets the agent owner approve any build', () => {
  assert.match(spec, /\| Agent owner key \| approving releases and endpoints \| can approve any build/);
  assert.match(threat, /Can approve a malicious build/);
});

test('explanation: the "swap in different code" row names the owner who can approve the swapped build', () => {
  const rows = [...page.matchAll(/<tr>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/g)]
    .map(m => [text(m[1]), text(m[2])]);
  const swap = rows.find(([who]) => /swap|different code|other code/i.test(who));
  assert.ok(swap, 'explanation.html has a threat row about swapping in different code');
  const [, outcome] = swap;
  // Fix-agnostic: the outcome must admit the owner case (the agent's owner can approve the new
  // build, and then its key registers and its proofs pass), in whatever words.
  assert.match(outcome, /owner[\s\S]*approv|approv[\s\S]*owner/i,
    `the row promises a swap is always rejected, but SPEC §1 says the agent owner "can approve any build": ${JSON.stringify(outcome)}`);
});
