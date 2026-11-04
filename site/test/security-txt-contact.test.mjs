// Adversary round 27 on the site (5ff468a..34c8c07, newest fix 34c8c07).
// Intended home: site/test/security-txt-contact.test.mjs
// Run from the repo root: node --test site/test/security-txt-contact.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// security.html "Report a problem" says, with no Coming / placeholder marker: "Security contacts are in
// /.well-known/security.txt", and the footer on every page links security.txt. The file the build copies
// to dist (src/static/.well-known/security.txt) holds only template placeholders:
//   Contact: {securityContact}
//   Expires: {securityTxtExpires}
// so a visitor who follows the page to report a vulnerability finds no contact at all. PREFLIGHT.md:35
// still has "`/.well-known/security.txt` published with a contact" unticked, and site/README.md says the
// file "has placeholder fields". RFC 9116 requires a Contact URI (mailto:, https: or tel:) and an Expires
// date. Either fix passes: a real contact in the file, or a page that marks the contacts as not yet published.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const notYet = /\b(coming|planned|placeholder|not (yet )?published|before launch|once live|when live|draft)\b/i;

test('the security page sends reporters to security.txt (precondition)', () => {
  const t = text(readFileSync(join(src, 'pages', 'security.html'), 'utf8'));
  assert.match(t, /Security contacts are in \/\.well-known\/security\.txt/);
});

test('security.txt has a real contact, or the page says the contacts are not published yet', () => {
  const t = text(readFileSync(join(src, 'pages', 'security.html'), 'utf8'));
  const sentence = t.split(/(?<=[.!?])\s+/).find(s => /security\.txt/.test(s)) ?? '';
  if (notYet.test(sentence)) return;
  const txt = readFileSync(join(src, 'static', '.well-known', 'security.txt'), 'utf8');
  const placeholders = txt.match(/\{[A-Za-z]+\}/g) ?? [];
  const contacts = txt.split(/\r?\n/).filter(l => /^Contact:\s*/i.test(l)).map(l => l.replace(/^Contact:\s*/i, '').trim());
  assert.deepEqual(placeholders, [], `security.html says "${sentence.trim()}", but security.txt is a template (PREFLIGHT.md:35 unticked)`);
  assert.ok(contacts.some(c => /^(mailto:\S+@\S+|https:\/\/\S+|tel:\S+)$/.test(c)), 'RFC 9116: security.txt needs at least one Contact URI');
});
