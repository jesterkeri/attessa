// T40: the pages load nothing from a third-party origin. This replaces the old SRI test (cdn-integrity), whose
// premise (pinned CDN tags) is gone: three, gsap, the Phosphor icons and the fonts are now served from the site.
//   - no built file names a font, script or icon CDN;
//   - no <script src>, <link href>, <img src> or CSS url()/@import points at another origin;
//   - every page carries a CSP <meta> whose script-src lists the sha256 of each inline script, and no 'unsafe-inline' for scripts;
//   - the fonts match assets/fonts/SHA256SUMS;
//   - the build writes CNAME (attessa.xyz) and an empty .nojekyll for GitHub Pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(join(tmpdir(), 'attessa-site-origins-'));
execFileSync(process.execPath, [join(pkg, 'build.mjs')], { cwd: pkg, stdio: 'pipe', env: { ...process.env, SITE_OUT: out } });
test.after(() => rmSync(out, { recursive: true, force: true }));

const walk = d => readdirSync(d).flatMap(n => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const files = walk(out);
const rel = f => relative(out, f).split(sep).join('/');
const pages = files.filter(f => f.endsWith('.html'));
const sha = b => createHash('sha256').update(b).digest('hex');
const CDNS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'unpkg.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];

test('no third-party origins: no built file names a font, script or icon CDN', () => {
  for (const f of files.filter(f => /\.(html|css|js|txt|svg)$/.test(f) || f.endsWith('security.txt'))) {
    const t = readFileSync(f, 'utf8');
    for (const host of CDNS) assert.ok(!t.includes(host), `${rel(f)} mentions ${host}`);
  }
});

test('no third-party origins: no resource tag or CSS reference points at another origin', () => {
  for (const f of pages) {
    const t = readFileSync(f, 'utf8');
    for (const m of t.matchAll(/<(script|link|img|iframe|source|video|audio)\b[^>]*>/gi)) {
      const ref = /\b(?:src|href)="([^"]*)"/.exec(m[0])?.[1];
      if (ref === undefined) continue;
      assert.doesNotMatch(ref, /^(?:[a-z][a-z0-9+.-]*:)?\/\//i, `${rel(f)}: ${m[0]}`);
    }
  }
  for (const f of files.filter(f => f.endsWith('.css'))) {
    const t = readFileSync(f, 'utf8');
    for (const m of t.matchAll(/url\(\s*['"]?([^)'"]+)/g)) assert.doesNotMatch(m[1], /^(?:https?:)?\/\//, `${rel(f)}: url(${m[1]})`);
    assert.doesNotMatch(t, /@import\s+(?:url\()?['"]?(?:https?:)?\/\//, rel(f));
  }
});

test('no third-party origins: every page has a CSP meta whose script hashes cover its inline scripts', () => {
  for (const f of pages) {
    const t = readFileSync(f, 'utf8');
    const metas = [...t.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g)];
    assert.equal(metas.length, 1, `${rel(f)}: one CSP meta`);
    const policy = metas[0][1];
    const scriptSrc = policy.split(';').map(s => s.trim()).find(s => s.startsWith('script-src ')) ?? '';
    assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval|https?:/, `${rel(f)}: ${scriptSrc}`);
    assert.doesNotMatch(policy, /frame-ancestors|report-uri|report-to/, `${rel(f)}: ignored in a meta policy, so not listed`);
    assert.match(policy, /default-src 'none'/);
    const inline = [...t.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(m => !/\bsrc=/.test(m[1]));
    assert.ok(inline.length >= 2, `${rel(f)}: found the layout's inline scripts`);
    for (const m of inline) {
      const h = `'sha256-${createHash('sha256').update(m[2], 'utf8').digest('base64')}'`;
      assert.ok(scriptSrc.includes(h), `${rel(f)}: inline script ${h} is not in the CSP`);
    }
    assert.doesNotMatch(t, /<script\b[^>]*\btype="importmap"/, `${rel(f)}: no import map`);
    assert.doesNotMatch(t, /\son[a-z]+="/i, `${rel(f)}: inline event handler`);
  }
});

test('no third-party origins: the vendored fonts match their sha256 manifest', () => {
  const dir = join(out, 'assets', 'fonts');
  const lines = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 6);
  for (const line of lines) {
    const [hash, name] = line.split(/\s+/);
    assert.equal(sha(readFileSync(join(dir, name))), hash, name);
  }
  const woff2 = readdirSync(dir).filter(n => n.endsWith('.woff2')).sort();
  assert.deepEqual(woff2, lines.map(l => l.split(/\s+/)[1]).sort());
  const css = readFileSync(join(out, 'assets', 'fonts.css'), 'utf8');
  for (const m of css.matchAll(/url\(([^)]+)\)/g)) assert.ok(existsSync(join(out, 'assets', m[1])), m[1]);
});

test('GitHub Pages: the build writes CNAME with attessa.xyz and an empty .nojekyll', () => {
  assert.equal(readFileSync(join(out, 'CNAME'), 'utf8').trim(), 'attessa.xyz');
  assert.equal(readFileSync(join(out, 'CNAME'), 'utf8'), 'attessa.xyz\n');
  assert.equal(statSync(join(out, '.nojekyll')).size, 0);
});

test('the bundles carry gsap and three, and the old globals are set', () => {
  const motion = readFileSync(join(out, 'assets', 'motion.js'), 'utf8');
  assert.match(motion, /ScrollTrigger/);
  assert.match(motion, /window\.gsap|\.gsap=/);
  const scene = readFileSync(join(out, 'assets', 'scene.js'), 'utf8');
  assert.doesNotMatch(scene, /from\s*["']three["']|import\(["']three/, 'three is bundled, not imported');
  assert.ok(scene.length > 200_000, `scene.js is ${scene.length} bytes`);
});
