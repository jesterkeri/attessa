// Adversary site-finish r2. Intended home: packages/site/test/reference-status-recent-verdicts.test.mjs
// Run from the repo root: node --test packages/site/test/reference-status-recent-verdicts.test.mjs
// (or from anywhere: SITE_PKG=<repo>/packages/site node --test <this file>)
//
// docs/reference.html lists `attessa status` among "These commands are built: they are in packages/cli" and says it shows
// "Spend today against your cap, pending permissions, recent verdicts". The CLI's status (packages/cli/src/commands/buyer.ts,
// `status` and `spendLines`) prints spend today, the decided pending calls, or a registry/liveness line for an origin. It never
// lists recent verdicts, and explorer.html says so itself: "attessa status shows your recent verdicts (Coming)".
// The two pages disagree; the reference states as built something the code does not do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = process.env.SITE_PKG ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const pages = join(pkg, 'src', 'pages');
const cliSrc = join(pkg, '..', 'cli', 'src');
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const marked = /\b(coming|planned|not built|isn't built|not yet built)\b/i;
const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

// Code that prints a verdict list: a non-comment line in the CLI that names recent verdicts.
const cliPrintsVerdicts = walk(cliSrc).filter(f => f.endsWith('.ts'))
  .some(f => readFileSync(f, 'utf8').split('\n').some(l => !/^\s*(\/\/|\*|\/\*)/.test(l) && /verdicts?\b/i.test(l)));

test('a built-CLI row that promises recent verdicts is backed by the CLI, or marked Coming', () => {
  const ref = readFileSync(join(pages, 'docs', 'reference.html'), 'utf8');
  const row = ref.split('\n').find(l => l.includes('<code>attessa status</code>'));
  assert.ok(row, 'the reference lost its attessa status row');
  const t = text(row);
  if (/recent verdicts/i.test(t) && !marked.test(t)) {
    assert.ok(cliPrintsVerdicts, `reference.html lists attessa status as built and says it shows recent verdicts: "${t}", but packages/cli prints no verdicts`);
  }
});

test('two pages do not disagree about whether attessa status shows recent verdicts', () => {
  const claims = walk(pages).filter(f => f.endsWith('.html')).flatMap(f => readFileSync(f, 'utf8').split('\n')
    .filter(l => /attessa status/.test(l) && /recent verdicts/i.test(l))
    .map(l => ({ f: f.slice(pages.length + 1), built: !marked.test(text(l)) })));
  assert.ok(claims.length >= 2, 'the pages no longer both mention it');
  assert.equal(new Set(claims.map(c => c.built)).size, 1, `pages disagree: ${JSON.stringify(claims)}`);
});
