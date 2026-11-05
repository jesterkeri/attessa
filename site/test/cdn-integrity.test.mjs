// Codex site review r1 M2: every pinned third-party script and stylesheet the pages load carries Subresource
// Integrity and crossorigin, so a modified CDN response is refused instead of run. Google Fonts' CSS is the one
// exception: Google serves different CSS per browser, so it can't be pinned by hash (site/README.md: "where possible").
// The three.js module is covered by the import map's "integrity" entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const layout = readFileSync(join(site, 'src', 'layout.html'), 'utf8');
const html = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? html(join(d, f)) : f.endsWith('.html') ? [join(d, f)] : []));

test('every third-party <script src> and stylesheet in the layout has integrity and crossorigin, except Google Fonts', () => {
  const tags = [...layout.matchAll(/<(script|link)\b[^>]*\b(?:src|href)="(https:\/\/[^"]+)"[^>]*>/g)].filter(
    (m) => m[1] === 'script' || /rel="stylesheet"/.test(m[0]),
  );
  assert.ok(tags.length >= 3, `found ${tags.length} third-party tags`);
  for (const [tag, , url] of tags) {
    if (url.startsWith('https://fonts.googleapis.com/')) continue;
    assert.match(tag, /\bintegrity="sha(384|512)-[A-Za-z0-9+/]+={0,2}"/, `no integrity: ${url}`);
    assert.match(tag, /\bcrossorigin="anonymous"/, `no crossorigin: ${url}`);
  }
});

test('the import map pins every module URL it maps with an integrity entry', () => {
  const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(layout);
  assert.ok(m, 'no import map');
  const map = JSON.parse(m[1]);
  for (const url of Object.values(map.imports)) assert.match(map.integrity?.[url] ?? '', /^sha(384|512)-/, `no integrity for ${url}`);
});

test('no page outside the layout loads a third-party script or stylesheet of its own', () => {
  for (const f of html(join(site, 'src', 'pages'))) {
    const t = readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /<script\b[^>]*\bsrc="https:/, f);
    assert.doesNotMatch(t, /<link\b[^>]*rel="stylesheet"[^>]*href="https:/, f);
  }
});
