// T47: scene performance rules and the accessibility fixes from the PR #8 review, checked in the source.
// The measured side (0 scene frames over 2 s idle, 0 rAF under reduced motion) is scripts/perf-probe.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...p) => readFileSync(join(src, ...p), 'utf8');
const scene = read('static', 'assets', 'scene.js'), site = read('static', 'assets', 'site.js'), explorerJs = read('static', 'assets', 'explorer.js');
const css = read('static', 'assets', 'site.css'), motion = read('static', 'assets', 'motion.js');
const walk = d => readdirSync(d).flatMap(n => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

test('scene: the loop stops when idle and starts again on activity', () => {
  assert.match(scene, /const idle = !SETTLE && now - startAt > 2400 && now - lastActive > IDLE_MS;/);
  assert.match(scene, /else running = false;/);
  assert.match(scene, /for \(const type of \['scroll', 'resize', 'pointermove', 'pointerdown', 'keydown', 'focusin', 'load'\]\) addEventListener\(type, wake/);
  assert.match(scene, /document\.addEventListener\('visibilitychange', wake\)/);
  assert.match(scene, /!idle && !document\.hidden/);
});

test('scene: pixel ratio 1 on coarse pointers, particle tiers, Data Saver turns it off', () => {
  assert.match(scene, /renderer\.setPixelRatio\(coarse \? 1 : Math\.min\(devicePixelRatio, 1\.75\)\)/);
  assert.match(scene, /const perCube = lowEnd \? 500 : small \? 800 : 1800;/);
  assert.match(scene, /navigator\.connection\?\.saveData === true/);
  assert.match(scene, /if \(!canvas \|\| saveData\) return false;/);
});

test('scene: reduced motion registers no ScrollTrigger and starts no animation loop', () => {
  assert.match(motion, /if \(reduce \|\| !window\.gsap \|\| !window\.ScrollTrigger\) \{ done\(\); return; \}\n  gsap\.registerPlugin\(ScrollTrigger\);/);
  assert.match(scene, /if \(reduce\) \{\n  const kick = /);
});

test('menu: Tab and Shift+Tab stay inside the open menu', () => {
  assert.match(site, /e\.key === 'Tab' && root\.classList\.contains\('menu-open'\)/);
  assert.match(site, /const ring = \[menuBtn, \.\.\.\$\$\('a\[href\], button:not\(\[disabled\]\)', menu\)\]/);
  assert.match(site, /\$\$\('\.skip, main, footer'\)\.forEach\(el => \{ el\.inert = open; \}\)/);
});

test('one live announcement: only the global announcer is a live region', () => {
  for (const f of walk(src).filter(f => f.endsWith('.html'))) {
    const n = (readFileSync(f, 'utf8').match(/aria-live=/g) ?? []).length;
    assert.equal(n, f.endsWith('layout.html') ? 1 : 0, f);
  }
  assert.doesNotMatch(explorerJs + site, /aria-live|role', 'status'|role="status"|role="alert"/);
});

test('the explorer search field draws a visible focus ring', () => {
  assert.match(css, /\.recheck:focus-within \{ border-bottom-color: var\(--text\); outline: 1\.5px solid var\(--text\); outline-offset: 3px; \}/);
});

test('a hash button is named by its visible text, not by a longer label', () => {
  assert.doesNotMatch(site + explorerJs + readFileSync(join(src, '..', 'build.mjs'), 'utf8'), /Show full value/);
  assert.match(site, /class="hash-val" data-full="\$\{full\}" aria-expanded="false">/);
});
