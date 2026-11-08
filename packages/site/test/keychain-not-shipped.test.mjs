// Adversary site-finish r3. Intended home: packages/site/test/keychain-not-shipped.test.mjs
// Run from the repo root: node --test packages/site/test/keychain-not-shipped.test.mjs
// (or from anywhere: SITE_PKG=<repo>/packages/site node --test <this file>)
//
// The tutorial says `attessa init` "creates a wallet for this computer, keeps the key in your OS keychain", the reference says
// "key in the OS keychain", and the MCP how-to (new this round) tells the reader to "use the keychain ... rather than a key in the
// environment". The only keychain code is packages/sdk/src/keys.ts `systemKeychain()`, which dynamically imports the module
// `keytar`. No package.json in the repo depends on keytar and pnpm-lock.yaml has no keytar entry, so after the install steps the
// site gives (`pnpm install --frozen-lockfile && pnpm -r build`) the import fails and `attessa init` prints
// "No OS keychain is available, so no wallet was created." (verified on this branch). The MCP server has the same keychain path
// and the same gap. The prose states a keychain wallet as something the build does; it needs a qualifier (or keytar as a dependency).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = process.env.SITE_PKG ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const pages = join(pkg, 'src', 'pages');
const repo = join(pkg, '..', '..');
const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

// Is keytar something a reader following the site's install steps gets?
const manifests = ['package.json', ...readdirSync(join(repo, 'packages')).map(p => join('packages', p, 'package.json'))]
  .map(p => join(repo, p)).filter(existsSync);
const declared = manifests.some(m => /"keytar"\s*:/.test(readFileSync(m, 'utf8')));
const lock = readFileSync(join(repo, 'pnpm-lock.yaml'), 'utf8');
const inLockfile = /^\s+'?keytar@/m.test(lock) || /^\s+keytar:/m.test(lock);

const qualifier = /keytar|no keychain|not installed|isn't installed|optional|unavailable|not available|if your (system|computer|machine)|when (a|the) keychain/i;
const stripTags = s => s.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

test('prose that puts the wallet key in the OS keychain is qualified while keytar is not shipped', () => {
  if (declared || inLockfile) return; // keytar ships: the claim is backed
  const bad = [];
  for (const f of walk(pages).filter(f => f.endsWith('.html'))) {
    // <pre> blocks are the CLI's verbatim FLOWS output and are not judged here.
    const html = readFileSync(f, 'utf8').replace(/<pre\b[\s\S]*?<\/pre>/gi, ' ').replace(/<!--[\s\S]*?-->/g, '');
    for (const block of html.split(/<\/(?:p|li|td)>/i)) {
      const t = stripTags(block);
      for (const s of t.split(/(?<=\.)\s+/)) {
        if (/keychain/i.test(s) && !qualifier.test(s)) bad.push(`${f.slice(pages.length + 1)}: ${s}`);
      }
    }
  }
  assert.deepEqual(bad, [], `keytar is in no package.json or in pnpm-lock.yaml, so a clone built as the site says has no OS keychain, yet these sentences present it as available:\n${bad.join('\n')}`);
});
