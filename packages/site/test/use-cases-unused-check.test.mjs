// Adversary round 5 on the site fixes (25e57a5..1c05ae5). Intended home: packages/site/test/use-cases-unused-check.test.mjs
// Run from the repo root: node --test packages/site/test/use-cases-unused-check.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// Round 4 (reference-confirm-not-charged.test.mjs) caught "the SDK confirms on Celo that you weren't
// charged": it states the chain check's result before it runs. 1c05ae5 rewrote use-cases.html to the
// same shape: "the gateway refuses it without using the agent's payment permission, ... and Attessa
// checks on Celo that the permission went unused". "Checks that X" asserts X, and SPEC lets X be false
// or never be checked:
//
// - SPEC §7 "refused / uncertain -> final": authorizationState true + tx found + no result on a refused
//   call -> settled_after_refusal (SPEC §9 ext 11b).
// - SPEC §8 `attessa call ... [--no-wait]`: "waits to confirm not-charged unless --no-wait"; SPEC §7
//   `waitForExpiry` (default true).
// The same commit's how-it-works step 07 words it as a question: "checks on Celo whether it was used".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const read = p => readFileSync(join(src, ...p.split('/')), 'utf8');

// "checks/confirms (on Celo) that ... unused / not charged / wasn't used": the result stated in advance.
const PRESUPPOSED = /\b(check|confirm)\w*\s+(on Celo\s+)?that\b[^.]*\b(unused|not charged|weren't charged|wasn't used|never used)\b/i;

test('how-it-works words the same check as a question (precondition)', () => {
  assert.match(text(read('pages/how-it-works.html')), /checks on Celo whether it was used/);
});

test('use-cases does not state the result of the Celo check before it runs', () => {
  const found = text(read('pages/use-cases.html')).split(/(?<=\.)\s+/).filter(s => PRESUPPOSED.test(s));
  assert.deepEqual(found, [], 'presupposes the permission went unused; settled_after_refusal and --no-wait say otherwise');
});
