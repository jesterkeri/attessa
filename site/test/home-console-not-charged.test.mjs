// Adversary round 5 on the site fixes (25e57a5..1c05ae5). Intended home: site/test/home-console-not-charged.test.mjs
// Run from the repo root: node --test site/test/home-console-not-charged.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// 1c05ae5 ("not charged" only after Celo shows the permission went unused) rewrote the home console's
// aria-label to "a tampered one is rejected, and not charged once Celo shows its permission expired
// unused". The console itself (motion.js RUNS), which types `attessa call risk.example` and prints its
// output line by line, still goes straight from the failed check to "rejected, not charged", with no
// line that waits for or reads the permission's state on Celo.
//
// - FLOWS §9 Consistency: '"Not charged" is never shown before the chain confirms it'.
// - SPEC §9 minimal guarantee: "The buyer's record never says 'not charged' until the chain confirms it."
// - FLOWS §6 J2 (the CLI output this console imitates): "Refused: ..." then "Confirming you weren't
//   charged: your payment permission expires unused at ... Waiting..." then "Not charged: confirmed on Celo".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const motion = readFileSync(join(src, 'static', 'assets', 'motion.js'), 'utf8');
const m = motion.match(/const RUNS = (\[[\s\S]*?\n {2}\]);/);
const RUNS = m ? vm.runInNewContext(m[1]) : [];
const words = l => l.slice(1).join(' ');
const CHAIN = /\b(confirm\w*|expire\w*|unused|authorizationState|waiting)\b/i;

test('the console has a run that ends "not charged" (precondition)', () => {
  assert.ok(RUNS.some(run => run.some(l => /not charged/i.test(words(l)))), 'no console run says "not charged"');
});

test('every console run that says "not charged" first shows the chain confirming it', () => {
  const bad = [];
  RUNS.forEach((run, i) => {
    const at = run.findIndex(l => /not charged/i.test(words(l)));
    if (at < 0) return;
    if (!run.slice(0, at + 1).some(l => CHAIN.test(words(l)))) bad.push(`run ${i}: ${run.map(words).join(' | ')}`);
  });
  assert.deepEqual(bad, [], 'prints "not charged" with no Celo confirmation, unlike FLOWS §6 J2 and its own aria-label');
});
