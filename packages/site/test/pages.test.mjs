// T39: a text snapshot of every page, so a copy change shows as a line diff that Joshua approves.
//   test/snapshots/text/<page>.txt   the text of each page (page-text.mjs)
// After an approved copy change: UPDATE_SNAPSHOTS=1 node --test test/pages.test.mjs, then review the diff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { pageText } from './page-text.mjs';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const snapshots = join(pkg, 'test', 'snapshots', 'text');
const update = process.env.UPDATE_SNAPSHOTS === '1';

/** @param {string} dir @returns {string[]} */
const walk = dir => readdirSync(dir).flatMap(name => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

// Build into a folder of its own so this test never races another test over dist/.
const out = mkdtempSync(join(tmpdir(), 'attessa-site-pages-'));
execFileSync(process.execPath, [join(pkg, 'build.mjs')], { cwd: pkg, stdio: 'pipe', env: { ...process.env, SITE_OUT: out } });
const pages = walk(out).map(p => relative(out, p).split(sep).join('/')).filter(p => p.endsWith('.html')).sort();

test('the build writes exactly the 12 pages', () => {
  assert.deepEqual(pages, [
    'docs/explanation.html', 'docs/how-to.html', 'docs/index.html', 'docs/reference.html', 'docs/tutorial.html',
    'explorer.html', 'how-it-works.html', 'index.html', 'privacy.html', 'security.html', 'terms.html', 'use-cases.html',
  ]);
});

for (const page of pages) {
  test(`text of ${page} matches its snapshot`, () => {
    const snap = join(snapshots, page.replace(/\.html$/, '.txt'));
    const text = pageText(readFileSync(join(out, page), 'utf8'));
    if (update) { mkdirSync(dirname(snap), { recursive: true }); writeFileSync(snap, text); }
    assert.ok(existsSync(snap), `${relative(pkg, snap)} is missing; record it with UPDATE_SNAPSHOTS=1`);
    assert.equal(text, readFileSync(snap, 'utf8'));
  });
}

test.after(() => rmSync(out, { recursive: true, force: true }));
