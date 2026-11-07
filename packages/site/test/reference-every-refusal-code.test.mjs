// Adversary round 29 on the site (5ff468a..b52abca). Intended home: packages/site/test/reference-every-refusal-code.test.mjs
// Run from the repo root: node --test packages/site/test/reference-every-refusal-code.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src; FLOWS.md is read from <SITE_SRC>/../../FLOWS.md)
//
// The docs landing card says the reference has "every refusal code". FLOWS §8 "Errors and refusals"
// marks its refusals with "R:", and each row names its machine code. Several of them have no row in
// the reference's refusal table: invalid_origin, invalid_pcr, release_exists and endpoint_inactive
// (refusals from `endpoint add`, `release approve` and `signer register`, commands the site says are
// built today), self_link_invalid, and renew's signer_mismatch / release_mismatch. A seller who
// meets one of them looks it up and finds nothing.
//
// Either fix passes: add the missing rows, or stop claiming "every refusal code".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const flows = readFileSync(join(src, '..', '..', '..', 'FLOWS.md'), 'utf8');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// FLOWS §8: every table row whose trigger starts with "R:"; the codes are the backticked names in the
// last column before the arrow to the suggestion.
function flowsRefusalCodes() {
  const sec = flows.slice(flows.indexOf('### Errors and refusals'), flows.indexOf('## 9. Heuristic review'));
  const codes = new Set();
  for (const line of sec.split('\n')) {
    if (!line.startsWith('| R:')) continue;
    const cells = line.split(/(?<!\\)\|/).map(c => c.trim()).filter(Boolean);
    const machine = cells[cells.length - 1].split('→')[0];
    for (const m of machine.matchAll(/`([a-z_]+)(?:\{[^`]*\})?`/g)) codes.add(m[1]);
  }
  return codes;
}

// The reference's refusal table: the codes named in each row's first cell.
function referenceRowCodes() {
  const ref = readFileSync(join(src, 'pages', 'docs', 'reference.html'), 'utf8');
  const section = ref.slice(ref.indexOf('id="refusals"'));
  const codes = new Set();
  for (const m of section.matchAll(/<tr><td>([\s\S]*?)<\/td>/g)) {
    for (const c of m[1].matchAll(/<code>([a-z_]+)<\/code>/g)) codes.add(c[1]);
  }
  return codes;
}

test('FLOWS §8 refusal codes parse (precondition)', () => {
  const codes = flowsRefusalCodes();
  for (const c of ['payto_mismatch', 'proof_rejected', 'endpoint_inactive', 'invalid_origin', 'release_exists']) {
    assert.ok(codes.has(c), `FLOWS §8 parse lost ${c}`);
  }
});

test('if the docs say the reference has every refusal code, every FLOWS §8 refusal has a row', () => {
  const landing = text(readFileSync(join(src, 'pages', 'docs', 'index.html'), 'utf8'));
  if (!/\bevery refusal code\b/i.test(landing)) return;
  const rows = referenceRowCodes();
  const missing = [...flowsRefusalCodes()].filter(c => !rows.has(c));
  assert.deepEqual(missing, [], `docs/index.html says the reference lists "every refusal code", but its refusal table has no row for these FLOWS §8 refusals: ${missing.join(', ')}`);
});
