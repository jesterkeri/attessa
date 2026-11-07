// Adversary round 32 on the site (5ff468a..3479e1c, newest fix 3479e1c).
// Intended home: packages/site/test/celo-mainnet-already-live.test.mjs
// Run from the repo root: node --test packages/site/test/celo-mainnet-already-live.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// privacy.html says "Until Celo mainnet launches, Celo Sepolia is the only choice." and terms.html says
// "Once Celo mainnet launches, use --network mainnet ...". Both say Celo's own mainnet has not launched.
// The project's own records say it is live: SPEC.md:137 pins Celo mainnet (chain 42220) with its USDC
// and USA₮ contracts; TASKS.md T19a is ticked and DONE.md:699-700 records "https://forno.celo.org -400 ok"
// and "-7200 ok"; KNOWN-LIMITS L23 records mainnet Forno serving >= 200,000 blocks of state. What has not
// launched is Attessa on mainnet (AGENTS.md: "Celo Sepolia (11142220) until Gate 5"; TASKS T30 "Mainnet
// deploy" unticked). Either fix passes: say Attessa's mainnet launch is pending ("after launch", "once
// Attessa launches on Celo mainnet"), or drop the clause.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

function htmlFiles(dir) {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? htmlFiles(p) : p.endsWith('.html') ? [p] : [];
  });
}

// "Celo mainnet launches", "Celo mainnet has not launched", "Celo mainnet isn't live", "Celo mainnet goes live".
const celoNotLaunched = /\bCelo mainnet (launches|has(n't| not) launched|is(n't| not) (live|launched)|goes live)\b/i;

test('the spec records Celo mainnet as a live network (precondition)', () => {
  const spec = readFileSync(join(src, '..', '..', '..', 'SPEC.md'), 'utf8');
  assert.match(spec, /\| `celo` \| `--network mainnet` \| 42220 \|/);
});

test('no page says Celo mainnet itself has not launched yet', () => {
  const hits = [];
  for (const f of htmlFiles(src)) {
    const sentences = text(readFileSync(f, 'utf8')).split(/(?<=[.!?])\s+/);
    for (const s of sentences) if (celoNotLaunched.test(s)) hits.push(`${relative(src, f)}: "${s.trim()}"`);
  }
  assert.deepEqual(hits, [], 'Celo mainnet (42220) is live per SPEC.md:137 and DONE.md:699-700; only Attessa on mainnet is pending (Gate 5)');
});
