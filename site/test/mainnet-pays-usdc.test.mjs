// Adversary round 33 on the site (5ff468a..d6b4a48, newest fix d6b4a48).
// Intended home: site/test/mainnet-pays-usdc.test.mjs
// Run from the repo root: node --test site/test/mainnet-pays-usdc.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// index.html's "Built on" line says "It pays in USDC on Celo Sepolia, and will pay in USA₮ on mainnet
// after launch." That ties USDC to Celo Sepolia and gives mainnet only USA₮. The spec says otherwise:
// SPEC.md:27 FR-8 "quotes in USDC (both networks) and USA₮ (mainnet)"; SPEC.md:137 pins mainnet USDC
// 0xceba...118c; SPEC.md:784 "G5 closes on USDC, the USA₮ call (T32b) may land by Nov 6"; SPEC.md:828
// never cuts "USDC on mainnet". Mainnet's primary asset is USDC; USA₮ is the extra one.
// Either fix passes: say USDC on both networks (and USA₮ too on mainnet), or stop tying USDC to Sepolia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&#x20AE;/gi, '₮').replace(/\s+/g, ' ');

function htmlFiles(dir) {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? htmlFiles(p) : p.endsWith('.html') ? [p] : [];
  });
}

test('the spec quotes USDC on both networks and pins a mainnet USDC (precondition)', () => {
  const spec = readFileSync(join(src, '..', '..', 'SPEC.md'), 'utf8');
  assert.match(spec, /quotes in USDC \(both networks\) and USA₮ \(mainnet\)/);
  assert.match(spec, /\| `celo` \| `--network mainnet` \| 42220 \|[^\n]*USDC `0xceba9300f2b948710d2653dd7b07f33a8b32118c`/);
});

test('no sentence gives mainnet USA₮ while confining USDC to Celo Sepolia', () => {
  const usdcSepoliaOnly = /\bUSDC on Celo Sepolia\b/i;
  const usatMainnet = /USA₮ on (Celo )?mainnet/i;
  // USDC named for mainnet itself: "USDC on both networks", "USDC or USA₮ on mainnet", "mainnet ... USDC".
  const usdcMainnet = /USDC (on|across) (both|either) networks?|USDC (and|or) USA₮ on (Celo )?mainnet|USDC on (Celo )?mainnet|mainnet[^.]*\bUSDC\b/i;
  const hits = [];
  for (const f of htmlFiles(src)) {
    for (const s of text(readFileSync(f, 'utf8')).split(/(?<=[.!?])\s+/)) {
      if (usdcSepoliaOnly.test(s) && usatMainnet.test(s) && !usdcMainnet.test(s)) hits.push(`${relative(src, f)}: "${s.trim()}"`);
    }
  }
  assert.deepEqual(hits, [], 'SPEC.md:27 FR-8: USDC on both networks, USA₮ on mainnet; mainnet must not read as USA₮ only');
});
