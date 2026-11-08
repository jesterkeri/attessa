// Adversary round 7 on the site fixes (edbdaa0..b7ec2de, truth pass 5ff468a..b7ec2de).
// Intended home: packages/site/test/unbuilt-commands-marked.test.mjs
// Run from the repo root: node --test packages/site/test/unbuilt-commands-marked.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// The truth pass marks every unbuilt command "Coming" on the reference, how-to, tutorial and home page
// (TASKS.md: T21 CLI in progress; T21a `attessa verify` and T21b MCP not built). Two pages still offer
// unbuilt commands as working today, with no marker anywhere on the page:
//
// - explorer.html <noscript>: "You can run the same check with `attessa verify <requestId>`."
//   TASKS.md T21a is unchecked; reference.html says "attessa verify <requestId> Coming."
// - how-it-works.html: "Here is each step, with the line the CLI prints for it.", then walks through
//   `attessa call` (T21, in progress) and `attessa agent register`, which how-to.html says
//   "isn't built yet; the other five commands are".
// built-state-consistent.test.mjs covers index, how-to and tutorial with the same rule; these two
// pages were left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const page = p => readFileSync(join(src, 'pages', p), 'utf8');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
const marked = /\b(coming|not built|isn't built|aren't built|not yet built|not available yet)\b/i;

// T21 is ticked, so `attessa agent register` and `attessa call` are built (the reference no longer marks them). `attessa verify` (T21a) is
// built too, so no page may still call it unbuilt.
test('the reference marks verify and agent register as built (precondition)', () => {
  const ref = text(page('docs/reference.html'));
  assert.doesNotMatch(ref, /attessa verify <requestId> Coming/);
  assert.doesNotMatch(ref, /attessa agent register Coming/);
  assert.doesNotMatch(text(page('docs/how-to.html')), /attessa agent register isn't built yet/);
});

test('how-it-works offers attessa init, attessa call and attessa agent register as built, with no "not built" marker', () => {
  const t = text(page('how-it-works.html'));
  assert.match(t, /attessa agent register/);
  assert.match(t, /attessa init and attessa call/);
  assert.doesNotMatch(t, /\b(coming|isn't built|aren't built|not yet built)\b/i, 'how-it-works.html marks a built command as unbuilt');
});

test('explorer.html offers attessa verify as built', () => {
  const t = text(page('explorer.html'));
  assert.match(t, /You can run the same check with attessa verify <requestId>/, 'explorer.html no longer offers it');
  assert.doesNotMatch(t, /attessa verify <requestId> ?\. Coming|It isn't built yet/, 'explorer.html still calls attessa verify unbuilt');
});
