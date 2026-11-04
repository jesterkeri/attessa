// Adversary round 23 on the site (5ff468a..456ec4d). Intended home: site/test/use-cases-cli-not-built.test.mjs
// Run from the repo root: node --test site/test/use-cases-cli-not-built.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src; TASKS.md is read from SITE_SRC/../../TASKS.md or TASKS_MD)
//
// use-cases.html "Who it's for" tells buyers how they use Attessa today: "Buyer agents and their
// developers: One SDK call or one CLI command." The buyer CLI isn't built:
// - TASKS.md: "- [ ] T21 CLI per SPEC §8 ... (J0, J1, J2, J2-variant, interrupted, J3, J4)" is unticked, and
//   only a ticked task is built.
// - packages/cli/src/index.ts dispatches only `enclave build|start`, `release approve`, `endpoint add`,
//   `signer register|renew` (T15). There is no `attessa call` or `attessa init`.
// - The site's own reference marks `attessa call <url>` "Coming.", and home, how-it-works and the tutorial
//   each say the buyer commands "aren't built yet".
// The use-cases page has no such marker anywhere, so it presents a buyer CLI command as available now.
// built-state-consistent and unbuilt-commands-marked apply this rule to five other pages, not this one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const tasks = readFileSync(process.env.TASKS_MD ?? join(src, '..', '..', 'TASKS.md'), 'utf8');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const page = text(readFileSync(join(src, 'pages', 'use-cases.html'), 'utf8'));
const ref = text(readFileSync(join(src, 'pages', 'docs', 'reference.html'), 'utf8'));
const marked = /\b(coming|planned|not built|isn't built|aren't built|not yet built|not available yet|once (it's )?live|when live)\b/i;

test('the buyer CLI is not built (precondition)', () => {
  assert.match(tasks, /^- \[ \] T21 CLI per SPEC §8/m, 'TASKS.md T21 is ticked now; this test no longer applies');
  assert.match(ref, /attessa call <url> Coming\./, 'reference.html no longer marks attessa call "Coming"');
});

test('use-cases does not offer a buyer CLI command as available now', () => {
  // Every sentence on the page that offers the CLI must say it isn't built yet.
  const offers = page.split(/(?<=[.:])\s+/).filter(s => /\bCLI\b/.test(s) && !marked.test(s));
  assert.deepEqual(offers, [], 'use-cases.html offers the buyer CLI with no "Coming" / "not built" marker (TASKS.md T21 unticked)');
});
