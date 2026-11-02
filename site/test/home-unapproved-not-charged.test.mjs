// Adversary round 8 on the site fixes (b7ec2de..4936092, truth pass 5ff468a..4936092).
// Intended home: site/test/home-unapproved-not-charged.test.mjs
// Run from the repo root: node --test site/test/home-unapproved-not-charged.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// The truth pass rewrote the home page's "Unapproved build" outcome to: "the registry refuses to register
// its key and it can't sell a single call. The demo shows this on a local copy of Celo, so it leaves no
// record on Celo." Nothing is ever signed, so there is no payment permission whose state Celo could
// confirm. Its outcome track still ends in the same "Not charged" pill as the tampered call, which is
// confirmed on Celo.
//
// - GLOSSARY.md "not charged": "Chain-confirmed: `authorizationState == false` at a block past
//   validBefore + 5, or a confirmed cancel. Never asserted earlier".
// - FLOWS §9 Consistency: '"Not charged" mean[s] the same everywhere. "Not charged" is never shown
//   before the chain confirms it'.
// - FLOWS §7 / SPEC §7 Outcome: a call that stops with nothing signed is `stopped`, not `not_charged`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const src = process.env.SITE_SRC ?? join(here, '..', 'src');
const build = readFileSync(join(src, '..', 'build.mjs'), 'utf8');
const home = readFileSync(join(src, 'pages', 'index.html'), 'utf8');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// Render the outcome track with build.mjs's own code, so a new end state (for example one for
// "nothing signed") is read as the page would show it.
const code = ['TRACK_LABELS', 'NODE_ICON'].map(n => build.match(new RegExp(`const ${n} = [^\\n]+`))?.[0]).join('\n')
  + '\n' + (build.match(/function track\(spec\) \{[\s\S]*?\n\}/)?.[0] ?? '');
const track = vm.runInNewContext(`${code}\ntrack`, { icon: () => '' });

const beats = [...home.matchAll(/<li class="beat"[^>]*>([\s\S]*?)<\/li>\s*(?=<li class="beat"|<\/ol>)/g)].map(m => {
  const spec = m[1].match(/\{\{track:([a-z ]+)\}\}/)?.[1];
  return { title: text(m[1].match(/<h3>([\s\S]*?)<\/h3>/)?.[1] ?? ''), prose: text(m[1].replace(/\{\{track:[^}]*\}\}/, '')), end: spec ? text(track(spec)).replace(/^Build Machine Request Celo data /, '') : '' };
});

test('the home page lists an "Unapproved build" outcome that signs nothing and leaves no record on Celo (precondition)', () => {
  const b = beats.find(x => x.title === 'Unapproved build');
  assert.ok(b, 'no "Unapproved build" outcome on the home page');
  assert.match(b.prose, /can't sell a single call|leaves no record on Celo/);
});

test('an outcome ends "Not charged" only where Celo can confirm an unused payment permission', () => {
  const bad = beats
    .filter(b => /not charged/i.test(b.end))
    .filter(b => !/expires? unused|authorizationState|confirmed on Celo/i.test(b.prose) || /no record on Celo|can't sell a single call/i.test(b.prose))
    .map(b => `${b.title}: "${b.prose}" ends in "${b.end}"`);
  assert.deepEqual(bad, [], 'shows "Not charged" for an outcome where nothing was signed and Celo holds no record (GLOSSARY: chain-confirmed, never asserted earlier)');
});
