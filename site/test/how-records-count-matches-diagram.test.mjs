// Adversary round 34 on the site (5ff468a..6109288, newest fix 6109288).
// Intended home: site/test/how-records-count-matches-diagram.test.mjs
// Run from the repo root: node --test site/test/how-records-count-matches-diagram.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// 6109288 renamed the how-it-works section "Three records on Celo" to "The records on Celo" and its lede
// from "checked against all three" to "all of them", because the diagram beside it draws four records:
// Agent, Approved release, Signer and Endpoint. FLOWS.md §2 Objects lists all four as on-chain objects
// (Agent = "an ERC-8004 identity ... ERC-721 token on the Identity Registry"; Release, Endpoint, Signer in
// the Attessa registry), and security.html lists the ERC-8004 identity registry on Celo. The page's own
// "On this page" index still links to that section as "Records on Celo" with the count "3 records".
// So the page still counts three records next to a four-record diagram.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const how = readFileSync(join(src, 'pages', 'how-it-works.html'), 'utf8');
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const num = s => (/^\d+$/.test(s) ? Number(s) : WORDS[s.toLowerCase()]);

test('the page index counts as many records as the records diagram draws', () => {
  const svg = how.match(/<svg class="d-wide"[\s\S]*?<\/svg>/)?.[0];
  assert.ok(svg, 'how-it-works.html no longer has the wide records diagram');
  const boxes = [...svg.matchAll(/<text class="d-title"[^>]*>([^<]+)<\/text>/g)].map(m => m[1]);
  assert.ok(boxes.length > 0, 'the records diagram names no records');

  const link = how.match(/<a href="#objects"[^>]*>([\s\S]*?)<\/a>/)?.[1];
  assert.ok(link, 'the page index no longer links to the records section');
  const count = link.match(/(\d+|one|two|three|four|five|six)\s+records?/i);
  if (!count) return; // no count stated, nothing to contradict
  assert.equal(num(count[1]), boxes.length,
    `the page index says "${count[0]}", but the diagram it links to draws ${boxes.length}: ${boxes.join(', ')}`);
});
